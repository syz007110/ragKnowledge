import axios from 'axios';
import { ElMessage } from 'element-plus';
import { clearAuth, getToken } from '../utils/auth';
import { i18n } from '../i18n';

const http = axios.create({
  baseURL: process.env.VUE_APP_API_BASE_URL || 'http://localhost:3301',
  timeout: 120000
});

http.interceptors.request.use((config) => {
  const token = getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  config.headers['x-lang'] = i18n.global.locale.value;
  return config;
});

http.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error?.response?.status === 401) {
      clearAuth();
      if (window.location.pathname !== '/login') {
        ElMessage.error(i18n.global.t('common.sessionExpired'));
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export default http;
