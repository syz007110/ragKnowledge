const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { Op } = require('sequelize');
const axios = require('axios');
const { kbIngestQueue, kbPurgeQueue } = require('../config/queue');
const {
  sequelize,
  KbCollection,
  KbFile,
  KbFileLineage,
  KbChunk,
  KbChunkIndexState,
  KbJob,
  KbTag,
  KbTagAlias,
  KbCollectionTag
} = require('../models');

const SUPPORTED_EXTS = ['md', 'txt', 'docx'];
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

function cleanTextByType(rawText, fileExt) {
  const normalized = String(rawText || '').replace(/\r\n/g, '\n').replace(/\u0000/g, '');
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

function buildRagflowConfig() {
  const enabled = String(process.env.ENABLE_RAGFLOW_SYNC || 'true').toLowerCase() === 'true';
  return {
    enabled,
    baseUrl: String(process.env.RAGFLOW_BASE_URL || '').trim().replace(/\/+$/, ''),
    apiKey: String(process.env.RAGFLOW_API_KEY || '').trim(),
    fallbackDatasetId: String(process.env.RAGFLOW_DATASET_ID || '').trim(),
    datasetPermission: String(process.env.RAGFLOW_DATASET_PERMISSION || 'me').trim() || 'me',
    datasetChunkMethod: String(process.env.RAGFLOW_DATASET_CHUNK_METHOD || 'manual').trim() || 'manual'
  };
}

function getLocalPathFromStorageUri(storageUri = '') {
  const uri = String(storageUri || '');
  if (!uri) return '';
  if (uri.startsWith('file://')) {
    return uri.replace('file://', '');
  }
  if (uri.startsWith('kb://')) return '';
  return path.isAbsolute(uri) ? uri : path.resolve(process.cwd(), uri);
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
  await axios.post(url, {
    query: {
      bool: {
        filter: filters
      }
    }
  }, { auth, timeout: Number(process.env.ES_TIMEOUT_MS || 20000) });
  return { skipped: false };
}

function resolveRagflowDatasetId(collection) {
  const config = buildRagflowConfig();
  if (!config.enabled) return '';
  return String(collection?.ragflowDatasetId || config.fallbackDatasetId || '').trim();
}

async function ragflowJsonRequest({ url, method, body, acceptedStatusCodes = [200] }) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${buildRagflowConfig().apiKey}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!acceptedStatusCodes.includes(response.status)) {
    const text = await response.text();
    throw new Error(`ragflow_http_failed:${response.status}:${text}`);
  }
  return response.json();
}

async function createRagflowDataset({ name, description = '' }) {
  const config = buildRagflowConfig();
  if (!config.enabled) return { skipped: true, datasetId: '' };
  ensureConfig(config, ['baseUrl', 'apiKey'], 'ragflow');
  const body = await ragflowJsonRequest({
    url: `${config.baseUrl}/api/v1/datasets`,
    method: 'POST',
    body: {
      name,
      description: description || '',
      permission: config.datasetPermission,
      chunk_method: config.datasetChunkMethod
    }
  });
  const datasetId = body?.data?.id || body?.data?.dataset_id || '';
  if (!datasetId) {
    throw new Error('ragflow_dataset_id_missing');
  }
  return { skipped: false, datasetId };
}

async function updateRagflowDataset({ datasetId, name, description = '' }) {
  const config = buildRagflowConfig();
  if (!config.enabled || !datasetId) return { skipped: true };
  ensureConfig(config, ['baseUrl', 'apiKey'], 'ragflow');
  await ragflowJsonRequest({
    url: `${config.baseUrl}/api/v1/datasets/${datasetId}`,
    method: 'PUT',
    body: {
      name,
      description: description || ''
    }
  });
  return { skipped: false };
}

async function deleteRagflowDataset(datasetId) {
  const config = buildRagflowConfig();
  if (!config.enabled || !datasetId) return { skipped: true };
  ensureConfig(config, ['baseUrl', 'apiKey'], 'ragflow');
  await ragflowJsonRequest({
    url: `${config.baseUrl}/api/v1/datasets`,
    method: 'DELETE',
    body: {
      ids: [datasetId]
    }
  });
  return { skipped: false };
}

