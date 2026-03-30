const jwt = require('jsonwebtoken');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { KbFile } = require('../models');
const {
  isS3Uri,
  getObjectBufferByUri,
  uploadBuffer,
  parseS3Uri
} = require('./objectStorageService');
const { normalizeFileExt } = require('./kbService');

const OO_EXTS_WORD = new Set(['docx', 'doc', 'odt', 'rtf', 'txt', 'html', 'epub', 'fb2']);
const OO_EXTS_CELL = new Set(['xlsx', 'xls', 'ods', 'csv']);
const OO_EXTS_SLIDE = new Set(['pptx', 'ppt', 'odp']);

function trimBaseUrl(url = '') {
  return String(url || '').trim().replace(/\/+$/, '');
}

function isOnlyofficeEnabled() {
  const base = trimBaseUrl(process.env.ONLYOFFICE_DOCUMENT_SERVER_URL || '');
  const integ = trimBaseUrl(process.env.ONLYOFFICE_INTEGRATION_BASE_URL || '');
  const secret = String(process.env.ONLYOFFICE_JWT_SECRET || '').trim();
  return Boolean(base && integ && secret);
}

function getJwtSecret() {
  const s = String(process.env.ONLYOFFICE_JWT_SECRET || '').trim();
  if (!s) throw new Error('kb.onlyofficeJwtSecretMissing');
  return s;
}

function documentTypeForExt(extRaw) {
  const ext = normalizeFileExt('', extRaw);
  if (ext === 'pdf') return 'word';
  if (OO_EXTS_WORD.has(ext)) return 'word';
  if (OO_EXTS_CELL.has(ext)) return 'cell';
  if (OO_EXTS_SLIDE.has(ext)) return 'slide';
  return null;
}

/** OnlyOffice key: [0-9a-zA-Z_-]+, max 128; encodes file id + content hash prefix */
function buildDocumentKey(file) {
  const id = Number(file.id || 0);
  const h = String(file.contentSha256 || '').slice(0, 24).replace(/[^a-z0-9]/gi, 'x');
  const key = `kb${id}h${h || '0'.repeat(8)}`;
  return key.slice(0, 128);
}

function parseDocumentKey(key) {
  const m = String(key || '').match(/^kb(\d+)h([0-9a-z]+)$/i);
  if (!m) return null;
  return { fileId: Number(m[1]) };
}

function signDownloadToken(fileId) {
  return jwt.sign(
    {
      typ: 'oo_dl',
      fid: Number(fileId),
      exp: Math.floor(Date.now() / 1000) + 60 * 15
    },
    getJwtSecret(),
    { algorithm: 'HS256' }
  );
}

function verifyDownloadToken(token) {
  const payload = jwt.verify(String(token || ''), getJwtSecret(), { algorithms: ['HS256'] });
  if (payload.typ !== 'oo_dl' || !Number.isFinite(Number(payload.fid))) {
    throw new Error('kb.onlyofficeInvalidDownloadToken');
  }
  return { fileId: Number(payload.fid) };
}

function verifyCallbackAuthorization(req) {
  const auth = String(req.get('authorization') || '');
  const raw = auth.replace(/^Bearer\s+/i, '').trim();
  if (!raw) {
    throw new Error('kb.onlyofficeCallbackMissingAuth');
  }
  return jwt.verify(raw, getJwtSecret(), { algorithms: ['HS256'] });
}

function integrationDownloadUrl(token) {
  const base = trimBaseUrl(process.env.ONLYOFFICE_INTEGRATION_BASE_URL);
  return `${base}/api/kb/onlyoffice/download?token=${encodeURIComponent(token)}`;
}

function integrationCallbackUrl() {
  const base = trimBaseUrl(process.env.ONLYOFFICE_INTEGRATION_BASE_URL);
  return `${base}/api/kb/onlyoffice/callback`;
}

