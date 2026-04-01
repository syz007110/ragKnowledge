const fs = require('fs/promises');
const axios = require('axios');
const FormData = require('form-data');

function isLayoutEnabled() {
  const v = String(process.env.KB_LAYOUT_ENABLED || '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

/**
 * POST PDF to layout sidecar; returns { rawText, pdf: { blocks, assets, parserKind } } or null.
 */
async function fetchPdfLayoutFromService(absPath) {
  const base = String(process.env.KB_LAYOUT_SERVICE_URL || '').trim().replace(/\/+$/, '');
  if (!base) {
    return null;
  }
  const timeout = Math.max(
    1000,
    Number.parseInt(process.env.KB_LAYOUT_TIMEOUT_MS || '120000', 10) || 120000
  );
  const buf = await fs.readFile(absPath);
  const form = new FormData();
  form.append('file', buf, { filename: 'document.pdf', contentType: 'application/pdf' });
  const response = await axios.post(`${base}/v1/layout/pdf`, form, {
    headers: form.getHeaders(),
    timeout,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true
  });
  if (response.status < 200 || response.status >= 300) {
    const detail = typeof response.data === 'object' && response.data?.detail
      ? JSON.stringify(response.data.detail)
      : String(response.status);
    throw new Error(`layout_http_${response.status}: ${detail}`);
  }
  const data = response.data;
  if (!data || !data.pdf || !Array.isArray(data.pdf.blocks) || !data.pdf.blocks.length) {
    return null;
  }
  return data;
}

module.exports = {
  isLayoutEnabled,
  fetchPdfLayoutFromService
};
