const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

/**
 * Document-service routing (optional dual pool):
 * - KB_DOCUMENT_SERVICE_URL — CPU pool base URL (required when enabled).
 * - KB_DOCUMENT_SERVICE_CPU_URL — overrides CPU pool URL if set.
 * - KB_DOCUMENT_SERVICE_GPU_URL — optional; PDF parse only when set (same API as CPU instance).
 * - KB_DOCUMENT_SERVICE_CPU_CONCURRENCY — max concurrent outbound calls to CPU pool
 *   (default: max(2, KB_QUEUE_CONCURRENCY) so ingest workers are not all blocked on one pool).
 * - KB_DOCUMENT_SERVICE_GPU_CONCURRENCY — max concurrent outbound calls to GPU pool (default 1).
 * - KB_DOCUMENT_SERVICE_DISABLE_CALL_LIMITERS=1 — bypass limiters (troubleshooting only).
 *
 * GPU/CPU are separate processes (or containers), not mixed uvicorn workers in one process.
 */

function createPassthroughLimiter() {
  return {
    async run(fn) {
      return fn();
    }
  };
}

function createConcurrencyLimiter(maxConcurrent) {
  const max = Math.max(1, Number(maxConcurrent) || 1);
  let running = 0;
  const waiters = [];

  async function acquire() {
    if (running < max) {
      running += 1;
      return;
    }
    await new Promise((resolve) => {
      waiters.push(resolve);
    });
    running += 1;
  }

  function release() {
    running -= 1;
    if (waiters.length > 0) {
      const resolve = waiters.shift();
      resolve();
    }
  }

  return {
    async run(fn) {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    }
  };
}

function getCpuConcurrency() {
  const explicit = Number.parseInt(String(process.env.KB_DOCUMENT_SERVICE_CPU_CONCURRENCY || ''), 10);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const qc = Number.parseInt(String(process.env.KB_QUEUE_CONCURRENCY || '2'), 10);
  const inferred = Math.max(2, Number.isFinite(qc) && qc > 0 ? qc : 2);
  return inferred;
}

function getGpuConcurrency() {
  const n = Number.parseInt(String(process.env.KB_DOCUMENT_SERVICE_GPU_CONCURRENCY || '1'), 10);
  return Math.max(1, Number.isFinite(n) ? n : 1);
}

const documentServiceLimitersBypass = String(process.env.KB_DOCUMENT_SERVICE_DISABLE_CALL_LIMITERS || '').trim() === '1';

const cpuCallLimiter = documentServiceLimitersBypass
  ? createPassthroughLimiter()
  : createConcurrencyLimiter(getCpuConcurrency());
let gpuCallLimiter = null;

function getGpuCallLimiter() {
  if (documentServiceLimitersBypass) {
    return createPassthroughLimiter();
  }
  if (!getGpuDocumentServiceBaseUrl()) {
    return null;
  }
  if (!gpuCallLimiter) {
    gpuCallLimiter = createConcurrencyLimiter(getGpuConcurrency());
  }
  return gpuCallLimiter;
}

function normalizeBaseUrl(raw) {
  return String(raw || '').trim().replace(/\/+$/, '');
}

function getCpuDocumentServiceBaseUrl() {
  const explicit = normalizeBaseUrl(process.env.KB_DOCUMENT_SERVICE_CPU_URL);
  if (explicit) return explicit;
  return normalizeBaseUrl(process.env.KB_DOCUMENT_SERVICE_URL);
}

function getGpuDocumentServiceBaseUrl() {
  return normalizeBaseUrl(process.env.KB_DOCUMENT_SERVICE_GPU_URL);
}

function isPdfParseOnGpu(fileExt) {
  const ext = String(fileExt || '').trim().toLowerCase().replace(/^\./, '');
  return ext === 'pdf';
}

/**
 * Ingest-time parsing runs only against the Python document-service.
 * Configure KB_DOCUMENT_SERVICE_URL (no feature flag).
 */
function isDocumentServiceEnabled() {
  return Boolean(getCpuDocumentServiceBaseUrl());
}

function getDocumentServiceBaseUrl() {
  return getCpuDocumentServiceBaseUrl();
}

