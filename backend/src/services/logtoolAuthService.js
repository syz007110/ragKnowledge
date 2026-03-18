const axios = require('axios');

const logtoolHttp = axios.create({
  baseURL: process.env.LOGTOOL_API_BASE_URL || process.env.AUTH_PROXY_BASE_URL || 'http://localhost:3000',
  timeout: Number(process.env.LOGTOOL_API_TIMEOUT_MS || 15000)
});

function pickAuthData(payload = {}) {
  const token = payload?.token || payload?.data?.token || payload?.accessToken || '';
  const user = payload?.user || payload?.data?.user || payload?.data || {};
  return { token, user };
}

function normalizePermissions(user = {}) {
  const raw = user.permissions || user.permissionCodes || user.roles || [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') return [raw];
  return [];
}

async function loginViaLogtool(credentials) {
  const response = await logtoolHttp.post('/api/auth/login', credentials);
  return response.data || {};
}

async function meViaLogtool(token) {
  const response = await logtoolHttp.get('/api/auth/me', {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  return response.data || {};
}

function normalizeUserFromMePayload(payload = {}) {
  const user = payload?.user || payload?.data?.user || payload?.data || payload || {};
  return {
    ...user,
    permissions: normalizePermissions(user)
  };
}

module.exports = {
  pickAuthData,
  normalizePermissions,
  loginViaLogtool,
  meViaLogtool,
  normalizeUserFromMePayload
};
