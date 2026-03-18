import { createI18n } from 'vue-i18n';
import zhCN from './locales/zh-CN.json';
import enUS from './locales/en-US.json';

const STORAGE_KEY = 'mk_locale';

function resolveLocale() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'en-US' || saved === 'zh-CN') {
    return saved;
  }
  const browser = String(navigator.language || '').toLowerCase();
  if (browser.startsWith('en')) return 'en-US';
  return 'zh-CN';
}

export const i18n = createI18n({
  legacy: false,
  locale: resolveLocale(),
  fallbackLocale: 'zh-CN',
  messages: {
    'zh-CN': zhCN,
    'en-US': enUS
  }
});

export function setLocale(locale) {
  if (!['zh-CN', 'en-US'].includes(locale)) return;
  i18n.global.locale.value = locale;
  localStorage.setItem(STORAGE_KEY, locale);
}

export function getLocale() {
  return i18n.global.locale.value;
}
