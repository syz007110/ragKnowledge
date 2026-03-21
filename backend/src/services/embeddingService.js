const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_BATCH_SIZE = 16;

function buildEmbeddingConfig() {
  return {
    enabled: String(process.env.ENABLE_EMBEDDING || 'true').toLowerCase() !== 'false',
    baseUrl: String(process.env.EMBEDDING_BASE_URL || '').trim().replace(/\/$/, ''),
    apiKey: String(process.env.EMBEDDING_API_KEY || '').trim(),
    model: String(process.env.EMBEDDING_MODEL || '').trim(),
    dimensions: Number(process.env.EMBEDDING_DIMENSIONS || 0) || 0,
    timeoutMs: Number(process.env.EMBEDDING_TIMEOUT_MS || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    batchSize: Math.max(1, Number(process.env.EMBEDDING_BATCH_SIZE || DEFAULT_BATCH_SIZE) || DEFAULT_BATCH_SIZE)
  };
}

function ensureEmbeddingConfig(config) {
  if (!config.enabled) return;
  const missing = [];
  if (!config.baseUrl) missing.push('EMBEDDING_BASE_URL');
  if (!config.apiKey) missing.push('EMBEDDING_API_KEY');
  if (!config.model) missing.push('EMBEDDING_MODEL');
  if (missing.length) {
    throw new Error(`embedding_config_missing:${missing.join(',')}`);
  }
}

function normalizeEmbeddingsResponse(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : [];
  return data.map((item) => item?.embedding).filter((embedding) => Array.isArray(embedding));
}

async function requestEmbeddings(input) {
  const config = buildEmbeddingConfig();
  if (!config.enabled) return [];
  ensureEmbeddingConfig(config);
  const response = await fetch(`${config.baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.model,
      input,
      ...(config.dimensions ? { dimensions: config.dimensions } : {})
    })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`embedding_request_failed:${response.status}:${text}`);
  }
  const body = await response.json();
  return normalizeEmbeddingsResponse(body);
}

function chunkArray(items = [], size = DEFAULT_BATCH_SIZE) {
  const list = Array.isArray(items) ? items : [];
  const chunks = [];
  for (let index = 0; index < list.length; index += size) {
    chunks.push(list.slice(index, index + size));
  }
  return chunks;
}

function createEmbeddingService() {
  return {
    async embedQuery(text) {
      const safeText = String(text || '').trim();
      if (!safeText) return [];
      const vectors = await requestEmbeddings(safeText);
      return vectors[0] || [];
    },
    async embedDocuments(texts = []) {
      const safeTexts = (texts || []).map((item) => String(item || '')).filter((item) => item.trim());
      if (!safeTexts.length) return [];
      const config = buildEmbeddingConfig();
      const batches = chunkArray(safeTexts, config.batchSize);
      const vectors = [];
      for (const batch of batches) {
        const batchVectors = await requestEmbeddings(batch);
        vectors.push(...batchVectors);
      }
      return vectors;
    }
  };
}

module.exports = {
  buildEmbeddingConfig,
  ensureEmbeddingConfig,
  normalizeEmbeddingsResponse,
  createEmbeddingService
};