function getDocumentServiceHeaders() {
  const apiKey = String(process.env.KB_DOCUMENT_SERVICE_API_KEY || '').trim();
  return apiKey ? { 'X-Internal-Api-Key': apiKey } : {};
}

function getDocumentServiceTimeoutMs() {
  // Default 5m: PDF + layout on CPU often exceeds 2m; override with KB_DOCUMENT_SERVICE_TIMEOUT_MS.
  return Math.max(1000, Number.parseInt(process.env.KB_DOCUMENT_SERVICE_TIMEOUT_MS || '300000', 10) || 300000);
}

async function parseByDocumentService({ absPath, fileExt = '' }) {
  const cpuUrl = getCpuDocumentServiceBaseUrl();
  if (!cpuUrl) return null;
  const payload = await fs.readFile(absPath);
  const form = new FormData();
  form.append('file', payload, {
    filename: path.basename(absPath) || `upload.${fileExt || 'txt'}`,
    contentType: 'application/octet-stream'
  });
  if (fileExt) {
    form.append('fileExt', String(fileExt));
  }
  const postParse = async (baseUrl) => {
    const response = await axios.post(`${baseUrl}/internal/v1/parse`, form, {
      headers: {
        ...form.getHeaders(),
        ...getDocumentServiceHeaders()
      },
      timeout: getDocumentServiceTimeoutMs(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true
    });
    if (response.status < 200 || response.status >= 300) {
      const detail = typeof response.data === 'object' && response.data?.detail
        ? JSON.stringify(response.data.detail)
        : String(response.status);
      throw new Error(`document_service_http_${response.status}:${detail}`);
    }
    const data = response.data || {};
    return {
      parseDocument: data.parseDocument && typeof data.parseDocument === 'object' ? data.parseDocument : null,
      embeddedImagePayloads: data.embeddedImagePayloads && typeof data.embeddedImagePayloads === 'object'
        ? data.embeddedImagePayloads
        : {}
    };
  };

  const gpuUrl = getGpuDocumentServiceBaseUrl();
  if (isPdfParseOnGpu(fileExt) && gpuUrl) {
    const gpuLim = getGpuCallLimiter();
    return gpuLim.run(() => postParse(gpuUrl));
  }
  return cpuCallLimiter.run(() => postParse(cpuUrl));
}

async function cleanByDocumentService(parseDocument) {
  const baseUrl = getCpuDocumentServiceBaseUrl();
  if (!baseUrl) throw new Error('kb.parser.documentServiceUnavailable');
  return cpuCallLimiter.run(async () => {
    const response = await axios.post(
      `${baseUrl}/internal/v1/clean`,
      { parseDocument: parseDocument || {} },
      {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...getDocumentServiceHeaders()
        },
        timeout: getDocumentServiceTimeoutMs(),
        validateStatus: () => true
      }
    );
    if (response.status < 200 || response.status >= 300) {
      const detail = typeof response.data === 'object' && response.data?.detail
        ? JSON.stringify(response.data.detail)
        : String(response.status);
      throw new Error(`document_service_http_${response.status}:${detail}`);
    }
    return response.data || {};
  });
}

async function normalizeByDocumentService(text, fileExt = '') {
  const baseUrl = getCpuDocumentServiceBaseUrl();
  if (!baseUrl) throw new Error('kb.parser.documentServiceUnavailable');
  return cpuCallLimiter.run(async () => {
    const response = await axios.post(
      `${baseUrl}/internal/v1/normalize`,
      { text: String(text || ''), fileExt: String(fileExt || '') },
      {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...getDocumentServiceHeaders()
        },
        timeout: getDocumentServiceTimeoutMs(),
        validateStatus: () => true
      }
    );
    if (response.status < 200 || response.status >= 300) {
      const detail = typeof response.data === 'object' && response.data?.detail
        ? JSON.stringify(response.data.detail)
        : String(response.status);
      throw new Error(`document_service_http_${response.status}:${detail}`);
    }
    const data = response.data || {};
    return { cleanedText: String(data.cleanedText || '') };
  });
}

