const zhCN = require('./locales/zh-CN.json');
const enUS = require('./locales/en-US.json');

const DICT = {
  'zh-CN': zhCN,
  'en-US': enUS
};

const DEFAULT_LOCALE = 'zh-CN';

function normalizeLocale(raw) {
  const value = String(raw || '').toLowerCase();
  if (!value) return DEFAULT_LOCALE;
  if (value.includes('zh')) return 'zh-CN';
  if (value.includes('en')) return 'en-US';
  return DEFAULT_LOCALE;
}

function getLocaleFromRequest(req) {
  return normalizeLocale(req.headers['x-lang'] || req.headers['accept-language']);
}

function t(locale, key) {
  const safeLocale = normalizeLocale(locale);
  return DICT[safeLocale]?.[key] || DICT[DEFAULT_LOCALE]?.[key] || key;
}

module.exports = {
  DEFAULT_LOCALE,
  normalizeLocale,
  getLocaleFromRequest,
  t
};
