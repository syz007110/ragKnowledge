const fs = require('fs');
const path = require('path');

const LOCAL_DIR = process.env.KB_LOCAL_DIR || path.resolve(__dirname, '../../uploads/kb');
const TMP_DIR = path.resolve(LOCAL_DIR, 'tmp');

function parseNumericEnv(value, fallback) {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (/^\d+(?:\s*\*\s*\d+)+$/.test(raw)) {
    return raw
      .split('*')
      .map((item) => Number(item.trim()))
      .reduce((acc, current) => acc * current, 1);
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const MAX_FILES = parseNumericEnv(process.env.KB_MAX_FILES, 32);
const MAX_FILE_SIZE = parseNumericEnv(process.env.KB_MAX_SIZE, 50 * 1024 * 1024);
const BATCH_MAX_TOTAL_SIZE = parseNumericEnv(process.env.KB_BATCH_MAX_TOTAL_SIZE, 1024 * 1024 * 1024);
const BATCH_MAX_FILES = parseNumericEnv(process.env.KB_BATCH_MAX_FILES, 32);

const DEFAULT_ALLOWED_MIMES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/pdf',
  'application/msword',
  'text/plain',
  'text/markdown',
  'application/octet-stream'
];

const ENV_ALLOWED_MIMES = String(process.env.KB_ALLOWED_MIMES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOWED_MIMES = Array.from(new Set([
  ...DEFAULT_ALLOWED_MIMES,
  ...ENV_ALLOWED_MIMES
]));

const ALLOWED_EXTS = ['.docx', '.xlsx', '.md', '.txt', '.pdf'];

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
  BATCH_MAX_TOTAL_SIZE,
  BATCH_MAX_FILES,
  ALLOWED_MIMES,
  ALLOWED_EXTS,
  ensureLocalDir,
  ensureTempDir
};
