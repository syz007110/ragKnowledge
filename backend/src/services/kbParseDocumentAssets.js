const path = require('path');
const fs = require('fs/promises');
const {
  buildStorageConfig,
  ensureStorageConfig,
  buildUploadObjectKey,
  uploadBuffer,
  deleteObjectByUri,
  isS3Uri
} = require('./objectStorageService');
const kbStorage = require('../config/kbStorage');

/**
 * Upload embedded image payloads to object storage (or local) and set parseDocument.assets[].storageUri.
 * Keys in embeddedImagePayloads match parseDocument.assets[].id and chunkView imageKey.
 *
 * @param {object} params
 * @param {import('../models').KbFile} params.file
 * @param {Record<string, any>} params.parseDocument
 * @param {Record<string, any>} params.embeddedImagePayloads
 * @returns {Promise<Record<string, any>>}
 */
async function uploadEmbeddedPayloadsAndRefillParseDocument({
  file,
  parseDocument,
  embeddedImagePayloads = {}
}) {
  const pd = parseDocument && typeof parseDocument === 'object' ? { ...parseDocument } : {};
  const payloads = embeddedImagePayloads && typeof embeddedImagePayloads === 'object'
    ? embeddedImagePayloads
    : {};
  const entries = Object.entries(payloads).filter(([k, v]) => k && v && typeof v === 'object');
  if (!entries.length) {
    return pd;
  }

  const storageConfig = buildStorageConfig();
  const assetsDir = path.resolve(kbStorage.LOCAL_DIR, 'assets');
  await fs.mkdir(assetsDir, { recursive: true });

  const assets = Array.isArray(pd.assets) ? [...pd.assets] : [];
  const byId = new Map(assets.map((a) => [String(a.id || '').trim(), a]));

  for (const [assetId, payload] of entries) {
    const id = String(assetId || '').trim();
    const b64 = String(payload.base64 || '').trim();
    if (!id || !b64) continue;

    let buffer;
    try {
      buffer = Buffer.from(b64, 'base64');
    } catch {
      continue;
    }
    if (!buffer.length) continue;

    const contentType = String(payload.contentType || 'application/octet-stream').trim();
    const ext = path.extname(id) || '.bin';
    const safeBase = path.basename(file.fileName || 'file', path.extname(file.fileName || ''));
    const objectName = `${safeBase}-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`;

    let storageUri = '';
    if (storageConfig.enabled) {
      try {
        ensureStorageConfig(storageConfig);
        const objectKey = buildUploadObjectKey({
          collectionId: file.collectionId,
          fileName: objectName
        });
        storageUri = await uploadBuffer({
          buffer,
          objectKey,
          contentType
        });
      } catch {
        const localPath = path.resolve(assetsDir, objectName);
        await fs.writeFile(localPath, buffer);
        storageUri = `file://${localPath}`;
      }
    } else {
      const localPath = path.resolve(assetsDir, objectName);
      await fs.writeFile(localPath, buffer);
      storageUri = `file://${localPath}`;
    }

    const row = byId.get(id) || { id, kind: 'image' };
    row.storageUri = storageUri;
    if (!row.mimeType && contentType) {
      row.mimeType = contentType;
    }
    byId.set(id, row);
  }

  pd.assets = Array.from(byId.values());
  return pd;
}

async function deleteStoredUriBestEffort(uri = '') {
  const s = String(uri || '').trim();
  if (!s) return;
  if (isS3Uri(s)) {
    await deleteObjectByUri(s).catch(() => null);
    return;
  }
  if (s.startsWith('file://')) {
    await fs.unlink(s.replace(/^file:\/\//, '')).catch(() => null);
  }
}

/**
 * After parse (and optional image refill), before Python clean: persist parseDocument JSON
 * to object storage or local dir, then set kb_file.normalized_json_uri and increment kb_file.parse_version.
 *
 * @param {object} params
 * @param {import('../models').KbFile} params.file
 * @param {Record<string, any>} params.parseDocument
 */
async function persistNormalizedParseJsonArtifact({ file, parseDocument }) {
  if (!file || typeof file.update !== 'function') return;
  if (!parseDocument || typeof parseDocument !== 'object') return;

  let buffer;
  try {
    buffer = Buffer.from(JSON.stringify(parseDocument), 'utf8');
  } catch (error) {
    const err = new Error(`kb.parseJsonSerialize:${String(error?.message || error)}`);
    err.cause = error;
    throw err;
  }

  const storageConfig = buildStorageConfig();
  const parseDir = path.resolve(kbStorage.LOCAL_DIR, 'parse-json');
  await fs.mkdir(parseDir, { recursive: true });

  const safeBase = path.basename(file.fileName || 'file', path.extname(file.fileName || ''))
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, '_')
    .slice(0, 60) || 'file';
  const objectName = `${safeBase}-${file.id}-${Date.now()}-${Math.round(Math.random() * 1e6)}.json`;

  let storageUri = '';
  if (storageConfig.enabled) {
    try {
      ensureStorageConfig(storageConfig);
      const objectKey = buildUploadObjectKey({
        collectionId: file.collectionId,
        fileName: objectName
      });
      storageUri = await uploadBuffer({
        buffer,
        objectKey,
        contentType: 'application/json; charset=utf-8'
      });
    } catch {
      const localPath = path.resolve(parseDir, objectName);
      await fs.writeFile(localPath, buffer);
      storageUri = `file://${localPath}`;
    }
  } else {
    const localPath = path.resolve(parseDir, objectName);
    await fs.writeFile(localPath, buffer);
    storageUri = `file://${localPath}`;
  }

  const previousUri = String(file.normalizedJsonUri || '').trim();
  const basePv = Number(file.parseVersion);
  const base = Number.isFinite(basePv) && basePv >= 1 ? basePv : 1;
  const nextParseVersion = base + 1;
  await file.update({
    normalizedJsonUri: storageUri,
    parseVersion: nextParseVersion
  });
  file.normalizedJsonUri = storageUri;
  file.parseVersion = nextParseVersion;

  if (previousUri && previousUri !== storageUri) {
    await deleteStoredUriBestEffort(previousUri);
  }
}

module.exports = {
  uploadEmbeddedPayloadsAndRefillParseDocument,
  persistNormalizedParseJsonArtifact
};