async function plainTextFromPages(pages = []) {
  const baseUrl = getCpuDocumentServiceBaseUrl();
  if (!baseUrl) throw new Error('kb.parser.documentServiceUnavailable');
  return cpuCallLimiter.run(async () => {
    const response = await axios.post(
      `${baseUrl}/internal/v1/plain-from-pages`,
      { pages: Array.isArray(pages) ? pages : [] },
      {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...getDocumentServiceHeaders()
        },
        timeout: getDocumentServiceTimeoutMs(),
        validateStatus: () => true
      }
    );
    if (response.status < 200 || response.status >= 300) {
      const detail = typeof response.data === 'object' && response.data?.detail
        ? JSON.stringify(response.data.detail)
        : String(response.status);
      throw new Error(`document_service_http_${response.status}:${detail}`);
    }
    const data = response.data || {};
    return { plainText: String(data.plainText || '') };
  });
}

async function chunkByDocumentService({ mode = 'text', text = '', blocks = [], maxChunkSize = 800 } = {}) {
  const baseUrl = getCpuDocumentServiceBaseUrl();
  if (!baseUrl) throw new Error('kb.parser.documentServiceUnavailable');
  return cpuCallLimiter.run(async () => {
    const body = {
      mode: String(mode).toLowerCase() === 'structured' ? 'structured' : 'text',
      text: String(text || ''),
      blocks: Array.isArray(blocks) ? blocks : [],
      maxChunkSize: Math.max(200, Number(maxChunkSize) || 800)
    };
    const response = await axios.post(`${baseUrl}/internal/v1/chunk`, body, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ...getDocumentServiceHeaders()
      },
      timeout: getDocumentServiceTimeoutMs(),
      validateStatus: () => true
    });
    if (response.status < 200 || response.status >= 300) {
      const detail = typeof response.data === 'object' && response.data?.detail
        ? JSON.stringify(response.data.detail)
        : String(response.status);
      throw new Error(`document_service_http_${response.status}:${detail}`);
    }
    const data = response.data || {};
    const chunks = Array.isArray(data.chunks) ? data.chunks : [];
    return chunks;
  });
}

/**
 * After clean: structured chunk if chunkView.blocks exist, else plain text from pages → normalize → chunk.
 */
async function chunkFromCleanedDocument(cleanedDocument, { fileExt = '', maxChunkSize = 800 } = {}) {
  const cleaned = cleanedDocument && typeof cleanedDocument === 'object' ? cleanedDocument : {};
  const chunkView = cleaned.chunkView && typeof cleaned.chunkView === 'object' ? cleaned.chunkView : {};
  const blocks = Array.isArray(chunkView.blocks) ? chunkView.blocks : [];
  if (blocks.length) {
    return chunkByDocumentService({
      mode: 'structured',
      blocks,
      maxChunkSize
    });
  }
  const plain = await plainTextFromPages(cleaned.pages || []);
  const norm = await normalizeByDocumentService(plain.plainText, fileExt);
  const t = String(norm.cleanedText || '').trim();
  if (!t) {
    return [];
  }
  return chunkByDocumentService({
    mode: 'text',
    text: t,
    maxChunkSize
  });
}

/**
 * Direct ingest: normalize user text then plain chunk.
 */
async function chunkFromDirectRawText(rawText, fileExt, maxChunkSize = 800) {
  const norm = await normalizeByDocumentService(rawText, fileExt);
  const t = String(norm.cleanedText || '').trim();
  if (!t) {
    return [];
  }
  return chunkByDocumentService({
    mode: 'text',
    text: t,
    maxChunkSize
  });
}

/**
 * Build preview plain text from parseDocument (pages tree).
 */
async function buildPreviewPlainText(parseDocument, fileExt) {
  const pd = parseDocument && typeof parseDocument === 'object' ? parseDocument : {};
  const plain = await plainTextFromPages(pd.pages || []);
  const norm = await normalizeByDocumentService(plain.plainText, fileExt);
  return String(norm.cleanedText || '');
}

module.exports = {
  isDocumentServiceEnabled,
  getDocumentServiceBaseUrl,
  parseByDocumentService,
  cleanByDocumentService,
  normalizeByDocumentService,
  plainTextFromPages,
  chunkByDocumentService,
  chunkFromCleanedDocument,
  chunkFromDirectRawText,
  buildPreviewPlainText
};
