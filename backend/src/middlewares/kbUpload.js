const path = require('path');
const multer = require('multer');
const kbStorage = require('../config/kbStorage');

kbStorage.ensureTempDir();

function safeFilename(name, fallback = 'file') {
  const base = path.basename(String(name || '').trim() || fallback);
  return base.replace(/[^\w\u4e00-\u9fa5.\-]+/g, '_');
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, kbStorage.TMP_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const base = path.basename(file.originalname || `kb-${Date.now()}`, ext);
      const finalName = `${safeFilename(base, 'kb')}-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`;
      cb(null, finalName);
    }
  }),
  limits: {
    files: kbStorage.MAX_FILES,
    fileSize: kbStorage.MAX_FILE_SIZE
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mime = String(file.mimetype || '').toLowerCase();
    const extOk = kbStorage.ALLOWED_EXTS.includes(ext);
    const mimeOk = kbStorage.ALLOWED_MIMES.includes(mime) || mime === 'application/octet-stream';
    if (extOk && mimeOk) return cb(null, true);
    return cb(new Error('kb.fileExtUnsupported'));
  }
});

module.exports = {
  kbUploadMiddleware: upload.array('files', kbStorage.MAX_FILES)
};
