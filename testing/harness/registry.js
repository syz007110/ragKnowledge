/**
 * 在此注册所有 API 场景；新增功能时加一行 require 即可。
 * 建议按域分子目录：scenarios/core、scenarios/auth、scenarios/kb、scenarios/…
 */
module.exports = [
  require('./scenarios/core/smoke-root'),
  require('./scenarios/auth/smoke-auth-me'),
  require('./scenarios/kb/smoke-presign-upload')
];
