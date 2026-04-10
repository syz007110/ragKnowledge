const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

/**
 * Ingest-time file parsing runs only against the Python document-service.
 * Configure KB_DOCUMENT_SERVICE_URL (no feature flag).
 */
function isDocumentServiceEnabled() {
  const base = String(process.env.KB_DOCUMENT_SERVICE_URL || '').trim();
  return Boolean(base);
}

function getDocumentServiceBaseUrl() {
  return String(process.env.KB_DOCUMENT_SERVICE_URL || '').trim().replace(/\/+$/, '');
}

function getDocumentServiceHeaders() {
  const apiKey = String(process.env.KB_DOCUMENT_SERVICE_API_KEY || '').trim();
  return apiKey ? { 'X-Internal-Api-Key': apiKey } : {};
}

function getDocumentServiceTimeoutMs() {
  return Math.max(1000, Number.parseInt(process.env.KB_DOCUMENT_SERVICE_TIMEOUT_MS || '120000', 10) || 120000);
}

async function parseByDocumentService({ absPath, fileExt = '' }) {
  const baseUrl = getDocumentServiceBaseUrl();
  if (!baseUrl) return null;
  const payload = await fs.readFile(absPath);
  const form = new FormData();
  form.append('file', payload, {
    filename: path.basename(absPath) || `upload.${fileExt || 'txt'}`,
    contentType: 'application/octet-stream'
  });
  if (fileExt) {
    form.append('fileExt', String(fileExt));
  }
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
    rawText: String(data.rawText || ''),
    docx: data.docx || null,
    xlsx: data.xlsx || null,
    pdf: data.pdf || null,
    parseDocument: data.parseDocument || null
  };
}

module.exports = {
  isDocumentServiceEnabled,
  parseByDocumentService
};

