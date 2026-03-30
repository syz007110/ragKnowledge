const jwt = require('jsonwebtoken');
const { meViaLogtool, normalizeUserFromMePayload } = require('../services/logtoolAuthService');

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({ messageKey: 'auth.missingToken', message: req.t('auth.missingToken') });
  }

  try {
    let user = null;
    try {
      const mePayload = await meViaLogtool(token);
      user = normalizeUserFromMePayload(mePayload);
    } catch (meError) {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      user = {
        ...payload,
        permissions: Array.isArray(payload.permissions)
          ? payload.permissions
          : (payload.permissionCodes || payload.roles || [])
      };
    }
    req.user = user;
    return next();
  } catch (error) {
    return res.status(401).json({ messageKey: 'auth.invalidToken', message: req.t('auth.invalidToken') });
  }
}

function hasKbPermission(user, permission) {
  const rawClaims = user?.permissions || user?.roles || [];
  const permissionClaims = Array.isArray(rawClaims)
    ? rawClaims
    : (typeof rawClaims === 'string' ? [rawClaims] : []);
  return user?.isAdmin
    || user?.role === 'admin'
    || user?.username === 'admin'
    || permissionClaims.includes('kb:*')
    || permissionClaims.includes('knowledgebase:*')
    || permissionClaims.includes(permission);
}

function requireKbPermission(permission) {
  return (req, res, next) => {
    if (!hasKbPermission(req.user, permission)) {
      return res.status(403).json({ messageKey: 'auth.forbidden', message: req.t('auth.forbidden') });
    }
    return next();
  };
}

module.exports = {
  authMiddleware,
  requireKbPermission,
  hasKbPermission
};
