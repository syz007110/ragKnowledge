const TOKEN_KEY = 'mk_token';
const USER_KEY = 'mk_user';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token || '');
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export function getUser() {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

export function setUser(user) {
  localStorage.setItem(USER_KEY, JSON.stringify(user || {}));
}

export function clearUser() {
  localStorage.removeItem(USER_KEY);
}

export function clearAuth() {
  clearToken();
  clearUser();
}

export function isAuthenticated() {
  return Boolean(getToken());
}

/** 是否管理员（仅管理员可进入设置/标签管理） */
export function isAdmin() {
  const user = getUser();
  if (!user) return false;
  return Boolean(
    user.isAdmin === true ||
    user.role === 'admin' ||
    user.username === 'admin'
  );
}
