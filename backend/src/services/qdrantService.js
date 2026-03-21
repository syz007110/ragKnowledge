const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 30000;

function buildQdrantConfig() {
  return {
    enabled: String(process.env.ENABLE_QDRANT_SYNC || 'true').toLowerCase() !== 'false',
    baseUrl: String(process.env.QDRANT_URL || '').trim().replace(/\/$/, ''),
    apiKey: String(process.env.QDRANT_API_KEY || '').trim(),
    collectionName: String(process.env.QDRANT_COLLECTION || 'kb_chunks').trim(),
    dimensions: Number(process.env.EMBEDDING_DIMENSIONS || 0) || 0,
    distance: String(process.env.QDRANT_DISTANCE || 'Cosine').trim(),
    timeoutMs: Number(process.env.QDRANT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS
  };
}

function ensureQdrantConfig(config) {
  if (!config.enabled) return;
  const missing = [];
  if (!config.baseUrl) missing.push('QDRANT_URL');
  if (!config.collectionName) missing.push('QDRANT_COLLECTION');
  if (!config.dimensions) missing.push('EMBEDDING_DIMENSIONS');
  if (missing.length) {
    throw new Error(`qdrant_config_missing:${missing.join(',')}`);
  }
}

function formatUuidFromHex(hex = '') {
  const value = String(hex || '').padEnd(32, '0').slice(0, 32);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function isUuid(value = '') {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim());
}

function normalizeQdrantPointId(rawId) {
  if (Number.isSafeInteger(rawId) && Number(rawId) >= 0) {
    return Number(rawId);
  }
  const text = String(rawId || '').trim();
  if (isUuid(text)) {
    return text;
  }
  if (/^\d+$/.test(text)) {
    const parsed = Number(text);
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  const digest = crypto.createHash('sha256').update(text || '0', 'utf8').digest('hex');
  return formatUuidFromHex(digest);
}

async function qdrantRequest(url, { method = 'GET', body, apiKey = '', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  try {
    const response = await fetch(url, {
      method,
      headers: {
        ...(apiKey ? { 'api-key': apiKey } : {}),
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`qdrant_request_failed:${response.status}:${text}`);
    }
    if (response.status === 204) return {};
    return response.json();
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`qdrant_request_timeout:${timeoutMs}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function buildQdrantPoint({ chunk, file, tags = [], vector = [] }) {
  const metaJson = chunk?.metaJson || {};
  return {
    id: normalizeQdrantPointId(chunk?.id),
    vector,
    payload: {
      collection_id: String(file?.collectionId || ''),
      file_id: String(file?.id || ''),
      file_name: String(file?.fileName || ''),
      file_ext: String(file?.fileExt || ''),
      chunk_no: Number(chunk?.chunkNo || 0),
      content: String(chunk?.chunkText || ''),
      heading_path: Array.isArray(metaJson.headingPath) ? metaJson.headingPath : [],
      heading_path_text: Array.isArray(metaJson.headingPath) ? metaJson.headingPath.join(' / ') : '',
      chunk_type: String(metaJson.chunkType || 'paragraph'),
      row_kv_text: String(metaJson.rowKvText || ''),
      sheet_name: String(metaJson.sheetName || ''),
      table_id: String(metaJson.tableId || ''),
      row_index: Number(metaJson.rowIndex || 0),
      tags: Array.isArray(tags) ? tags : [],
      page_no: Number(metaJson.pageNo || 0) || null,
      source_type: String(metaJson.sourceType || file?.fileExt || '').trim() || null,
      block_type: String(metaJson.blockType || metaJson.chunkType || '').trim() || null,
      section_path: Array.isArray(metaJson.sectionPath) ? metaJson.sectionPath : [],
      is_ocr: Boolean(metaJson.isOcr)
    }
  };
}

function buildQdrantSearchFilter({
  collectionId,
  fileId = null,
  tags = [],
  pageNo = null,
  sourceType = '',
  blockType = ''
}) {
  const must = [
    { key: 'collection_id', match: { value: String(collectionId || '') } }
  ];
  if (String(fileId || '').trim()) {
    must.push({ key: 'file_id', match: { value: String(fileId).trim() } });
  }
  if (Array.isArray(tags) && tags.length) {
    must.push({ key: 'tags', match: { any: tags } });
  }
  if (Number.isFinite(Number(pageNo)) && Number(pageNo) > 0) {
    must.push({ key: 'page_no', match: { value: Number(pageNo) } });
  }
  if (String(sourceType || '').trim()) {
    must.push({ key: 'source_type', match: { value: String(sourceType).trim() } });
  }
  if (String(blockType || '').trim()) {
    must.push({ key: 'block_type', match: { value: String(blockType).trim() } });
  }
  return { must };
}

async function ensureQdrantCollection() {
  const config = buildQdrantConfig();
  if (!config.enabled) return { skipped: true };
  ensureQdrantConfig(config);
  try {
    await qdrantRequest(`${config.baseUrl}/collections/${encodeURIComponent(config.collectionName)}`, {
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs
    });
    return { skipped: false, created: false };
  } catch (error) {
    if (!String(error.message || '').includes('qdrant_request_failed:404:')) {
      throw error;
    }
  }
  await qdrantRequest(`${config.baseUrl}/collections/${encodeURIComponent(config.collectionName)}`, {
    method: 'PUT',
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    body: {
      vectors: {
        size: config.dimensions,
        distance: config.distance
      }
    }
  });
  return { skipped: false, created: true };
}

async function upsertQdrantPoints(points = []) {
  const config = buildQdrantConfig();
  if (!config.enabled || !points.length) return { skipped: true };
  ensureQdrantConfig(config);
  await qdrantRequest(`${config.baseUrl}/collections/${encodeURIComponent(config.collectionName)}/points?wait=true`, {
    method: 'PUT',
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    body: { points }
  });
  return { skipped: false, count: points.length };
}

async function searchQdrantPoints({ vector, filter, limit = 30, withPayload = true }) {
  const config = buildQdrantConfig();
  if (!config.enabled) return { skipped: true, result: [] };
  ensureQdrantConfig(config);
  const body = await qdrantRequest(`${config.baseUrl}/collections/${encodeURIComponent(config.collectionName)}/points/search`, {
    method: 'POST',
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    body: {
      vector,
      filter,
      limit: Math.max(1, Math.min(100, Number(limit) || 30)),
      with_payload: withPayload
    }
  });
  return {
    skipped: false,
    result: Array.isArray(body?.result) ? body.result : []
  };
}

function isQdrantCollectionMissingError(error) {
  const msg = String(error?.message || '');
  return msg.includes('qdrant_request_failed:404:');
}

async function deleteQdrantPointsByFilter(filter) {
  const config = buildQdrantConfig();
  if (!config.enabled) return { skipped: true };
  ensureQdrantConfig(config);
  try {
    await qdrantRequest(`${config.baseUrl}/collections/${encodeURIComponent(config.collectionName)}/points/delete?wait=true`, {
      method: 'POST',
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs,
      body: { filter }
    });
  } catch (error) {
    if (isQdrantCollectionMissingError(error)) {
      return { skipped: true, collectionMissing: true };
    }
    throw error;
  }
  return { skipped: false };
}

async function setQdrantPayloadByFilter({ payload, filter }) {
  const config = buildQdrantConfig();
  if (!config.enabled) return { skipped: true };
  ensureQdrantConfig(config);
  await qdrantRequest(`${config.baseUrl}/collections/${encodeURIComponent(config.collectionName)}/points/payload?wait=true`, {
    method: 'POST',
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    body: { payload, filter }
  });
  return { skipped: false };
}

module.exports = {
  buildQdrantConfig,
  ensureQdrantConfig,
  buildQdrantPoint,
  buildQdrantSearchFilter,
  ensureQdrantCollection,
  upsertQdrantPoints,
  searchQdrantPoints,
  deleteQdrantPointsByFilter,
  setQdrantPayloadByFilter
};
