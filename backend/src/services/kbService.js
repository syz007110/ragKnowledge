const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { Op } = require('sequelize');
const axios = require('axios');
const { kbIngestQueue, kbPurgeQueue } = require('../config/queue');
const kbStorage = require('../config/kbStorage');
const { publishKbTaskStatus } = require('./wsEventPublisher');
const {
  isS3Uri,
  deleteObjectByUri,
  buildStorageConfig,
  buildUploadObjectKey,
  uploadBuffer
} = require('./objectStorageService');
const { createHybridRetrievalService } = require('./retrievalService');
const { createEsLexicalProvider } = require('./lexicalProvider/esLexicalProvider');
const { createQdrantVectorProvider } = require('./vectorProvider/qdrantProvider');
const { createEmbeddingService } = require('./embeddingService');
const { countIndexedStates } = require('./indexStateService');
const {
  sequelize,
  KbCollection,
  KbFile,
  KbFileLineage,
  KbChunk,
  KbAsset,
  KbChunkAsset,
  KbChunkIndexState,
  KbJob,
  KbTag,
  KbTagAlias,
  KbCollectionTag
} = require('../models');

const SUPPORTED_EXTS = ['md', 'txt', 'docx', 'xlsx', 'pdf'];
const MAX_COLLECTION_TAGS = 5;
const MAX_TAG_LENGTH = 10;
const RECYCLE_RETENTION_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const PUNCTUATION_MAP = {
  '，': ',',
  '。': '.',
  '！': '!',
  '？': '?',
  '：': ':',
  '；': ';',
  '（': '(',
  '）': ')',
  '【': '[',
  '】': ']',
  '《': '<',
  '》': '>',
  '、': ',',
  '“': '"',
  '”': '"',
  '‘': "'",
  '’': "'",
  '—': '-',
  '－': '-',
  '～': '~'
};

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function tokenizeText(value = '') {
  const raw = String(value || '').toLowerCase();
  const terms = raw.match(/[\p{L}\p{N}_-]+/gu) || [];
  return terms.filter(Boolean);
}

function safeJsonString(value) {
  try {
    return JSON.stringify(value || {});
  } catch (_) {
    return '{}';
  }
}

function logKbVector(level, event, payload = {}) {
  const method = typeof console[level] === 'function' ? level : 'log';
  console[method](`[KB向量] ${event} ${safeJsonString(payload)}`);
}

function getOperatorId(user) {
  return user?.id || user?.userId || null;
}

function getRecycleCutoffDate(now = new Date()) {
  return new Date(now.getTime() - RECYCLE_RETENTION_DAYS * MS_PER_DAY);
}

function withinRecycleWindow(date, now = new Date()) {
  if (!date) return false;
  return new Date(date).getTime() >= getRecycleCutoffDate(now).getTime();
}

function normalizeFileExt(name, ext) {
  const source = (ext || name || '').toLowerCase();
  if (source.endsWith('.md') || source === 'md') return 'md';
  if (source.endsWith('.txt') || source === 'txt') return 'txt';
  if (source.endsWith('.docx') || source === 'docx') return 'docx';
  if (source.endsWith('.xlsx') || source === 'xlsx') return 'xlsx';
  if (source.endsWith('.pdf') || source === 'pdf') return 'pdf';
  return source.replace(/^\./, '');
}

function normalizeTag(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const halfWidth = raw.normalize('NFKC');
  const unifiedPunctuation = Array.from(halfWidth)
    .map((char) => PUNCTUATION_MAP[char] || char)
    .join('');
  return unifiedPunctuation
    .replace(/\s+/g, '')
    .toLowerCase();
}

function normalizeCollectionTags(tags) {
  if (!Array.isArray(tags)) return [];
  const unique = [];
  const seen = new Set();
  tags.forEach((item) => {
    const normalized = normalizeTag(item);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    unique.push(normalized);
  });
  return unique;
}

function validateCollectionTags(tags) {
  if (!Array.isArray(tags)) return { valid: true };
  const normalizedTags = normalizeCollectionTags(tags);
  if (normalizedTags.length > MAX_COLLECTION_TAGS) {
    return {
      valid: false,
      reasonKey: 'kb.tagCountExceeded'
    };
  }
  const tooLong = normalizedTags.find((tag) => tag.length > MAX_TAG_LENGTH);
  if (tooLong) {
    return {
      valid: false,
      reasonKey: 'kb.tagLengthExceeded'
    };
  }
  return { valid: true, normalizedTags };
}

async function attachTagsToCollection(collectionId, tags, operatorId, transaction) {
  await KbCollectionTag.destroy({
    where: { collectionId },
    transaction
  });
  if (!tags.length) return;

  for (const tagValue of tags) {
    const existingStandard = await KbTag.findOne({
      where: {
        normName: tagValue,
        isDeleted: 0,
        status: 1
      },
      transaction
    });
    if (existingStandard) {
      await KbCollectionTag.create({
        collectionId,
        tagId: existingStandard.id,
        createdBy: operatorId
      }, { transaction });
      continue;
    }

    let alias = await KbTagAlias.findOne({
      where: {
        normName: tagValue
      },
      transaction
    });
    if (!alias) {
      alias = await KbTagAlias.create({
        aliasName: tagValue,
        normName: tagValue,
        status: 'pending',
        createdBy: operatorId
      }, { transaction });
    }
    await KbCollectionTag.create({
      collectionId,
      aliasId: alias.id,
      createdBy: operatorId
    }, { transaction });
  }
}

async function getCollectionTagMap(collectionIds) {
  if (!collectionIds.length) return new Map();
  const rows = await KbCollectionTag.findAll({
    where: {
      collectionId: {
        [Op.in]: collectionIds
      }
    },
    include: [
      {
        model: KbTag,
        as: 'tag',
        required: false
      },
      {
        model: KbTagAlias,
        as: 'alias',
        required: false
      }
    ],
    order: [['id', 'ASC']]
  });

  const map = new Map();
  rows.forEach((row) => {
    const collectionId = row.collectionId;
    if (!map.has(collectionId)) map.set(collectionId, []);
    if (row.tag) {
      map.get(collectionId).push({
        id: row.tag.id,
        name: row.tag.tagName,
        source: 'standard'
      });
      return;
    }
    if (row.alias) {
      map.get(collectionId).push({
        id: row.alias.id,
        name: row.alias.aliasName,
        source: 'alias',
        status: row.alias.status
      });
    }
  });
  return map;
}

function splitPlainTextToChunks(text, maxChunkSize = 800) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (!paragraphs.length) return [];

  const chunks = [];
  let buffer = '';
  let start = 0;

  paragraphs.forEach((part) => {
    if (!buffer) {
      buffer = part;
      return;
    }
    if ((buffer.length + 2 + part.length) <= maxChunkSize) {
      buffer += `\n\n${part}`;
      return;
    }
    chunks.push({
      text: buffer,
      startOffset: start,
      endOffset: start + buffer.length
    });
    start += buffer.length;
    buffer = part;
  });

  if (buffer) {
    chunks.push({
      text: buffer,
      startOffset: start,
      endOffset: start + buffer.length
    });
  }

  return chunks;
}

function splitLongParagraph(text, maxChunkSize) {
  const value = String(text || '').trim();
  if (!value) return [];
  if (value.length <= maxChunkSize) return [value];

  const sentenceParts = value
    .split(/(?<=[。！？；.!?;])(?=\S)/u)
    .map((item) => item.trim())
    .filter(Boolean);

  if (!sentenceParts.length) {
    const pieces = [];
    for (let index = 0; index < value.length; index += maxChunkSize) {
      pieces.push(value.slice(index, index + maxChunkSize));
    }
    return pieces;
  }

  const chunks = [];
  let buffer = '';
  sentenceParts.forEach((part) => {
    if (!buffer) {
      buffer = part;
      return;
    }
    if ((buffer.length + part.length) <= maxChunkSize) {
      buffer += part;
      return;
    }
    chunks.push(buffer);
    buffer = part;
  });
  if (buffer) chunks.push(buffer);
  return chunks;
}

