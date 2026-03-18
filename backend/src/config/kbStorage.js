const fs = require('fs');
const path = require('path');

const LOCAL_DIR = process.env.KB_LOCAL_DIR || path.resolve(__dirname, '../../uploads/kb');
const TMP_DIR = path.resolve(LOCAL_DIR, 'tmp');

const MAX_FILES = Number.parseInt(process.env.KB_MAX_FILES || '5', 10);
const MAX_FILE_SIZE = Number.parseInt(process.env.KB_MAX_SIZE || `${20 * 1024 * 1024}`, 10);

const ALLOWED_MIMES = (process.env.KB_ALLOWED_MIMES ||
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document,' +
  'application/msword,' +
  'text/plain,text/markdown,application/octet-stream')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOWED_EXTS = ['.docx', '.md', '.txt'];

function ensureLocalDir() {
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  return LOCAL_DIR;
}

function ensureTempDir() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  return TMP_DIR;
}

module.exports = {
  LOCAL_DIR,
  TMP_DIR,
  MAX_FILES,
  MAX_FILE_SIZE,
  ALLOWED_MIMES,
  ALLOWED_EXTS,
  ensureLocalDir,
  ensureTempDir
};