async function uploadRagflowDocument({ datasetId, storageUri, fileName }) {
  const config = buildRagflowConfig();
  if (!config.enabled) return { skipped: true, documentId: '' };
  ensureConfig(config, ['baseUrl', 'apiKey'], 'ragflow');
  if (!datasetId) {
    throw new Error('ragflow_dataset_id_missing');
  }
  const localPath = getLocalPathFromStorageUri(storageUri);
  if (!localPath) {
    throw new Error('ragflow_source_file_missing');
  }
  const blob = await fs.readFile(localPath);
  const formData = new FormData();
  formData.append('file', new Blob([blob]), fileName);
  const response = await fetch(`${config.baseUrl}/api/v1/datasets/${datasetId}/documents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`
    },
    body: formData
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ragflow_document_upload_failed:${response.status}:${text}`);
  }
  const body = await response.json();
  const documentId = body?.data?.[0]?.id || body?.data?.id || '';
  if (!documentId) {
    throw new Error('ragflow_document_id_missing');
  }
  return { skipped: false, documentId };
}

async function deleteRagflowDocument({ datasetId, documentId }) {
  const config = buildRagflowConfig();
  if (!config.enabled || !datasetId || !documentId) return { skipped: true };
  ensureConfig(config, ['baseUrl', 'apiKey'], 'ragflow');
  await ragflowJsonRequest({
    url: `${config.baseUrl}/api/v1/datasets/${datasetId}/documents`,
    method: 'DELETE',
    body: {
      ids: [documentId]
    }
  });
  return { skipped: false };
}

async function updateRagflowDocumentName({ datasetId, documentId, fileName }) {
  const config = buildRagflowConfig();
  if (!config.enabled || !datasetId || !documentId) return { skipped: true };
  ensureConfig(config, ['baseUrl', 'apiKey'], 'ragflow');
  await ragflowJsonRequest({
    url: `${config.baseUrl}/api/v1/datasets/${datasetId}/documents/${documentId}`,
    method: 'PUT',
    body: {
      name: fileName
    }
  });
  return { skipped: false };
}

async function clearRagflowDocumentChunks({ datasetId, documentId }) {
  const config = buildRagflowConfig();
  if (!config.enabled || !datasetId || !documentId) return { skipped: true };
  ensureConfig(config, ['baseUrl', 'apiKey'], 'ragflow');
  await ragflowJsonRequest({
    url: `${config.baseUrl}/api/v1/datasets/${datasetId}/documents/${documentId}/chunks`,
    method: 'DELETE',
    body: {
      delete_all: true
    }
  });
  return { skipped: false };
}

function buildRagflowChunkSession({ collection, file }) {
  const config = buildRagflowConfig();
  if (!config.enabled) {
    return { skipped: true, documentId: '' };
  }
  ensureConfig(config, ['baseUrl', 'apiKey'], 'ragflow');
  const datasetId = resolveRagflowDatasetId(collection);
  if (!datasetId || !file?.ragflowDocumentId) {
    throw new Error('ragflow_binding_missing');
  }
  return {
    skipped: false,
    documentId: file.ragflowDocumentId,
    datasetId,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey
  };
}

async function syncChunkToRagflow({ ragflowSession, chunk, tags }) {
  if (ragflowSession?.skipped) {
    return { skipped: true, vectorDocId: null };
  }
  const payload = {
    content: chunk.chunkText,
    important_keywords: tags.slice(0, 8),
    questions: [],
    tag_kwd: tags.slice(0, 8)
  };
  const response = await fetch(
    `${ragflowSession.baseUrl}/api/v1/datasets/${ragflowSession.datasetId}/documents/${ragflowSession.documentId}/chunks`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ragflowSession.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ragflow_chunk_sync_failed:${response.status}:${text}`);
  }
  const body = await response.json();
  return {
    skipped: false,
    vectorDocId: body?.data?.chunk?.id || ''
  };
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
  let ragflowDatasetId = '';
  try {
    const ragflowResult = await createRagflowDataset({
      name: name.trim(),
      description
    });
    ragflowDatasetId = ragflowResult.datasetId || '';
  } catch (error) {
    error.message = `kb.ragflow.datasetSyncFailed:${error.message}`;
    throw error;
  }
  try {
    return await sequelize.transaction(async (transaction) => {
      const created = await KbCollection.create({
        name: name.trim(),
        code: code.trim(),
        description: description || null,
        ragflowDatasetId: ragflowDatasetId || null,
        createdBy: operatorId,
        updatedBy: operatorId
      }, { transaction });
      await attachTagsToCollection(created.id, finalTags, operatorId, transaction);
      return created;
    });
  } catch (error) {
    await deleteRagflowDataset(ragflowDatasetId).catch(() => null);
    throw error;
  }
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
  try {
    await updateRagflowDataset({
      datasetId: resolveRagflowDatasetId(collection),
      name: nextName,
      description: nextDescription || ''
    });
  } catch (error) {
    error.message = `kb.ragflow.datasetSyncFailed:${error.message}`;
    throw error;
  }
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
  try {
    await deleteRagflowDataset(resolveRagflowDatasetId(collection));
  } catch (error) {
    error.message = `kb.ragflow.datasetSyncFailed:${error.message}`;
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
  const whereCollection = {
    isDeleted: 1,
    deletedAt: {
      [Op.gte]: cutoff
    }
  };
  const whereFile = {
    isDeleted: 1,
    deletedAt: {
      [Op.gte]: cutoff
    }
  };
  if (key) {
    whereCollection.name = { [Op.like]: `%${key}%` };
  }

  const deletedCollections = await KbCollection.findAll({
    where: whereCollection,
    order: [['deletedAt', 'DESC']]
  });
  const deletedCollectionIds = deletedCollections.map((item) => item.id);
  if (!deletedCollectionIds.length) {
    return {
      retentionDays: RECYCLE_RETENTION_DAYS,
      items: []
    };
  }

  whereFile.collectionId = {
    [Op.in]: deletedCollectionIds
  };
  if (key) {
    whereFile.fileName = { [Op.like]: `%${key}%` };
  }

  const deletedFiles = await KbFile.findAll({
    where: whereFile,
    order: [['deletedAt', 'DESC']]
  });

  const groupedFileMap = new Map();
  deletedFiles.forEach((file) => {
    if (!groupedFileMap.has(file.collectionId)) groupedFileMap.set(file.collectionId, []);
    groupedFileMap.get(file.collectionId).push({
      id: file.id,
      collectionId: file.collectionId,
      fileName: file.fileName,
      fileExt: file.fileExt,
      deletedAt: file.deletedAt,
      canRestore: false
    });
  });

  const items = [];
  deletedCollections.forEach((collection) => {
    const collectionId = collection.id;
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

  const uniqueRestoredCollectionIds = Array.from(new Set(restoredResult.restoredCollectionIds));
  const uniqueRestoredFileIds = Array.from(new Set(restoredResult.restoredFileIds));
  const collectionMap = new Map();

  for (const collectionId of uniqueRestoredCollectionIds) {
    const collection = await KbCollection.findByPk(collectionId);
    if (!collection) continue;
    try {
      const ragflowResult = await createRagflowDataset({
        name: collection.name,
        description: collection.description || ''
      });
      if (!ragflowResult.skipped && ragflowResult.datasetId) {
        await collection.update({
          ragflowDatasetId: ragflowResult.datasetId
        });
      }
    } catch (error) {
      error.message = `kb.ragflow.datasetSyncFailed:${error.message}`;
      throw error;
    }
    collectionMap.set(collection.id, collection);
  }

  for (const fileId of uniqueRestoredFileIds) {
    const file = await KbFile.findByPk(fileId);
    if (!file) continue;
    let collection = collectionMap.get(file.collectionId);
    if (!collection) {
      collection = await KbCollection.findByPk(file.collectionId);
      if (collection) collectionMap.set(collection.id, collection);
    }
    if (!collection) continue;
    try {
      const ragflowResult = await uploadRagflowDocument({
        datasetId: resolveRagflowDatasetId(collection),
        storageUri: file.storageUri,
        fileName: file.fileName
      });
      await file.update({
        ragflowDocumentId: ragflowResult.documentId || null,
        status: 'uploaded',
        errorMessage: null,
        errorMessageKey: null,
        updatedBy: operatorId
      });
    } catch (error) {
      error.message = `kb.ragflow.documentSyncFailed:${error.message}`;
      throw error;
    }
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

async function hardDeleteFileById({ fileId, transaction }) {
  const file = await KbFile.findByPk(fileId, { transaction });
  if (!file) return false;

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
  await safeDeleteLocalFile(file.storageUri);
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
      if (vectorStatus === 'done') bucket.vectorDone += 1;
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
    const hasKeyChannelsReady = indexSummary.esStatus === 'done' && indexSummary.vectorStatus === 'done';
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
  const collection = await KbCollection.findByPk(file.collectionId);
  try {
    await deleteRagflowDocument({
      datasetId: resolveRagflowDatasetId(collection),
      documentId: file.ragflowDocumentId
    });
  } catch (error) {
    error.message = `kb.ragflow.documentSyncFailed:${error.message}`;
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
  const collection = await KbCollection.findByPk(file.collectionId);
  try {
    await updateRagflowDocumentName({
      datasetId: resolveRagflowDatasetId(collection),
      documentId: file.ragflowDocumentId,
      fileName: nextName
    });
  } catch (error) {
    error.message = `kb.ragflow.documentSyncFailed:${error.message}`;
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
  const localPath = getLocalPathFromStorageUri(file.storageUri);
  if (!localPath) {
    throw new Error('kb.fileNotFound');
  }
  return {
    file,
    localPath
  };
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
  const ragflowDatasetId = resolveRagflowDatasetId(collection);
  let ragflowDocumentId = null;
  try {
    const ragflowResult = await uploadRagflowDocument({
      datasetId: ragflowDatasetId,
      storageUri,
      fileName: fileName.trim()
    });
    ragflowDocumentId = ragflowResult.documentId || null;
  } catch (error) {
    error.message = `kb.ragflow.documentSyncFailed:${error.message}`;
    throw error;
  }

  try {
    const file = await KbFile.create({
      collectionId,
      fileName: fileName.trim(),
      fileExt: normalizedExt,
      mimeType: mimeType || null,
      fileSize: Number(fileSize || 0),
      storageUri: storageUri || `kb://${collectionId}/${Date.now()}-${fileName}`,
      contentSha256: contentHash,
      ragflowDocumentId,
      uploadMode,
      versionNo,
      status: 'uploaded',
      createdBy: operatorId,
      updatedBy: operatorId
    });

    if (existing && uploadMode === 'force_version') {
      await KbFileLineage.create({
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

    const queueJob = await kbIngestQueue.add(
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

    await jobRecord.update({
      payloadJson: {
        ...(jobRecord.payloadJson || {}),
        queueJobId: queueJob.id
      }
    });

    return {
      file,
      jobRecord,
      queueJobId: queueJob.id
    };
  } catch (error) {
    await deleteRagflowDocument({
      datasetId: ragflowDatasetId,
      documentId: ragflowDocumentId
    }).catch(() => null);
    throw error;
  }
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

async function runIngestPipeline({ fileId, kbJobId, rawText = '' }) {
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
  await file.update({
    status: 'parsing',
    errorMessageKey: null,
    errorMessage: null
  });

  const chunks = splitTextToChunks(cleanedText, { fileExt });
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

  let createdChunks = [];
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
    }

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
          parser: fileExt === 'txt' ? 'txt_v1' : 'plain_text',
          cleaner: fileExt,
          version: 3,
          headingPath: item.headingPath || []
        }
      })),
      { transaction }
    );

    await KbChunkIndexState.bulkCreate(
      createdChunks.map((chunk) => ({
        chunkId: chunk.id,
        esStatus: 'pending',
        vectorStatus: 'pending'
      })),
      { transaction }
    );
  });

  await file.update({ status: 'indexing' });

  let esBootstrapError = null;
  try {
    // Ensure ES behaves as "replace on rebuild/ingest" by
    // removing previous docs for the same file before indexing new chunks.
    await deleteEsDocsByQuery({ fileId: file.id });
  } catch (error) {
    esBootstrapError = error;
  }

  let ragflowSession = { skipped: true, documentId: '' };
  let ragflowBootstrapError = null;
  try {
    ragflowSession = buildRagflowChunkSession({ collection, file });
    await clearRagflowDocumentChunks({
      datasetId: ragflowSession.datasetId,
      documentId: ragflowSession.documentId
    });
  } catch (error) {
    ragflowBootstrapError = error;
  }
  let indexedCount = 0;
  const failedMessages = [];
  for (const chunk of createdChunks) {
    let chunkFailed = false;
    const state = await KbChunkIndexState.findOne({
      where: { chunkId: chunk.id }
    });
    if (!state) continue;

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
      chunkFailed = true;
      failedMessages.push(`chunk_${chunk.id}_es:${error.message}`);
      await state.update({
        esStatus: 'failed',
        lastErrorKey: 'kb.index.syncFailed',
        lastError: `es:${error.message}`,
        esUpdatedAt: new Date()
      });
    }

    try {
      if (ragflowBootstrapError) throw ragflowBootstrapError;
      const vectorResult = await syncChunkToRagflow({ ragflowSession, chunk, tags: uniqueTags });
      await state.update({
        vectorStatus: 'done',
        vectorDocId: vectorResult.vectorDocId || ragflowSession.documentId,
        lastErrorKey: null,
        lastError: null,
        vectorUpdatedAt: new Date()
      });
    } catch (error) {
      chunkFailed = true;
      failedMessages.push(`chunk_${chunk.id}_vector:${error.message}`);
      await state.update({
        vectorStatus: 'failed',
        lastErrorKey: 'kb.index.syncFailed',
        lastError: `vector:${error.message}`,
        vectorUpdatedAt: new Date()
      });
    }

    if (!chunkFailed) {
      indexedCount += 1;
    }
  }

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
  getJobStatus,
  runIngestPipeline,
  listStandardTags,
  listTagAliases,
  approveTagAlias,
  rejectTagAlias
};