async function streamFileToResponse(file, res) {
  const encodedFileName = encodeURIComponent(String(file.fileName || 'download'));
  const asciiFileName = String(file.fileName || 'download')
    .replace(/[^\x20-\x7E]+/g, '_')
    .replace(/["\\]/g, '_')
    .slice(0, 180) || 'download';
  res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
  const inline = String(process.env.ONLYOFFICE_DOWNLOAD_DISPOSITION || '').toLowerCase() === 'attachment'
    ? false
    : true;
  res.setHeader(
    'Content-Disposition',
    inline
      ? `inline; filename="${asciiFileName}"; filename*=UTF-8''${encodedFileName}`
      : `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodedFileName}`
  );
  const localPath = getLocalPathFromStorageUri(file.storageUri);
  if (localPath) {
    if (!fs.existsSync(localPath)) {
      throw new Error('kb.fileNotFound');
    }
    const st = fs.statSync(localPath);
    if (st.size) res.setHeader('Content-Length', String(st.size));
    return res.sendFile(path.resolve(localPath));
  }
  if (isS3Uri(file.storageUri)) {
    const buffer = await getObjectBufferByUri(file.storageUri);
    if (buffer.length) res.setHeader('Content-Length', String(buffer.length));
    return res.send(buffer);
  }
  throw new Error('kb.fileNotFound');
}

function getLocalPathFromStorageUri(storageUri = '') {
  const raw = String(storageUri || '').trim();
  if (!raw.startsWith('file://')) return '';
  return raw.replace(/^file:\/\//, '');
}

async function handleOnlyofficeDownload(req, res) {
  const token = String(req.query.token || '');
  let fileId;
  try {
    ({ fileId } = verifyDownloadToken(token));
  } catch (_) {
    return res.status(401).json({ messageKey: 'auth.invalidToken', message: 'Invalid or expired token' });
  }
  const file = await KbFile.findOne({
    where: { id: fileId, isDeleted: 0 }
  });
  if (!file) {
    return res.status(404).json({ messageKey: 'kb.fileNotFound' });
  }
  try {
    await streamFileToResponse(file, res);
  } catch (e) {
    if (e.message === 'kb.fileNotFound') {
      return res.status(404).json({ messageKey: 'kb.fileNotFound' });
    }
    throw e;
  }
}

async function persistEditedBufferToStorage(file, buffer) {
  const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  if (!body.length) throw new Error('kb.onlyofficeEmptyDocument');

  if (isS3Uri(file.storageUri)) {
    const parsed = parseS3Uri(file.storageUri);
    if (!parsed) throw new Error('kb.objectStorageUriInvalid');
    await uploadBuffer({
      buffer: body,
      objectKey: parsed.key,
      contentType: file.mimeType || 'application/octet-stream'
    });
  } else {
    const localPath = getLocalPathFromStorageUri(file.storageUri);
    if (!localPath) throw new Error('kb.fileNotFound');
    await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
    await fs.promises.writeFile(localPath, body);
  }

  const contentSha256 = crypto.createHash('sha256').update(body).digest('hex');
  await file.update({
    fileSize: body.length,
    contentSha256,
    status: 'uploaded',
    errorMessage: null,
    errorMessageKey: null
  });
}

async function triggerRebuildAfterSave(file) {
  const trigger = String(process.env.ONLYOFFICE_SAVE_TRIGGERS_REBUILD || 'true').toLowerCase() !== 'false';
  if (!trigger) return;
  const { rebuildFile } = require('./kbService');
  const locale = String(process.env.ONLYOFFICE_REBUILD_LOCALE || process.env.DEFAULT_LOCALE || 'zh-CN').trim();
  await rebuildFile({ id: file.id, user: null, locale });
}

async function handleOnlyofficeCallback(req, res) {
  let data;
  try {
    data = verifyCallbackAuthorization(req);
  } catch (e) {
    return res.status(401).json({ error: 1 });
  }

  const status = Number(data.status);
  const out = (payload) => res.json(payload);

  if (status === 3 || status === 7) {
    console.warn('[onlyoffice] callback error status', status, data);
    return out({ error: 0 });
  }

  if ((status === 2 || status === 6) && data.url) {
    try {
      const parsedKey = parseDocumentKey(data.key);
      if (!parsedKey) {
        console.error('[onlyoffice] unknown document key', data.key);
        return out({ error: 1, message: 'bad key' });
      }
      const file = await KbFile.findOne({
        where: { id: parsedKey.fileId, isDeleted: 0 }
      });
      if (!file) {
        return out({ error: 1, message: 'file not found' });
      }
      const resp = await axios.get(String(data.url), {
        responseType: 'arraybuffer',
        timeout: Number(process.env.ONLYOFFICE_CALLBACK_FETCH_TIMEOUT_MS || 120000),
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });
      const buf = Buffer.from(resp.data || []);
      await persistEditedBufferToStorage(file, buf);
      await triggerRebuildAfterSave(file);
    } catch (err) {
      console.error('[onlyoffice] save failed', err.message || err);
      return out({ error: 1, message: String(err.message || 'save failed') });
    }
  }

  return out({ error: 0 });
}

function buildEditorConfigPayload({ file, user, mode }) {
  const docType = documentTypeForExt(normalizeFileExt(file.fileName, file.fileExt));
  if (!docType) {
    throw new Error('kb.onlyofficeUnsupportedType');
  }

  const fileExt = normalizeFileExt(file.fileName, file.fileExt);
  const downloadJwt = signDownloadToken(file.id);
  const documentUrl = integrationDownloadUrl(downloadJwt);

  const editMode = mode === 'edit' ? 'edit' : 'view';
  const uid = String(getOperatorUserId(user) || 'viewer');
  const uname = String(user?.username || user?.name || uid);

  /** 仅 view（知识库抽屉预览）：收紧原生界面；edit 仍保留完整编辑能力 */
  const customization =
    editMode === 'view'
      ? {
          forcesave: false,
          chat: false,
          comments: false,
          compactHeader: true,
          compactToolbar: true,
          hideRightMenu: true,
          hideRulers: true,
          help: false,
          plugins: false,
          feedback: false,
          macros: false,
          toolbarHide: true
        }
      : {
          forcesave: false,
          chat: false,
          comments: false,
          plugins: false
        };

  /** 官方推荐放在 document.permissions；chat 关闭协作聊天 */
  const documentPermissions =
    editMode === 'edit'
      ? {
          edit: true,
          comment: false,
          download: true,
          print: true,
          review: true,
          chat: false
        }
      : {
          edit: false,
          comment: false,
          download: false,
          print: false,
          review: false,
          copy: true,
          chat: false
        };

  const payload = {
    documentType: docType,
    document: {
      fileType: fileExt,
      key: buildDocumentKey(file),
      title: file.fileName || `file-${file.id}`,
      url: documentUrl,
      permissions: documentPermissions
    },
    editorConfig: {
      mode: editMode,
      lang: String(process.env.ONLYOFFICE_EDITOR_LANG || 'zh-CN'),
      callbackUrl: integrationCallbackUrl(),
      user: {
        id: uid.slice(0, 32),
        name: uname.slice(0, 64)
      },
      customization
    }
  };

  const token = jwt.sign(payload, getJwtSecret(), {
    algorithm: 'HS256',
    noTimestamp: true
  });
  return { ...payload, token };
}

function getOperatorUserId(user) {
  return user?.id || user?.userId || null;
}

async function getOnlyofficeEditorBundle({ fileId, user, mode }) {
  if (!isOnlyofficeEnabled()) {
    throw new Error('kb.onlyofficeDisabled');
  }
  const file = await KbFile.findOne({
    where: { id: Number(fileId), isDeleted: 0 }
  });
  if (!file) {
    throw new Error('kb.fileNotFound');
  }
  const docServer = trimBaseUrl(process.env.ONLYOFFICE_DOCUMENT_SERVER_URL);
  const config = buildEditorConfigPayload({ file, user, mode });
  return {
    documentServerUrl: docServer,
    config
  };
}

module.exports = {
  isOnlyofficeEnabled,
  buildDocumentKey,
  parseDocumentKey,
  getOnlyofficeEditorBundle,
  handleOnlyofficeDownload,
  handleOnlyofficeCallback
};
