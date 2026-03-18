const { getLocaleFromRequest, t } = require('../i18n');

function localeMiddleware(req, res, next) {
  const locale = getLocaleFromRequest(req);
  req.locale = locale;
  req.t = (key) => t(locale, key);
  next();
}

module.exports = {
  localeMiddleware
};
