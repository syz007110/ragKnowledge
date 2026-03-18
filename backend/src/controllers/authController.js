const {
  loginViaLogtool,
  meViaLogtool,
  pickAuthData,
  normalizeUserFromMePayload
} = require('../services/logtoolAuthService');

async function login(req, res, next) {
  try {
    const payload = await loginViaLogtool(req.body || {});
    const { token, user } = pickAuthData(payload);
    if (!token) {
      return res.status(401).json({
        messageKey: 'auth.invalidToken',
        message: req.t('auth.invalidToken')
      });
    }
    return res.json({
      token,
      user
    });
  } catch (error) {
    return res.status(error?.response?.status || 500).json({
      messageKey: 'auth.invalidCredentials',
      message: error?.response?.data?.message || req.t('auth.invalidCredentials')
    });
  }
}

async function me(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : null;

    if (!token) {
      return res.status(401).json({ messageKey: 'auth.missingToken', message: req.t('auth.missingToken') });
    }

    const payload = await meViaLogtool(token);
    const user = normalizeUserFromMePayload(payload);
    return res.json({
      user
    });
  } catch (error) {
    return res.status(error?.response?.status || 500).json({
      messageKey: 'auth.invalidToken',
      message: error?.response?.data?.message || req.t('auth.invalidToken')
    });
  }
}

module.exports = {
  login,
  me
};