function parseMarkdownHeading(paragraph) {
  const line = String(paragraph || '').trim();
  if (!line) return null;

  const markdownMatch = line.match(/^(#{1,6})\s+(.+)$/);
  if (markdownMatch) {
    return {
      level: markdownMatch[1].length,
      label: `${markdownMatch[1]} ${markdownMatch[2].trim()}`
    };
  }

  const numericMatch = line.match(/^(\d+(?:\.\d+){0,5})[.、]?\s+(.+)$/);
  if (numericMatch) {
    const order = numericMatch[1];
    return {
      level: Math.max(1, order.split('.').length),
      label: `${order} ${numericMatch[2].trim()}`
    };
  }

  const chapterMatch = line.match(/^(第[一二三四五六七八九十百千万零〇0-9]+[章节篇部])\s*(.*)$/);
  if (chapterMatch) {
    return {
      level: 1,
      label: `${chapterMatch[1]} ${String(chapterMatch[2] || '').trim()}`.trim()
    };
  }

  const chineseMatch = line.match(/^([一二三四五六七八九十百千万零〇]+)[、.．]\s*(.+)$/);
  if (chineseMatch) {
    return {
      level: 1,
      label: `${chineseMatch[1]}、${chineseMatch[2].trim()}`
    };
  }

  const nestedChineseMatch = line.match(/^[（(]([一二三四五六七八九十百千万零〇0-9]+)[)）]\s*(.+)$/);
  if (nestedChineseMatch) {
    return {
      level: 2,
      label: `(${nestedChineseMatch[1]}) ${nestedChineseMatch[2].trim()}`
    };
  }

  return null;
}

function updateHeadingPath(stack, heading) {
  const safeLevel = Math.max(1, Number(heading.level) || 1);
  while (stack.length >= safeLevel) {
    stack.pop();
  }
  stack.push(heading.label);
  return [...stack];
}

function splitMarkdownToChunks(text, maxChunkSize = 800) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (!paragraphs.length) return [];

  const headingStack = [];
  const atomicUnits = [];
  let pendingHeadingUnit = null;

  paragraphs.forEach((paragraph) => {
    const heading = parseMarkdownHeading(paragraph);
    if (heading) {
      if (pendingHeadingUnit) {
        atomicUnits.push(pendingHeadingUnit);
      }
      pendingHeadingUnit = {
        parts: [paragraph],
        headingPath: updateHeadingPath(headingStack, heading)
      };
      return;
    }

    if (pendingHeadingUnit) {
      pendingHeadingUnit.parts.push(paragraph);
      atomicUnits.push(pendingHeadingUnit);
      pendingHeadingUnit = null;
      return;
    }

    atomicUnits.push({
      parts: [paragraph],
      headingPath: [...headingStack]
    });
  });

  if (pendingHeadingUnit) {
    atomicUnits.push(pendingHeadingUnit);
  }

  // Split only when a single non-heading paragraph itself is too long.
  const atomicSegments = [];
  atomicUnits.forEach((unit) => {
    const joined = unit.parts.join('\n\n');
    if (joined.length <= maxChunkSize) {
      atomicSegments.push({
        text: joined,
        headingPath: unit.headingPath
      });
      return;
    }

    if (unit.parts.length === 1) {
      splitLongParagraph(unit.parts[0], maxChunkSize).forEach((piece) => {
        atomicSegments.push({
          text: piece,
          headingPath: unit.headingPath
        });
      });
      return;
    }

    // Keep heading + first body paragraph bound even if oversized.
    atomicSegments.push({
      text: joined,
      headingPath: unit.headingPath
    });
  });

  const merged = [];
  atomicSegments.forEach((segment) => {
    if (!merged.length) {
      merged.push({
        text: segment.text,
        headingPath: segment.headingPath
      });
      return;
    }

    const prev = merged[merged.length - 1];
    const prevPathKey = JSON.stringify(prev.headingPath || []);
    const currentPathKey = JSON.stringify(segment.headingPath || []);
    const canMerge =
      prevPathKey === currentPathKey &&
      (prev.text.length + 2 + segment.text.length) <= maxChunkSize;

    if (!canMerge) {
      merged.push({
        text: segment.text,
        headingPath: segment.headingPath
      });
      return;
    }

    prev.text = `${prev.text}\n\n${segment.text}`;
  });

  const chunks = [];
  let start = 0;
  merged.forEach((item) => {
    chunks.push({
      text: item.text,
      headingPath: item.headingPath || [],
      startOffset: start,
      endOffset: start + item.text.length
    });
    start += item.text.length;
  });

  return chunks;
}

function splitTextToChunks(text, { fileExt = '', maxChunkSize = 800 } = {}) {
  const ext = String(fileExt || '').toLowerCase();
  if (ext === 'md') {
    return splitMarkdownToChunks(text, maxChunkSize);
  }
  return splitPlainTextToChunks(text, maxChunkSize);
}

function splitStructuredBlocksToChunks(blocks = [], maxChunkSize = 800) {
  const safeBlocks = Array.isArray(blocks) ? blocks : [];
  const headingStack = [];
  const atomicSegments = [];
  let pendingImages = [];

  const attachImagesToPrevious = () => {
    if (!pendingImages.length || !atomicSegments.length) return;
    const prev = atomicSegments[atomicSegments.length - 1];
    prev.assetKeys = [...(prev.assetKeys || []), ...pendingImages];
    pendingImages = [];
  };

  safeBlocks.forEach((block) => {
    if (!block) return;
    if (block.type === 'image' && block.imageKey) {
      pendingImages.push(String(block.imageKey));
      return;
    }
    if (block.type === 'table_row') {
      const rowText = String(block.rowKvText || block.text || '').trim();
      if (!rowText) return;
      atomicSegments.push({
        text: rowText,
        headingPath: [...headingStack],
        assetKeys: pendingImages,
        chunkType: 'table_row',
        rowKvText: rowText,
        sheetName: String(block.sheetName || '').trim(),
        tableId: String(block.tableId || '').trim(),
        rowIndex: Number(block.rowIndex || 0)
      });
      pendingImages = [];
      return;
    }
    if (block.type === 'table_summary') {
      const summaryText = String(block.text || '').trim();
      if (!summaryText) return;
      atomicSegments.push({
        text: summaryText,
        headingPath: [...headingStack],
        assetKeys: pendingImages,
        chunkType: 'table_summary',
        rowKvText: '',
        sheetName: String(block.sheetName || '').trim(),
        tableId: String(block.tableId || '').trim(),
        rowIndex: 0
      });
      pendingImages = [];
      return;
    }
    const text = String(block.text || '').trim();
    if (!text) return;
    let currentHeadingPath = [...headingStack];
    if (block.type === 'heading') {
      const level = Math.max(1, Number(block.level) || 1);
      while (headingStack.length >= level) headingStack.pop();
      headingStack.push(text);
      currentHeadingPath = [...headingStack];
    }
    atomicSegments.push({
      text,
      headingPath: currentHeadingPath,
      assetKeys: pendingImages,
      chunkType: block.type === 'heading' ? 'heading' : 'paragraph',
      rowKvText: '',
      sheetName: '',
      tableId: '',
      rowIndex: 0
    });
    pendingImages = [];
  });
  attachImagesToPrevious();

  const expanded = [];
  atomicSegments.forEach((segment) => {
    if (segment.text.length <= maxChunkSize) {
      expanded.push(segment);
      return;
    }
    const pieces = splitLongParagraph(segment.text, maxChunkSize);
    pieces.forEach((piece, idx) => {
      expanded.push({
        text: piece,
        headingPath: segment.headingPath,
        assetKeys: idx === 0 ? segment.assetKeys : [],
        chunkType: segment.chunkType || 'paragraph',
        rowKvText: idx === 0 ? (segment.rowKvText || '') : '',
        sheetName: segment.sheetName || '',
        tableId: segment.tableId || '',
        rowIndex: segment.rowIndex || 0
      });
    });
  });

  const merged = [];
  expanded.forEach((segment) => {
    if (!merged.length) {
      merged.push({
        text: segment.text,
        headingPath: segment.headingPath,
        assetKeys: [...(segment.assetKeys || [])],
        chunkType: segment.chunkType || 'paragraph',
        rowKvText: segment.rowKvText || '',
        sheetName: segment.sheetName || '',
        tableId: segment.tableId || '',
        rowIndex: segment.rowIndex || 0
      });
      return;
    }
    const prev = merged[merged.length - 1];
    const canMerge =
      safeJsonString(prev.headingPath) === safeJsonString(segment.headingPath) &&
      String(prev.chunkType || '') === String(segment.chunkType || '') &&
      String(segment.chunkType || '') !== 'table_row' &&
      (prev.text.length + 2 + segment.text.length) <= maxChunkSize;
    if (!canMerge) {
      merged.push({
        text: segment.text,
        headingPath: segment.headingPath,
        assetKeys: [...(segment.assetKeys || [])],
        chunkType: segment.chunkType || 'paragraph',
        rowKvText: segment.rowKvText || '',
        sheetName: segment.sheetName || '',
        tableId: segment.tableId || '',
        rowIndex: segment.rowIndex || 0
      });
      return;
    }
    prev.text = `${prev.text}\n\n${segment.text}`;
    prev.assetKeys = Array.from(new Set([...(prev.assetKeys || []), ...(segment.assetKeys || [])]));
    if (!prev.rowKvText && segment.rowKvText) {
      prev.rowKvText = segment.rowKvText;
    }
  });

  const chunks = [];
  let start = 0;
  merged.forEach((item) => {
    chunks.push({
      text: item.text,
      headingPath: item.headingPath || [],
      assetKeys: item.assetKeys || [],
      chunkType: item.chunkType || 'paragraph',
      rowKvText: item.rowKvText || '',
      sheetName: item.sheetName || '',
      tableId: item.tableId || '',
      rowIndex: item.rowIndex || 0,
      startOffset: start,
      endOffset: start + item.text.length
    });
    start += item.text.length;
  });
  return chunks;
}

function cleanTextByType(rawText, fileExt) {
  const normalized = String(rawText || '')
    .replace(/\r\n/g, '\n')
    .replace(/\f/g, '\n')
    .replace(/\u0000/g, '');
  const cleanedLines = normalized
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  if (fileExt === 'md') {
    return cleanedLines
      .replace(/^---\n[\s\S]*?\n---\n?/u, '')
      .replace(/^(#{1,6})([^\s#])/gm, '$1 $2')
      .trim();
  }
  if (fileExt === 'xlsx') {
    return cleanedLines.trim();
  }
  if (fileExt === 'pdf') {
    return cleanedLines
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n([a-zA-Z])(?=[a-zA-Z]{2,})/g, ' $1')
      .replace(/^\s*(第?\s*\d+\s*页|page\s*\d+)\s*$/gim, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  if (fileExt !== 'txt') {
    return cleanedLines.trim();
  }
  return cleanedLines.trim();
}

function buildEsConfig() {
  const enabled = String(process.env.ENABLE_ES_SYNC || 'true').toLowerCase() === 'true';
  return {
    enabled,
    baseUrl: String(process.env.ES_BASE_URL || '').trim().replace(/\/+$/, ''),
    indexName: String(process.env.ES_INDEX_NAME || 'kb_chunks').trim(),
    username: String(process.env.ES_USERNAME || '').trim(),
    password: String(process.env.ES_PASSWORD || '').trim()
  };
}

function buildVectorSyncConfig() {
  const qdrantEnabled = String(process.env.ENABLE_QDRANT_SYNC || 'true').toLowerCase() !== 'false';
  const embeddingEnabled = String(process.env.ENABLE_EMBEDDING || 'true').toLowerCase() !== 'false';
  const enabled = qdrantEnabled && embeddingEnabled;
  const vectorSyncConcurrencyRaw = Number.parseInt(process.env.KB_VECTOR_SYNC_CONCURRENCY || '2', 10);
  const vectorSyncConcurrency = Math.max(1, Math.min(6, Number.isFinite(vectorSyncConcurrencyRaw) ? vectorSyncConcurrencyRaw : 2));
  return {
    enabled,
    qdrantEnabled,
    embeddingEnabled,
    vectorSyncConcurrency
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeBackoffDelay(attempt, baseDelayMs, maxDelayMs) {
  const delay = baseDelayMs * (2 ** Math.max(0, attempt));
  return Math.min(maxDelayMs, delay);
}

async function runWithBackoffRetry(executor, {
  retries = 0,
  baseDelayMs = 1000,
  maxDelayMs = 10000,
  shouldRetry = () => true,
  onRetry = null
} = {}) {
  const maxAttempts = Math.max(1, Number(retries) + 1);
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await executor(attempt);
    } catch (error) {
      lastError = error;
      const reachedLast = attempt >= maxAttempts - 1;
      if (reachedLast || !shouldRetry(error, attempt)) {
        throw error;
      }
      const delay = computeBackoffDelay(
        attempt,
        Math.max(10, Number(baseDelayMs) || 1000),
        Math.max(10, Number(maxDelayMs) || 10000)
      );
      if (typeof onRetry === 'function') {
        try {
          onRetry({
            attempt,
            nextAttempt: attempt + 1,
            maxAttempts,
            delayMs: delay,
            error
          });
        } catch (_) {
          // ignore logging callback errors
        }
      }
      await sleep(delay);
    }
  }
  throw lastError || new Error('retry_failed');
}

async function runWithWorkerPool(items = [], concurrency = 1, worker) {
  const queue = Array.isArray(items) ? [...items] : [];
  const safeConcurrency = Math.max(1, Number(concurrency) || 1);
  const workers = Array.from({ length: Math.min(safeConcurrency, queue.length) }, async () => {
    while (queue.length) {
      const current = queue.shift();
      if (!current) continue;
      await worker(current);
    }
  });
  await Promise.all(workers);
}

function ensureConfig(config, requiredFields, configName) {
  if (!config.enabled) return;
  const missing = requiredFields.filter((key) => !config[key]);
  if (missing.length) {
    throw new Error(`${configName}_config_missing:${missing.join(',')}`);
  }
}

async function syncChunkToEs({ file, chunk, tags }) {
  const config = buildEsConfig();
  if (!config.enabled) {
    return { skipped: true, esDocId: null };
  }
  ensureConfig(config, ['baseUrl', 'indexName'], 'es');
  const url = `${config.baseUrl}/${encodeURIComponent(config.indexName)}/_doc/${chunk.id}`;
  const payload = {
    id: chunk.id,
    collection_id: file.collectionId,
    file_id: file.id,
    file_name: file.fileName,
    heading_path_text: Array.isArray(chunk.metaJson?.headingPath) ? chunk.metaJson.headingPath.join(' / ') : '',
    heading_path: Array.isArray(chunk.metaJson?.headingPath) ? chunk.metaJson.headingPath : [],
    chunk_type: String(chunk.metaJson?.chunkType || 'paragraph'),
    row_kv_text: String(chunk.metaJson?.rowKvText || ''),
    sheet_name: String(chunk.metaJson?.sheetName || ''),
    table_id: String(chunk.metaJson?.tableId || ''),
    row_index: Number(chunk.metaJson?.rowIndex || 0),
    chunk_no: chunk.chunkNo,
    content: chunk.chunkText,
    token_count: chunk.tokenCount,
    char_count: chunk.charCount,
    start_offset: chunk.startOffset,
    end_offset: chunk.endOffset,
    chunk_sha256: chunk.chunkSha256,
    tags,
    updated_at: new Date().toISOString()
  };
  const auth = config.username ? { username: config.username, password: config.password } : undefined;
  await axios.put(url, payload, { auth, timeout: Number(process.env.ES_TIMEOUT_MS || 20000) });
  return { skipped: false, esDocId: String(chunk.id) };
}

async function recallFromEs({ collectionId, query, topK = 5 }) {
  const config = buildEsConfig();
  if (!config.enabled) {
    return { skipped: true, hits: [] };
  }
  ensureConfig(config, ['baseUrl', 'indexName'], 'es');
  const auth = config.username ? { username: config.username, password: config.password } : undefined;
  const url = `${config.baseUrl}/${encodeURIComponent(config.indexName)}/_search`;
  const body = {
    size: Math.max(1, Math.min(100, Number(topK) || 5)),
    query: {
      bool: {
        must: [
          {
            multi_match: {
              query,
              type: 'most_fields',
              fields: ['content^3', 'row_kv_text^4', 'heading_path_text^2', 'file_name^1.5', 'sheet_name^1.2', 'tags']
            }
          }
        ],
        filter: [
          { term: { collection_id: Number(collectionId) } }
        ]
      }
    },
    _source: [
      'id',
      'collection_id',
      'file_id',
      'file_name',
      'heading_path_text',
      'heading_path',
      'chunk_type',
      'row_kv_text',
      'sheet_name',
      'table_id',
      'row_index',
      'chunk_no',
      'content',
      'tags'
    ]
  };
  const response = await axios.post(url, body, {
    auth,
    timeout: Number(process.env.ES_TIMEOUT_MS || 20000)
  });
  const hits = (response.data?.hits?.hits || []).map((item, index) => ({
    source: 'es',
    rank: index + 1,
    score: Number(item._score || 0),
    chunkId: String(item._source?.id || item._id || ''),
    chunkNo: Number(item._source?.chunk_no || 0),
    fileId: String(item._source?.file_id || ''),
    fileName: String(item._source?.file_name || ''),
    headingPath: Array.isArray(item._source?.heading_path)
      ? item._source.heading_path
      : (String(item._source?.heading_path_text || '').trim() ? String(item._source.heading_path_text).split(' / ') : []),
    chunkType: String(item._source?.chunk_type || 'paragraph'),
    rowKvText: String(item._source?.row_kv_text || ''),
    sheetName: String(item._source?.sheet_name || ''),
    tableId: String(item._source?.table_id || ''),
    rowIndex: Number(item._source?.row_index || 0),
    content: String(item._source?.content || ''),
    tags: Array.isArray(item._source?.tags) ? item._source.tags : []
  }));
  return { skipped: false, hits };
}

function fuseAndRerankHits({ query, esHits = [], vecHits = [], topK = 5, rrfK = 60 }) {
  const map = new Map();
  const push = (hit, lane) => {
    const keyBase = hit.chunkId || `${hit.fileId}:${sha256(hit.content).slice(0, 12)}`;
    const key = String(keyBase);
    if (!map.has(key)) {
      map.set(key, {
        key,
        chunkId: hit.chunkId,
        chunkNo: hit.chunkNo || 0,
        fileId: hit.fileId,
        fileName: hit.fileName,
        headingPath: hit.headingPath || [],
        chunkType: hit.chunkType || 'paragraph',
        rowKvText: hit.rowKvText || '',
        sheetName: hit.sheetName || '',
        tableId: hit.tableId || '',
        rowIndex: Number(hit.rowIndex || 0),
        content: hit.content || '',
        esRank: null,
        vecRank: null,
        esScore: 0,
        vecScore: 0
      });
    }
    const item = map.get(key);
    if (lane === 'es') {
      item.esRank = hit.rank;
      item.esScore = hit.score;
    } else {
      item.vecRank = hit.rank;
      item.vecScore = hit.score;
    }
  };
  esHits.forEach((hit) => push(hit, 'es'));
  vecHits.forEach((hit) => push(hit, 'vector'));

  const queryTokens = tokenizeText(query);
  const merged = Array.from(map.values()).map((item) => {
    const rrfScore =
      (item.esRank ? 1 / (rrfK + item.esRank) : 0) +
      (item.vecRank ? 1 / (rrfK + item.vecRank) : 0);
    const haystack = `${item.fileName || ''} ${Array.isArray(item.headingPath) ? item.headingPath.join(' ') : ''} ${item.content || ''}`.toLowerCase();
    const overlapCount = queryTokens.filter((token) => haystack.includes(token)).length;
    const overlapScore = queryTokens.length ? overlapCount / queryTokens.length : 0;
    const titleHitScore = queryTokens.some((token) => String(item.fileName || '').toLowerCase().includes(token))
      ? 1
      : 0;
    const rerankScore = 0.7 * rrfScore + 0.2 * overlapScore + 0.1 * titleHitScore;
    return {
      ...item,
      rrfScore,
      overlapScore,
      titleHitScore,
      rerankScore
    };
  });

  merged.sort((a, b) => b.rrfScore - a.rrfScore);
  const fused = merged.slice(0, Math.max(1, Math.min(100, Number(topK) || 5)));

  const reranked = [...fused].sort((a, b) => b.rerankScore - a.rerankScore);
  return {
    fused,
    reranked
  };
}

async function retrievalDebug({ collectionId, query, esTopK = 5, vecTopK = 5, fuseTopK = 5 }) {
  const lexicalProvider = createEsLexicalProvider({
    axiosInstance: axios,
    buildEsConfig,
    ensureConfig
  });
  const vectorProvider = createQdrantVectorProvider();
  const retrievalService = createHybridRetrievalService({
    lexicalProvider,
    vectorProvider,
    assetResolver: getChunkAssetRefMap
  });
  return retrievalService.retrievalDebug({
    collectionId,
    query,
    esTopK,
    vecTopK,
    fuseTopK
  });
}

async function deleteEsDocsByQuery({ collectionId = null, fileId = null } = {}) {
  const config = buildEsConfig();
  if (!config.enabled) {
    return { skipped: true };
  }
  ensureConfig(config, ['baseUrl', 'indexName'], 'es');
  const filters = [];
  if (Number.isFinite(Number(collectionId)) && Number(collectionId) > 0) {
    filters.push({ term: { collection_id: Number(collectionId) } });
  }
  if (Number.isFinite(Number(fileId)) && Number(fileId) > 0) {
    filters.push({ term: { file_id: Number(fileId) } });
  }
  if (!filters.length) return { skipped: true };

  const url = `${config.baseUrl}/${encodeURIComponent(config.indexName)}/_delete_by_query?conflicts=proceed&refresh=true`;
  const auth = config.username ? { username: config.username, password: config.password } : undefined;
  try {
    await axios.post(url, {
      query: {
        bool: {
          filter: filters
        }
      }
    }, { auth, timeout: Number(process.env.ES_TIMEOUT_MS || 20000) });
  } catch (error) {
    const status = Number(error?.response?.status);
    if (status === 404) {
      return { skipped: true, indexMissing: true };
    }
    throw error;
  }
  return { skipped: false };
}

function buildVectorChunkContent(chunk) {
  const headingPath = Array.isArray(chunk?.metaJson?.headingPath) ? chunk.metaJson.headingPath : [];
  const rowKvText = String(chunk?.metaJson?.rowKvText || '').trim();
  const sheetName = String(chunk?.metaJson?.sheetName || '').trim();
  const tableId = String(chunk?.metaJson?.tableId || '').trim();
  const parts = [];
  if (headingPath.length) {
    parts.push(`章节: ${headingPath.join(' / ')}`);
  }
  if (sheetName) {
    parts.push(`工作表: ${sheetName}`);
  }
  if (tableId) {
    parts.push(`表格: ${tableId}`);
  }
  if (rowKvText) {
    parts.push(`行数据: ${rowKvText}`);
  }
  const main = String(chunk?.chunkText || '').trim();
  if (main) {
    parts.push(main);
  }
  return parts.join('\n');
}

async function listCollections({ keyword = '' } = {}) {
  const where = {
    isDeleted: 0
  };
  if (keyword.trim()) {
    where.name = {
      [Op.like]: `%${keyword.trim()}%`
    };
  }
  const rows = await KbCollection.findAll({
    where,
    order: [['updatedAt', 'DESC']]
  });
  const tagMap = await getCollectionTagMap(rows.map((item) => item.id));
  return rows.map((item) => {
    const plain = item.toJSON();
    plain.tags = tagMap.get(item.id) || [];
    return plain;
  });
}

async function createCollection({ name, code, description, tags = [], user }) {
  const operatorId = getOperatorId(user);
  const finalTags = normalizeCollectionTags(tags);
  return sequelize.transaction(async (transaction) => {
    const created = await KbCollection.create({
      name: name.trim(),
      code: code.trim(),
      description: description || null,
      createdBy: operatorId,
      updatedBy: operatorId
    }, { transaction });
    await attachTagsToCollection(created.id, finalTags, operatorId, transaction);
    return created;
  });
}

async function getCollectionById(id) {
  const row = await KbCollection.findOne({
    where: {
      id: Number(id),
      isDeleted: 0
    }
  });
  if (!row) return null;
  const tagMap = await getCollectionTagMap([row.id]);
  const plain = row.toJSON();
  plain.tags = tagMap.get(row.id) || [];
  return plain;
}

async function updateCollection({ id, name, description, tags, user }) {
  const collection = await KbCollection.findOne({
    where: {
      id: Number(id),
      isDeleted: 0
    }
  });
  if (!collection) return null;
  const operatorId = getOperatorId(user);
  const finalTags = Array.isArray(tags) ? normalizeCollectionTags(tags) : null;
  const nextName = String(name || collection.name).trim();
  const nextDescription = typeof description === 'string' ? description : collection.description;
  await sequelize.transaction(async (transaction) => {
    await collection.update({
      name: nextName,
      description: nextDescription,
      updatedBy: operatorId
    }, { transaction });
    if (finalTags) {
      await attachTagsToCollection(collection.id, finalTags, operatorId, transaction);
    }
  });
  const refreshed = await KbCollection.findByPk(collection.id);
  const tagMap = await getCollectionTagMap([collection.id]);
  const plain = refreshed.toJSON();
  plain.tags = tagMap.get(collection.id) || [];
  return plain;
}

async function deleteCollection({ id, user }) {
  const collection = await KbCollection.findOne({
    where: {
      id: Number(id),
      isDeleted: 0
    }
  });
  if (!collection) return null;
  try {
    await deleteEsDocsByQuery({ collectionId: collection.id });
  } catch (error) {
    error.message = `kb.es.deleteSyncFailed:${error.message}`;
    throw error;
  }
  const vectorProvider = createQdrantVectorProvider();
  try {
    await vectorProvider.deleteCollectionChunks({ collectionId: collection.id });
  } catch (error) {
    error.message = `kb.vector.deleteSyncFailed:${error.message}`;
    throw error;
  }

  const operatorId = getOperatorId(user);
  await sequelize.transaction(async (transaction) => {
    await collection.update({
      isDeleted: 1,
      deletedAt: new Date(),
      updatedBy: operatorId
    }, { transaction });

    await KbFile.update({
      isDeleted: 1,
      deletedAt: new Date(),
      updatedBy: operatorId
    }, {
      where: { collectionId: collection.id, isDeleted: 0 },
      transaction
    });
  });
  return collection;
}

async function listRecycleBinItems({ keyword = '' } = {}) {
  const cutoff = getRecycleCutoffDate();
  const key = String(keyword || '').trim();
  const whereDeletedCollection = {
    isDeleted: 1,
    deletedAt: {
      [Op.gte]: cutoff
    }
  };
  if (key) {
    whereDeletedCollection.name = { [Op.like]: `%${key}%` };
  }

  const whereDeletedFile = {
    isDeleted: 1,
    deletedAt: {
      [Op.gte]: cutoff
    }
  };
  if (key) {
    whereDeletedFile.fileName = { [Op.like]: `%${key}%` };
  }

  const [deletedCollections, deletedFiles] = await Promise.all([
    KbCollection.findAll({
      where: whereDeletedCollection,
      order: [['deletedAt', 'DESC']]
    }),
    KbFile.findAll({
      where: whereDeletedFile,
      order: [['deletedAt', 'DESC']]
    })
  ]);

  const deletedCollectionIdSet = new Set(deletedCollections.map((item) => Number(item.id)));
  const fileCollectionIds = Array.from(new Set(deletedFiles.map((item) => Number(item.collectionId)).filter((id) => Number.isFinite(id) && id > 0)));
  const extraCollectionIds = fileCollectionIds.filter((id) => !deletedCollectionIdSet.has(id));
  const activeCollections = extraCollectionIds.length
    ? await KbCollection.findAll({
      where: {
        id: { [Op.in]: extraCollectionIds }
      }
    })
    : [];

  const collectionMap = new Map();
  deletedCollections.forEach((collection) => {
    collectionMap.set(Number(collection.id), collection);
  });
  activeCollections.forEach((collection) => {
    collectionMap.set(Number(collection.id), collection);
  });

  const groupedFileMap = new Map();
  deletedFiles.forEach((file) => {
    const collectionId = Number(file.collectionId);
    if (!groupedFileMap.has(collectionId)) groupedFileMap.set(collectionId, []);
    groupedFileMap.get(collectionId).push({
      id: file.id,
      collectionId,
      fileName: file.fileName,
      fileExt: file.fileExt,
      deletedAt: file.deletedAt,
      canRestore: false
    });
  });

  const items = [];
  deletedCollections.forEach((collection) => {
    const collectionId = Number(collection.id);
    const files = groupedFileMap.get(collectionId) || [];
    files.forEach((file) => { file.canRestore = false; });
    items.push({
      id: collection.id,
      name: collection.name,
      isDeleted: true,
      deletedAt: collection.deletedAt,
      canRestore: withinRecycleWindow(collection.deletedAt),
      fileCount: files.length,
      files
    });
  });
  activeCollections.forEach((collection) => {
    const collectionId = Number(collection.id);
    const files = groupedFileMap.get(collectionId) || [];
    if (!files.length) return;
    items.push({
      id: collection.id,
      name: collection.name,
      isDeleted: false,
      deletedAt: files[0]?.deletedAt || null,
      canRestore: false,
      fileCount: files.length,
      files
    });
  });

  items.sort((a, b) => {
    const aTime = a.deletedAt ? new Date(a.deletedAt).getTime() : 0;
    const bTime = b.deletedAt ? new Date(b.deletedAt).getTime() : 0;
    return bTime - aTime;
  });

  return {
    retentionDays: RECYCLE_RETENTION_DAYS,
    items
  };
}

async function restoreRecycleItems({ collectionIds = [], fileIds = [], user, locale }) {
  const operatorId = getOperatorId(user);
  const now = new Date();
  const uniqueCollectionIds = Array.from(new Set((collectionIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)));
  const uniqueFileIds = Array.from(new Set((fileIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)));
  if (uniqueFileIds.length && !uniqueCollectionIds.length) {
    throw new Error('kb.recycle.collectionNotRestored');
  }

  const restoredResult = await sequelize.transaction(async (transaction) => {
    const restored = {
      collectionCount: 0,
      fileCount: 0,
      restoredCollectionIds: [],
      restoredFileIds: []
    };

    if (uniqueCollectionIds.length) {
      const collections = await KbCollection.findAll({
        where: {
          id: { [Op.in]: uniqueCollectionIds },
          isDeleted: 1
        },
        transaction
      });
      const validCollectionIds = collections
        .filter((item) => withinRecycleWindow(item.deletedAt, now))
        .map((item) => item.id);
      if (validCollectionIds.length) {
        const filesToRestore = await KbFile.findAll({
          where: {
            collectionId: { [Op.in]: validCollectionIds },
            isDeleted: 1
          },
          attributes: ['id'],
          transaction
        });
        await KbCollection.update({
          isDeleted: 0,
          deletedAt: null,
          updatedBy: operatorId
        }, {
          where: { id: { [Op.in]: validCollectionIds } },
          transaction
        });
        await KbFile.update({
          isDeleted: 0,
          deletedAt: null,
          updatedBy: operatorId
        }, {
          where: {
            collectionId: { [Op.in]: validCollectionIds },
            isDeleted: 1
          },
          transaction
        });
        restored.collectionCount = validCollectionIds.length;
        restored.restoredCollectionIds.push(...validCollectionIds);
        restored.restoredFileIds.push(...filesToRestore.map((item) => item.id));
      }
    }

    if (uniqueFileIds.length) {
      const files = await KbFile.findAll({
        where: {
          id: { [Op.in]: uniqueFileIds },
          isDeleted: 1
        },
        transaction
      });
      const collectionIdsOfFiles = Array.from(new Set(files.map((item) => item.collectionId)));
      const collections = await KbCollection.findAll({
        where: {
          id: { [Op.in]: collectionIdsOfFiles }
        },
        transaction
      });
      const collectionMap = new Map(collections.map((item) => [item.id, item]));

      const restorableFileIds = [];
      files.forEach((file) => {
        if (!withinRecycleWindow(file.deletedAt, now)) return;
        const parent = collectionMap.get(file.collectionId);
        if (!parent || Number(parent.isDeleted) === 1) {
          throw new Error('kb.recycle.collectionNotRestored');
        }
        restorableFileIds.push(file.id);
      });

      if (restorableFileIds.length) {
        await KbFile.update({
          isDeleted: 0,
          deletedAt: null,
          updatedBy: operatorId
        }, {
          where: { id: { [Op.in]: restorableFileIds } },
          transaction
        });
        restored.fileCount = restorableFileIds.length;
        restored.restoredFileIds.push(...restorableFileIds);
      }
    }

    return restored;
  });

  const uniqueRestoredFileIds = Array.from(new Set(restoredResult.restoredFileIds));

  for (const fileId of uniqueRestoredFileIds) {
    const file = await KbFile.findByPk(fileId);
    if (!file) continue;
    await file.update({
      status: 'uploaded',
      errorMessage: null,
      errorMessageKey: null,
      updatedBy: operatorId
    });
  }

  let rebuildQueuedCount = 0;
  for (const fileId of uniqueRestoredFileIds) {
    const result = await rebuildFile({
      id: fileId,
      user,
      locale
    });
    if (result) rebuildQueuedCount += 1;
  }

  return {
    collectionCount: restoredResult.collectionCount,
    fileCount: uniqueRestoredFileIds.length,
    rebuildQueuedCount
  };
}

function queueByName(queueName) {
  if (queueName === 'kb-purge') return kbPurgeQueue;
  return kbIngestQueue;
}

async function submitRecyclePurgeJobs({ collectionIds = [], fileIds = [], user, locale }) {
  const now = new Date();
  const operatorId = getOperatorId(user);
  const uniqueCollectionIds = Array.from(new Set((collectionIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)));
  const uniqueFileIds = Array.from(new Set((fileIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)));

  const jobs = [];
  if (uniqueCollectionIds.length) {
    const collections = await KbCollection.findAll({
      where: {
        id: { [Op.in]: uniqueCollectionIds },
        isDeleted: 1
      }
    });
    collections.forEach((collection) => {
      if (!withinRecycleWindow(collection.deletedAt, now)) return;
      jobs.push({
        bizType: 'collection',
        bizId: collection.id
      });
    });
  }
  if (uniqueFileIds.length) {
    const files = await KbFile.findAll({
      where: {
        id: { [Op.in]: uniqueFileIds },
        isDeleted: 1
      }
    });
    files.forEach((file) => {
      if (!withinRecycleWindow(file.deletedAt, now)) return;
      jobs.push({
        bizType: 'file',
        bizId: file.id
      });
    });
  }

  const createdJobs = [];
  for (const jobItem of jobs) {
    const idempotencyKey = `purge:${jobItem.bizType}:${jobItem.bizId}:${Date.now()}:${Math.round(Math.random() * 1000)}`;
    const jobRecord = await KbJob.create({
      jobType: 'purge',
      bizType: jobItem.bizType,
      bizId: jobItem.bizId,
      idempotencyKey,
      queueName: 'kb-purge',
      payloadJson: {
        locale
      },
      status: 'queued',
      createdBy: operatorId
    });
    const queueJob = await kbPurgeQueue.add(
      'purge-kb',
      {
        kbJobId: jobRecord.id,
        bizType: jobItem.bizType,
        bizId: jobItem.bizId,
        locale,
        operatorId
      },
      {
        jobId: `kb-purge-${jobItem.bizType}-${jobItem.bizId}-job-${jobRecord.id}`
      }
    );
    await jobRecord.update({
      payloadJson: {
        ...(jobRecord.payloadJson || {}),
        queueJobId: queueJob.id
      }
    });
    await publishKbTaskStatus({
      taskId: jobRecord.id,
      queueJobId: String(queueJob.id),
      status: 'queued',
      progress: 0,
      fileId: jobItem.bizType === 'file' ? Number(jobItem.bizId) : null,
      collectionId: null,
      jobType: 'purge'
    });
    createdJobs.push(jobRecord);
  }
  return createdJobs;
}

function resolveLocalPath(storageUri = '') {
  const value = String(storageUri || '');
  if (!value) return '';
  if (value.startsWith('file://')) return value.replace('file://', '');
  if (value.startsWith('kb://')) return '';
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

async function safeDeleteLocalFile(storageUri = '') {
  const localPath = resolveLocalPath(storageUri);
  if (!localPath) return;
  await fs.unlink(localPath).catch(() => null);
}

async function safeDeleteStorageUri(storageUri = '') {
  if (isS3Uri(storageUri)) {
    await deleteObjectByUri(storageUri).catch(() => null);
    return;
  }
  await safeDeleteLocalFile(storageUri);
}

async function hardDeleteFileById({ fileId, transaction }) {
  const file = await KbFile.findByPk(fileId, { transaction });
  if (!file) return false;
  const existingAssets = await KbAsset.findAll({
    where: { fileId: file.id },
    attributes: ['storageUri'],
    transaction
  });
  const assetStorageUris = existingAssets
    .map((item) => String(item.storageUri || '').trim())
    .filter(Boolean);

  const chunks = await KbChunk.findAll({
    where: { fileId: file.id },
    attributes: ['id'],
    transaction
  });
  const chunkIds = chunks.map((item) => item.id);
  if (chunkIds.length) {
    await KbChunkIndexState.destroy({
      where: {
        chunkId: { [Op.in]: chunkIds }
      },
      transaction
    });
    await sequelize.query('DELETE FROM kb_chunk_asset WHERE chunk_id IN (:chunkIds)', {
      replacements: { chunkIds },
      transaction
    });
  }
  await KbChunk.destroy({ where: { fileId: file.id }, transaction });
  await KbFileLineage.destroy({
    where: {
      [Op.or]: [
        { sourceFileId: file.id },
        { derivedFileId: file.id }
      ]
    },
    transaction
  });
  await sequelize.query('DELETE FROM kb_asset_ocr WHERE asset_id IN (SELECT id FROM kb_asset WHERE file_id = :fileId)', {
    replacements: { fileId: file.id },
    transaction
  });
  await sequelize.query('DELETE FROM kb_asset WHERE file_id = :fileId', {
    replacements: { fileId: file.id },
    transaction
  });
  await KbFile.destroy({
    where: { id: file.id },
    transaction
  });
  for (const assetStorageUri of assetStorageUris) {
    await safeDeleteStorageUri(assetStorageUri);
  }
  if (isS3Uri(file.storageUri)) {
    await deleteObjectByUri(file.storageUri);
  } else {
    await safeDeleteLocalFile(file.storageUri);
  }
  return true;
}

async function executeRecyclePurgeJob({ kbJobId }) {
  const job = await KbJob.findByPk(Number(kbJobId));
  if (!job) {
    throw new Error('kb.jobNotFound');
  }
  await job.update({
    status: 'processing',
    lastError: null,
    lastErrorKey: null
  });
  try {
    if (job.bizType === 'file') {
      await sequelize.transaction(async (transaction) => {
        await hardDeleteFileById({
          fileId: job.bizId,
          transaction
        });
      });
    } else if (job.bizType === 'collection') {
      await sequelize.transaction(async (transaction) => {
        const files = await KbFile.findAll({
          where: { collectionId: job.bizId },
          attributes: ['id'],
          transaction
        });
        for (const file of files) {
          await hardDeleteFileById({
            fileId: file.id,
            transaction
          });
        }
        await KbCollectionTag.destroy({
          where: { collectionId: job.bizId },
          transaction
        });
        await KbCollection.destroy({
          where: { id: job.bizId },
          transaction
        });
      });
    } else {
      throw new Error('kb.recycle.unsupportedBizType');
    }

    await job.update({
      status: 'done',
      lastError: null,
      lastErrorKey: null
    });
    return {
      kbJobId: job.id,
      bizType: job.bizType,
      bizId: job.bizId
    };
  } catch (error) {
    await job.update({
      status: 'failed',
      lastErrorKey: 'kb.recycle.purgeFailed',
      lastError: error.message
    });
    throw error;
  }
}

async function listCollectionFiles({ collectionId, status, fileType }) {
  const where = {
    collectionId,
    isDeleted: 0
  };
  if (status) where.status = status;
  if (fileType) where.fileExt = fileType;
  return KbFile.findAll({
    where,
    order: [['createdAt', 'DESC']]
  });
}

async function listCollectionFilesPaged({
  collectionId,
  status = '',
  fileType = '',
  keyword = '',
  page = 1,
  pageSize = 20,
  sortBy = 'createdAt',
  sortOrder = 'DESC'
}) {
  const where = {
    collectionId: Number(collectionId),
    isDeleted: 0
  };
  if (status) where.status = status;
  if (fileType) where.fileExt = fileType;
  if (String(keyword).trim()) {
    where.fileName = {
      [Op.like]: `%${String(keyword).trim()}%`
    };
  }
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 20));
  const orderMap = {
    createdAt: 'createdAt',
    fileName: 'fileName',
    fileSize: 'fileSize',
    status: 'status'
  };
  const safeSortBy = orderMap[sortBy] || 'createdAt';
  const safeSortOrder = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const result = await KbFile.findAndCountAll({
    where,
    order: [[safeSortBy, safeSortOrder]],
    offset: (safePage - 1) * safePageSize,
    limit: safePageSize
  });
  const rows = result.rows || [];
  const fileIds = rows.map((item) => item.id);

  const latestJobStatusMap = new Map();
  if (fileIds.length) {
    const jobs = await KbJob.findAll({
      where: {
        bizType: 'file',
        bizId: {
          [Op.in]: fileIds
        }
      },
      attributes: ['bizId', 'status', 'createdAt'],
      order: [['createdAt', 'DESC']]
    });
    jobs.forEach((job) => {
      const key = String(job.bizId);
      if (!latestJobStatusMap.has(key)) {
        latestJobStatusMap.set(key, job.status);
      }
    });
  }

  const indexSummaryMap = new Map();
  const requireVectorSync = buildVectorSyncConfig().enabled;
  if (fileIds.length) {
    const chunkRows = await KbChunk.findAll({
      where: {
        fileId: {
          [Op.in]: fileIds
        }
      },
      attributes: ['id', 'fileId'],
      include: [
        {
          model: KbChunkIndexState,
          as: 'indexState',
          required: false,
          attributes: ['esStatus', 'vectorStatus']
        }
      ]
    });
    chunkRows.forEach((chunk) => {
      const key = String(chunk.fileId);
      if (!indexSummaryMap.has(key)) {
        indexSummaryMap.set(key, {
          total: 0,
          esDone: 0,
          esFailed: 0,
          vectorDone: 0,
          vectorFailed: 0,
          esStatus: 'pending',
          vectorStatus: 'pending'
        });
      }
      const bucket = indexSummaryMap.get(key);
      bucket.total += 1;
      const esStatus = chunk.indexState?.esStatus || 'pending';
      const vectorStatus = chunk.indexState?.vectorStatus || 'pending';
      if (esStatus === 'done') bucket.esDone += 1;
      if (esStatus === 'failed') bucket.esFailed += 1;
      if (vectorStatus === 'done' || (!requireVectorSync && vectorStatus === 'skipped')) bucket.vectorDone += 1;
      if (vectorStatus === 'failed') bucket.vectorFailed += 1;
    });

    indexSummaryMap.forEach((bucket) => {
      bucket.esStatus = bucket.total <= 0
        ? 'pending'
        : (bucket.esFailed > 0 ? 'failed' : (bucket.esDone >= bucket.total ? 'done' : 'pending'));
      bucket.vectorStatus = bucket.total <= 0
        ? 'pending'
        : (bucket.vectorFailed > 0 ? 'failed' : (bucket.vectorDone >= bucket.total ? 'done' : 'pending'));
    });
  }

  const enrichedRows = rows.map((item) => {
    const plain = item.toJSON();
    const rowKey = String(item.id);
    const latestJobStatus = latestJobStatusMap.get(rowKey) || null;
    const indexSummary = indexSummaryMap.get(rowKey) || {
      total: 0,
      esDone: 0,
      esFailed: 0,
      vectorDone: 0,
      vectorFailed: 0,
      esStatus: 'pending',
      vectorStatus: 'pending'
    };
    const failedFile = String(plain.status || '').includes('failed') || plain.status === 'file_error';
    const hasKeyChannelsReady = indexSummary.esStatus === 'done'
      && (!requireVectorSync || indexSummary.vectorStatus === 'done');
    let displayStatus = 'processing';
    if (failedFile || latestJobStatus === 'failed') {
      displayStatus = 'failed';
    } else if (latestJobStatus === 'queued' || plain.status === 'uploaded') {
      displayStatus = 'waiting';
    } else if (plain.status === 'ready' && hasKeyChannelsReady) {
      displayStatus = 'ready';
    } else if (latestJobStatus === 'processing' || ['parsing', 'indexing'].includes(String(plain.status || ''))) {
      displayStatus = 'processing';
    }

    return {
      ...plain,
      latestJobStatus,
      displayStatus,
      indexSummary
    };
  });

  return {
    items: enrichedRows,
    total: result.count,
    page: safePage,
    pageSize: safePageSize
  };
}

async function deleteFile({ id, user }) {
  const file = await KbFile.findOne({
    where: {
      id: Number(id),
      isDeleted: 0
    }
  });
  if (!file) return null;
  try {
    await deleteEsDocsByQuery({ fileId: file.id });
  } catch (error) {
    error.message = `kb.es.deleteSyncFailed:${error.message}`;
    throw error;
  }
  const vectorProvider = createQdrantVectorProvider();
  try {
    await vectorProvider.deleteFileChunks({ fileId: file.id });
  } catch (error) {
    error.message = `kb.vector.deleteSyncFailed:${error.message}`;
    throw error;
  }
  await file.update({
    isDeleted: 1,
    deletedAt: new Date(),
    updatedBy: getOperatorId(user)
  });
  return file;
}

async function rebuildFile({ id, user, locale }) {
  const file = await KbFile.findOne({
    where: {
      id: Number(id),
      isDeleted: 0
    }
  });
  if (!file) return null;

  const idempotencyKey = `rebuild:${file.id}:${Date.now()}`;
  const jobRecord = await KbJob.create({
    jobType: 'rebuild',
    bizType: 'file',
    bizId: file.id,
    idempotencyKey,
    queueName: 'kb-ingest',
    payloadJson: {
      locale,
      metadata: { rebuild: true }
    },
    status: 'queued',
    createdBy: getOperatorId(user)
  });

  await file.update({
    status: 'uploaded',
    errorMessage: null,
    errorMessageKey: null
  });

  const queueJob = await kbIngestQueue.add(
    'ingest-kb',
    {
      fileId: file.id,
      kbJobId: jobRecord.id,
      collectionId: file.collectionId,
      metadata: { rebuild: true },
      locale,
      operatorId: getOperatorId(user)
    },
    {
      jobId: `kb-rebuild-file-${file.id}-job-${jobRecord.id}`
    }
  );

  await jobRecord.update({
    payloadJson: {
      ...(jobRecord.payloadJson || {}),
      queueJobId: queueJob.id
    }
  });
  await publishKbTaskStatus({
    taskId: jobRecord.id,
    queueJobId: String(queueJob.id),
    status: 'queued',
    progress: 0,
    fileId: Number(file.id),
    collectionId: Number(file.collectionId),
    jobType: 'rebuild'
  });

  return {
    file,
    jobRecord,
    queueJobId: queueJob.id
  };
}

async function renameFile({ id, fileName, user }) {
  const nextName = String(fileName || '').trim();
  if (!nextName) return null;
  const file = await KbFile.findOne({
    where: {
      id: Number(id),
      isDeleted: 0
    }
  });
  if (!file) return null;
  const oldExt = normalizeFileExt(file.fileName, file.fileExt);
  const newExt = normalizeFileExt(nextName, file.fileExt);
  if (oldExt !== newExt) {
    throw new Error('kb.fileExtUnsupported');
  }
  const duplicated = await KbFile.findOne({
    where: {
      collectionId: file.collectionId,
      fileName: nextName,
      isDeleted: 0,
      id: {
        [Op.ne]: file.id
      }
    }
  });
  if (duplicated) {
    throw new Error('kb.fileNameDuplicated');
  }
  const vectorProvider = createQdrantVectorProvider();
  try {
    await vectorProvider.updateFileMetadata({
      fileId: file.id,
      fileName: nextName
    });
  } catch (error) {
    error.message = `kb.vector.renameSyncFailed:${error.message}`;
    throw error;
  }
  await file.update({
    fileName: nextName,
    updatedBy: getOperatorId(user)
  });
  return file;
}

async function getFileDownloadInfo({ id }) {
  const file = await KbFile.findOne({
    where: {
      id: Number(id),
      isDeleted: 0
    }
  });
  if (!file) return null;
  if (isS3Uri(file.storageUri)) {
    return {
      file,
      localPath: ''
    };
  }
  const localPath = getLocalPathFromStorageUri(file.storageUri);
  if (!localPath) {
    throw new Error('kb.fileNotFound');
  }
  return {
    file,
    localPath
  };
}

async function rollbackFailedIngestCreation({
  lineageRecord = null,
  jobRecord = null,
  file = null
} = {}) {
  for (const target of [lineageRecord, jobRecord, file]) {
    if (!target || typeof target.destroy !== 'function') continue;
    try {
      await target.destroy();
    } catch (error) {
      console.warn('[KB提交] rollback_failed', {
        target: target.constructor?.name || 'record',
        message: error.message
      });
    }
  }
}

async function submitIngestTask({
  collectionId,
  fileName,
  fileExt,
  mimeType,
  fileSize = 0,
  uploadMode = 'normal',
  storageUri = '',
  contentSha256 = '',
  rawText = '',
  metadata = {},
  user,
  locale
}) {
  const operatorId = getOperatorId(user);
  const normalizedExt = normalizeFileExt(fileName, fileExt);
  if (!SUPPORTED_EXTS.includes(normalizedExt)) {
    return {
      rejected: true,
      reasonKey: 'kb.fileExtUnsupported'
    };
  }

  const collection = await KbCollection.findOne({
    where: { id: collectionId, isDeleted: 0 }
  });
  if (!collection) {
    return {
      rejected: true,
      reasonKey: 'kb.collectionNotFound'
    };
  }

  const contentHash = String(contentSha256 || '').trim() || sha256(rawText || `${fileName}:${fileSize}:${storageUri}`);
  const existing = await KbFile.findOne({
    where: {
      collectionId,
      contentSha256: contentHash,
      isDeleted: 0
    },
    order: [['id', 'DESC']]
  });

  if (existing && uploadMode !== 'force_version') {
    return {
      dedupReused: true,
      file: existing
    };
  }

  const latestVersion = await KbFile.max('versionNo', {
    where: {
      collectionId,
      fileName,
      isDeleted: 0
    }
  });
  const versionNo = Number.isFinite(latestVersion) ? latestVersion + 1 : 1;
  let lineageRecord = null;
  const file = await KbFile.create({
      collectionId,
      fileName: fileName.trim(),
      fileExt: normalizedExt,
      mimeType: mimeType || null,
      fileSize: Number(fileSize || 0),
      storageUri: storageUri || `kb://${collectionId}/${Date.now()}-${fileName}`,
      contentSha256: contentHash,
      ragflowDocumentId: null,
      uploadMode,
      versionNo,
      status: 'uploaded',
      createdBy: operatorId,
      updatedBy: operatorId
    });

  if (existing && uploadMode === 'force_version') {
    lineageRecord = await KbFileLineage.create({
      collectionId,
      sourceFileId: existing.id,
      derivedFileId: file.id,
      relationType: 'new_version',
      createdBy: operatorId
    });
  }

  const idempotencyKey = `${file.id}:${contentHash}:${Date.now()}`;
  const jobRecord = await KbJob.create({
    jobType: 'parse',
    bizType: 'file',
    bizId: file.id,
    idempotencyKey,
    queueName: 'kb-ingest',
    payloadJson: {
      locale,
      metadata
    },
    status: 'queued',
    createdBy: operatorId
  });

  let queueJob;
  try {
    queueJob = await kbIngestQueue.add(
      'ingest-kb',
      {
        fileId: file.id,
        kbJobId: jobRecord.id,
        collectionId,
        rawText,
        metadata,
        locale,
        operatorId
      },
      {
        jobId: `kb-file-${file.id}-job-${jobRecord.id}`
      }
    );
  } catch (error) {
    await rollbackFailedIngestCreation({
      lineageRecord,
      jobRecord,
      file
    });
    throw error;
  }

  await jobRecord.update({
    payloadJson: {
      ...(jobRecord.payloadJson || {}),
      queueJobId: queueJob.id
    }
  });
  await publishKbTaskStatus({
    taskId: jobRecord.id,
    queueJobId: String(queueJob.id),
    status: 'queued',
    progress: 0,
    fileId: Number(file.id),
    collectionId: Number(collectionId),
    jobType: 'parse'
  });

  return {
    file,
    jobRecord,
    queueJobId: queueJob.id
  };
}

async function getJobStatus(jobId) {
  const dbJob = await KbJob.findByPk(jobId);

  if (!dbJob) return null;
  const queueJobId = dbJob.payloadJson?.queueJobId || null;
  const queue = queueByName(dbJob.queueName);
  const queueJob = queueJobId
    ? await queue.getJob(String(queueJobId)).catch(() => null)
    : null;

  let queueState = null;
  let queueProgress = 0;
  let queueFailedReason = null;
  if (queueJob) {
    queueState = await queueJob.getState();
    queueProgress = queueJob.progress();
    queueFailedReason = queueJob.failedReason || null;
  }

  return {
    dbJob,
    queueState,
    queueProgress,
    queueFailedReason
  };
}

async function upsertFileAssetsAndRelations({
  file,
  chunks = [],
  createdChunks = [],
  parsedDocx = null,
  parsedPdf = null,
  transaction
}) {
  if (!file) return;
  const docxAssets = (parsedDocx && Array.isArray(parsedDocx.images))
    ? parsedDocx.images
      .map((image) => ({
        assetKey: String(image.imageKey || '').trim(),
        assetType: 'image',
        contentType: image.contentType || '',
        base64: image.base64 || '',
        text: '',
        sha256: image.sha256 || null,
        byteLength: Number(image.byteLength || 0),
        sourceRef: String(image.imageKey || '').trim(),
        sourcePageNo: null,
        width: null,
        height: null,
        meta: {
          parser: 'docx_mammoth',
          byteLength: Number(image.byteLength || 0)
        }
      }))
      .filter((item) => item.assetKey && item.base64)
    : [];
  const pdfAssets = (parsedPdf && Array.isArray(parsedPdf.assets))
    ? parsedPdf.assets
      .map((asset) => ({
        assetKey: String(asset.assetKey || '').trim(),
        assetType: String(asset.assetType || 'image'),
        contentType: asset.contentType || '',
        base64: asset.base64 || '',
        text: String(asset.text || ''),
        sha256: asset.sha256 || null,
        byteLength: Number(asset.byteLength || 0),
        sourceRef: String(asset.sourceRef || asset.assetKey || '').trim(),
        sourcePageNo: Number(asset.sourcePageNo || 0) || null,
        width: Number(asset.width || 0) || null,
        height: Number(asset.height || 0) || null,
        meta: {
          ...(asset.meta || {}),
          parser: 'pdf_parse'
        }
      }))
      .filter((item) => item.assetKey && (item.base64 || item.text))
    : [];
  const sourceAssets = [...docxAssets, ...pdfAssets];
  if (!sourceAssets.length) return;

  const storageConfig = buildStorageConfig();
  const assetsDir = path.resolve(kbStorage.LOCAL_DIR, 'assets');
  await fs.mkdir(assetsDir, { recursive: true });

  const existingAssets = await KbAsset.findAll({
    where: { fileId: file.id },
    attributes: ['id'],
    transaction
  });
  const existingAssetIds = existingAssets.map((item) => item.id);
  if (existingAssetIds.length) {
    await KbChunkAsset.destroy({
      where: { assetId: { [Op.in]: existingAssetIds } },
      transaction
    });
    await sequelize.query('DELETE FROM kb_asset_ocr WHERE asset_id IN (:assetIds)', {
      replacements: { assetIds: existingAssetIds },
      transaction
    });
    await KbAsset.destroy({
      where: { id: { [Op.in]: existingAssetIds } },
      transaction
    });
  }

  const assetKeyToAssetId = new Map();
  for (const asset of sourceAssets) {
    const assetKey = String(asset.assetKey || '').trim();
    if (!assetKey) continue;
    const payloadBuffer = asset.base64
      ? Buffer.from(String(asset.base64), 'base64')
      : Buffer.from(String(asset.text || ''), 'utf8');
    const ext = path.extname(assetKey) || (String(asset.assetType || '') === 'table' ? '.txt' : '.bin');
    const fileName = `${path.basename(file.fileName, path.extname(file.fileName))}-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`;
    let storageUri = '';
    if (storageConfig.enabled) {
      const objectKey = buildUploadObjectKey({
        collectionId: file.collectionId,
        fileName
      });
      storageUri = await uploadBuffer({
        buffer: payloadBuffer,
        objectKey,
        contentType: asset.contentType || ''
      });
    } else {
      const localPath = path.resolve(assetsDir, fileName);
      await fs.writeFile(localPath, payloadBuffer);
      storageUri = `file://${localPath}`;
    }
    const created = await KbAsset.create({
      fileId: file.id,
      assetType: asset.assetType || 'image',
      storageUri,
      mimeType: asset.contentType || null,
      assetSha256: asset.sha256 || null,
      width: asset.width || null,
      height: asset.height || null,
      sourcePageNo: asset.sourcePageNo || null,
      sourceRef: asset.sourceRef || assetKey,
      metaJson: asset.meta || {}
    }, { transaction });
    assetKeyToAssetId.set(assetKey, created.id);
  }

  const relationRows = [];
  createdChunks.forEach((chunk, idx) => {
    const source = chunks[idx];
    const keys = Array.isArray(source?.assetKeys) ? source.assetKeys : [];
    keys.forEach((key, keyIndex) => {
      const assetId = assetKeyToAssetId.get(String(key));
      if (!assetId) return;
      relationRows.push({
        chunkId: chunk.id,
        assetId,
        relationType: 'inline',
        sortNo: keyIndex
      });
    });
  });

  if (relationRows.length) {
    await KbChunkAsset.bulkCreate(relationRows, { transaction });
  }
}

async function getChunkAssetRefMap(chunkIds = []) {
  const safeIds = Array.from(new Set((chunkIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)));
  if (!safeIds.length) return new Map();
  const rows = await KbChunkAsset.findAll({
    where: {
      chunkId: { [Op.in]: safeIds }
    },
    include: [
      {
        model: KbAsset,
        as: 'asset',
        required: true,
        attributes: ['id', 'assetType', 'storageUri', 'mimeType', 'sourceRef', 'metaJson']
      }
    ],
    order: [['sortNo', 'ASC']]
  });
  const map = new Map();
  rows.forEach((row) => {
    const key = String(row.chunkId);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({
      id: row.asset.id,
      assetType: row.asset.assetType,
      storageUri: row.asset.storageUri,
      mimeType: row.asset.mimeType,
      sourceRef: row.asset.sourceRef,
      meta: row.asset.metaJson || {}
    });
  });
  return map;
}

async function runIngestPipeline({
  fileId,
  kbJobId,
  rawText = '',
  parsedDocx = null,
  parsedXlsx = null,
  parsedPdf = null,
  reindexOnly = false
}) {
  const file = await KbFile.findByPk(fileId);
  const job = await KbJob.findByPk(kbJobId);
  const collection = file ? await KbCollection.findByPk(file.collectionId) : null;
  if (!file || !job) {
    throw new Error('file_or_job_not_found');
  }
  const fileExt = normalizeFileExt(file.fileName, file.fileExt);
  const cleanedText = cleanTextByType(rawText, fileExt);
  const collectionTagMap = await getCollectionTagMap([file.collectionId]);
  const normalizedTags = (collectionTagMap.get(file.collectionId) || []).map((tag) => normalizeTag(tag.name)).filter(Boolean);
  const uniqueTags = Array.from(new Set(normalizedTags));

  await job.update({ status: 'processing' });

  let chunks = [];
  let createdChunks = [];
  let staleAssetStorageUris = [];
  if (reindexOnly) {
    await file.update({
      status: 'indexing',
      errorMessageKey: null,
      errorMessage: null
    });
    createdChunks = await KbChunk.findAll({
      where: { fileId: file.id },
      order: [['chunkNo', 'ASC']]
    });
    if (!createdChunks.length) {
      throw new Error('reindex_chunks_not_found');
    }
    chunks = createdChunks.map((chunk) => ({
      text: String(chunk.chunkText || ''),
      chunkType: String(chunk.metaJson?.chunkType || 'paragraph'),
      headingPath: Array.isArray(chunk.metaJson?.headingPath) ? chunk.metaJson.headingPath : [],
      assetKeys: Array.isArray(chunk.metaJson?.assetKeys) ? chunk.metaJson.assetKeys : [],
      rowKvText: String(chunk.metaJson?.rowKvText || ''),
      sheetName: String(chunk.metaJson?.sheetName || ''),
      tableId: String(chunk.metaJson?.tableId || ''),
      rowIndex: Number(chunk.metaJson?.rowIndex || 0)
    }));
  } else {
    await file.update({
      status: 'parsing',
      errorMessageKey: null,
      errorMessage: null
    });

    chunks = (
      (fileExt === 'docx' && parsedDocx && Array.isArray(parsedDocx.blocks))
      || (fileExt === 'xlsx' && parsedXlsx && Array.isArray(parsedXlsx.blocks))
      || (fileExt === 'pdf' && parsedPdf && Array.isArray(parsedPdf.blocks))
    )
      ? splitStructuredBlocksToChunks(
        fileExt === 'docx'
          ? parsedDocx.blocks
          : (fileExt === 'xlsx' ? parsedXlsx.blocks : parsedPdf.blocks),
        800
      )
      : splitTextToChunks(cleanedText, { fileExt });
    if (!chunks.length) {
      await file.update({
        status: 'parse_failed',
        errorMessageKey: 'kb.parser.emptyText',
        errorMessage: 'text_empty_after_parse'
      });
      await job.update({
        status: 'failed',
        lastErrorKey: 'kb.parser.emptyText',
        lastError: 'text_empty_after_parse'
      });
      throw new Error('text_empty_after_parse');
    }

    await sequelize.transaction(async (transaction) => {
      const existingChunks = await KbChunk.findAll({
        where: { fileId: file.id },
        attributes: ['id'],
        transaction
      });
      const chunkIds = existingChunks.map((item) => item.id);

      if (chunkIds.length) {
        await KbChunkIndexState.destroy({
          where: {
            chunkId: {
              [Op.in]: chunkIds
            }
          },
          transaction
        });
        await KbChunkAsset.destroy({
          where: {
            chunkId: {
              [Op.in]: chunkIds
            }
          },
          transaction
        });
      }

      const existingAssets = await KbAsset.findAll({
        where: { fileId: file.id },
        attributes: ['storageUri'],
        transaction
      });
      staleAssetStorageUris = existingAssets
        .map((item) => String(item.storageUri || '').trim())
        .filter(Boolean);

      await sequelize.query('DELETE FROM kb_asset_ocr WHERE asset_id IN (SELECT id FROM kb_asset WHERE file_id = :fileId)', {
        replacements: { fileId: file.id },
        transaction
      });
      await KbAsset.destroy({
        where: { fileId: file.id },
        transaction
      });

      await KbChunk.destroy({
        where: { fileId: file.id },
        transaction
      });

      createdChunks = await KbChunk.bulkCreate(
        chunks.map((item, index) => ({
          fileId: file.id,
          chunkNo: index + 1,
          chunkText: item.text,
          tokenCount: Math.ceil(item.text.length / 4),
          charCount: item.text.length,
          startOffset: item.startOffset,
          endOffset: item.endOffset,
          chunkSha256: sha256(item.text),
          metaJson: {
            parser:
              fileExt === 'txt'
                ? 'txt_v1'
                : (fileExt === 'docx'
                  ? 'docx_mammoth_v1'
                  : (fileExt === 'xlsx'
                    ? 'xlsx_sheet_v1'
                    : (fileExt === 'pdf' && parsedPdf && Array.isArray(parsedPdf.blocks) && parsedPdf.blocks.length
                      ? 'pdf_struct_v1'
                      : (fileExt === 'pdf' ? 'pdf_text_v1' : 'plain_text')))),
            cleaner: fileExt,
            version:
              fileExt === 'docx'
                ? 5
                : (fileExt === 'xlsx'
                  ? 1
                  : (fileExt === 'pdf' && parsedPdf && Array.isArray(parsedPdf.blocks) && parsedPdf.blocks.length ? 2 : (fileExt === 'pdf' ? 1 : 3))),
            chunkType: item.chunkType || 'paragraph',
            headingPath: item.headingPath || [],
            assetKeys: item.assetKeys || [],
            rowKvText: item.rowKvText || '',
            sheetName: item.sheetName || '',
            tableId: item.tableId || '',
            rowIndex: Number(item.rowIndex || 0)
          }
        })),
        { transaction }
      );

      await upsertFileAssetsAndRelations({
        file,
        chunks,
        createdChunks,
        parsedDocx: fileExt === 'docx' ? parsedDocx : null,
        parsedPdf: fileExt === 'pdf' ? parsedPdf : null,
        transaction
      });

      await KbChunkIndexState.bulkCreate(
        createdChunks.map((chunk) => ({
          chunkId: chunk.id,
          esStatus: 'pending',
          vectorStatus: 'pending'
        })),
        { transaction }
      );
    });
    for (const storageUri of staleAssetStorageUris) {
      await safeDeleteStorageUri(storageUri);
    }
  }

  await sequelize.transaction(async (transaction) => {
    const chunkIds = createdChunks.map((item) => item.id);
    const existingStates = await KbChunkIndexState.findAll({
      where: {
        chunkId: {
          [Op.in]: chunkIds
        }
      },
      attributes: ['chunkId'],
      transaction
    });
    const existingStateIds = new Set(existingStates.map((item) => Number(item.chunkId)));
    const missingRows = chunkIds
      .filter((id) => !existingStateIds.has(Number(id)))
      .map((chunkId) => ({
        chunkId,
        esStatus: 'pending',
        vectorStatus: 'pending'
      }));
    if (missingRows.length) {
      await KbChunkIndexState.bulkCreate(missingRows, { transaction });
    }
  });

  await file.update({ status: 'indexing' });

  const shouldResetIndexes = !reindexOnly;
  let esBootstrapError = null;
  if (shouldResetIndexes) {
    try {
      // Ensure ES behaves as "replace on rebuild/ingest" by
      // removing previous docs for the same file before indexing new chunks.
      await deleteEsDocsByQuery({ fileId: file.id });
    } catch (error) {
      esBootstrapError = error;
    }
  }

  const vectorSyncConfig = buildVectorSyncConfig();
  const embeddingService = createEmbeddingService();
  const vectorProvider = createQdrantVectorProvider({ embeddingService });
  let vectorBootstrapError = null;
  try {
    if (vectorSyncConfig.enabled) {
      await vectorProvider.ensureCollection();
      if (shouldResetIndexes) {
        await vectorProvider.deleteFileChunks({ fileId: file.id });
      }
    }
  } catch (error) {
    vectorBootstrapError = error;
  }
  const failedMessages = [];
  const stateMap = new Map();
  const vectorStats = {
    planned: 0,
    started: 0,
    done: 0,
    failed: 0,
    retries: 0,
    timeout: 0,
    network: 0,
    http4xx: 0,
    http5xx: 0,
    unknown: 0
  };

  // Phase 1: prioritize ES indexing so ES can finish even when vector sync is slow.
  for (const chunk of createdChunks) {
    const state = await KbChunkIndexState.findOne({
      where: { chunkId: chunk.id }
    });
    if (!state) continue;
    stateMap.set(Number(chunk.id), state);

    const needsEsSync = !reindexOnly || state.esStatus !== 'done';
    if (!needsEsSync) continue;
    try {
      if (esBootstrapError) throw esBootstrapError;
      const esResult = await syncChunkToEs({ file, chunk, tags: uniqueTags });
      await state.update({
        esStatus: 'done',
        esDocId: esResult.esDocId,
        lastErrorKey: null,
        lastError: null,
        esUpdatedAt: new Date()
      });
    } catch (error) {
      failedMessages.push(`chunk_${chunk.id}_es:${error.message}`);
      await state.update({
        esStatus: 'failed',
        lastErrorKey: 'kb.index.syncFailed',
        lastError: `es:${error.message}`,
        esUpdatedAt: new Date()
      });
    }
  }

  // Phase 2: sync vector index with bounded concurrency.
  const vectorCandidates = [];
  for (const chunk of createdChunks) {
    const state = stateMap.get(Number(chunk.id)) || await KbChunkIndexState.findOne({
      where: { chunkId: chunk.id }
    });
    if (!state) continue;
    const needsVectorSync = !reindexOnly || state.vectorStatus !== 'done';
    if (!needsVectorSync) continue;
    vectorCandidates.push({ chunk, state });
  }
  vectorStats.planned = vectorCandidates.length;
  if (!vectorSyncConfig.enabled) {
    for (const { state } of vectorCandidates) {
      await state.update({
        vectorStatus: 'done',
        vectorDocId: null,
        lastErrorKey: null,
        lastError: null,
        vectorUpdatedAt: new Date()
      });
    }
  } else {
    const vectorInputs = vectorCandidates.map(({ chunk }) => buildVectorChunkContent(chunk));
    let vectors = [];
    if (!vectorBootstrapError && vectorInputs.length) {
      vectors = await embeddingService.embedDocuments(vectorInputs);
      if (vectors.length !== vectorInputs.length) {
        throw new Error(`embedding_result_count_mismatch:${vectors.length}:${vectorInputs.length}`);
      }
    }
    const vectorJobs = vectorCandidates.map((item, index) => ({
      ...item,
      vector: vectors[index] || []
    }));
    await runWithWorkerPool(
      vectorJobs,
      vectorSyncConfig.vectorSyncConcurrency,
      async ({ chunk, state, vector }) => {
        const vectorStartAt = Date.now();
        vectorStats.started += 1;
        logKbVector('info', 'sync_start', {
          fileId: file.id,
          chunkId: chunk.id,
          chunkNo: chunk.chunkNo,
          reindexOnly,
          concurrency: vectorSyncConfig.vectorSyncConcurrency
        });
        try {
          if (vectorBootstrapError) throw vectorBootstrapError;
          if (!Array.isArray(vector) || !vector.length) {
            throw new Error('embedding_vector_empty');
          }
          await vectorProvider.upsertChunks({
            file,
            chunks: [chunk],
            tags: uniqueTags,
            vectors: [vector]
          });
          await state.update({
            vectorStatus: 'done',
            vectorDocId: String(chunk.id),
            lastErrorKey: null,
            lastError: null,
            vectorUpdatedAt: new Date()
          });
          logKbVector('info', 'sync_done', {
            fileId: file.id,
            chunkId: chunk.id,
            chunkNo: chunk.chunkNo,
            elapsedMs: Date.now() - vectorStartAt
          });
          vectorStats.done += 1;
        } catch (error) {
          failedMessages.push(`chunk_${chunk.id}_vector:${error.message}`);
          await state.update({
            vectorStatus: 'failed',
            lastErrorKey: 'kb.index.syncFailed',
            lastError: `vector:${error.message}`,
            vectorUpdatedAt: new Date()
          });
          logKbVector('error', 'sync_failed', {
            fileId: file.id,
            chunkId: chunk.id,
            chunkNo: chunk.chunkNo,
            elapsedMs: Date.now() - vectorStartAt,
            error: String(error?.message || error || '')
          });
          vectorStats.failed += 1;
          if (String(error?.message || '').includes('timeout')) vectorStats.timeout += 1;
          else if (String(error?.message || '').includes('qdrant_request_failed:4')) vectorStats.http4xx += 1;
          else if (String(error?.message || '').includes('qdrant_request_failed:5')) vectorStats.http5xx += 1;
          else vectorStats.unknown += 1;
        }
      }
    );
  }
  logKbVector('info', 'sync_summary', {
    fileId: file.id,
    reindexOnly,
    concurrency: vectorSyncConfig.vectorSyncConcurrency,
    ...vectorStats
  });

  const finalStates = await KbChunkIndexState.findAll({
    where: {
      chunkId: {
        [Op.in]: createdChunks.map((chunk) => chunk.id)
      }
    },
    attributes: ['esStatus', 'vectorStatus']
  });
  const indexedCount = countIndexedStates(finalStates, {
    requireVectorSync: vectorSyncConfig.enabled
  });

  if (failedMessages.length) {
    const message = failedMessages.slice(0, 3).join('; ');
    await file.update({
      status: 'index_failed',
      errorMessageKey: 'kb.index.syncFailed',
      errorMessage: message
    });
    await job.update({
      status: 'failed',
      lastErrorKey: 'kb.index.syncFailed',
      lastError: message
    });
    throw new Error(message);
  }

  await file.update({
    status: 'ready',
    errorMessageKey: null,
    errorMessage: null
  });
  await job.update({
    status: 'done',
    lastError: null,
    lastErrorKey: null
  });

  return {
    fileId: file.id,
    kbJobId: job.id,
    chunkCount: chunks.length,
    indexedCount
  };
}

async function listStandardTags({ keyword = '' } = {}) {
  const where = {
    isDeleted: 0,
    status: 1
  };
  if (String(keyword).trim()) {
    where.tagName = {
      [Op.like]: `%${String(keyword).trim().toLowerCase()}%`
    };
  }
  return KbTag.findAll({
    where,
    order: [['tagName', 'ASC']]
  });
}

async function listTagAliases({ status = '', keyword = '' } = {}) {
  const where = {};
  if (status) where.status = status;
  if (String(keyword).trim()) {
    where.aliasName = {
      [Op.like]: `%${String(keyword).trim().toLowerCase()}%`
    };
  }
  return KbTagAlias.findAll({
    where,
    include: [{
      model: KbTag,
      as: 'tag',
      required: false
    }],
    order: [['createdAt', 'DESC']]
  });
}

async function approveTagAlias({ aliasId, targetTagName = '', user }) {
  const operatorId = getOperatorId(user);
  const alias = await KbTagAlias.findByPk(Number(aliasId));
  if (!alias) return null;
  const normalizedTarget = normalizeTag(targetTagName || alias.aliasName);
  if (!normalizedTarget) return null;

  return sequelize.transaction(async (transaction) => {
    let tag = await KbTag.findOne({
      where: {
        normName: normalizedTarget,
        isDeleted: 0
      },
      transaction
    });
    if (!tag) {
      tag = await KbTag.create({
        tagName: normalizedTarget,
        normName: normalizedTarget,
        status: 1,
        createdBy: operatorId,
        updatedBy: operatorId
      }, { transaction });
    }

    await alias.update({
      status: 'approved',
      tagId: tag.id,
      reviewedBy: operatorId,
      reviewedAt: new Date()
    }, { transaction });

    const oldRows = await KbCollectionTag.findAll({
      where: {
        aliasId: alias.id
      },
      transaction
    });
    for (const row of oldRows) {
      await KbCollectionTag.findOrCreate({
        where: {
          collectionId: row.collectionId,
          tagId: tag.id
        },
        defaults: {
          collectionId: row.collectionId,
          tagId: tag.id,
          createdBy: operatorId
        },
        transaction
      });
    }
    await KbCollectionTag.destroy({
      where: {
        aliasId: alias.id
      },
      transaction
    });

    return alias;
  });
}

async function rejectTagAlias({ aliasId, user }) {
  const alias = await KbTagAlias.findByPk(Number(aliasId));
  if (!alias) return null;
  await alias.update({
    status: 'rejected',
    reviewedBy: getOperatorId(user),
    reviewedAt: new Date()
  });
  return alias;
}

module.exports = {
  SUPPORTED_EXTS,
  MAX_COLLECTION_TAGS,
  MAX_TAG_LENGTH,
  normalizeCollectionTags,
  validateCollectionTags,
  normalizeFileExt,
  listCollections,
  createCollection,
  getCollectionById,
  updateCollection,
  deleteCollection,
  listRecycleBinItems,
  restoreRecycleItems,
  submitRecyclePurgeJobs,
  executeRecyclePurgeJob,
  listCollectionFiles,
  listCollectionFilesPaged,
  deleteFile,
  renameFile,
  rebuildFile,
  getFileDownloadInfo,
  submitIngestTask,
  rollbackFailedIngestCreation,
  getJobStatus,
  retrievalDebug,
  runIngestPipeline,
  runWithBackoffRetry,
  splitStructuredBlocksToChunks,
  buildVectorChunkContent,
  listStandardTags,
  listTagAliases,
  approveTagAlias,
  rejectTagAlias
};
