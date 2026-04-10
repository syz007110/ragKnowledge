/**
 * 场景模板：复制为 scenarios/<域>/xxx.js，在 registry.js 中注册。
 *
 * ctx.config  — loadConfig() 结果，可在 lib/config.js 增加 HARNESS_* 字段
 * ctx.client  — 已登录 API 客户端（putRaw 用于对象存储直传）
 * ctx.log()   — 说明性日志，不计入失败
 */

const { assertStatus } = require('../lib/assertx');

module.exports = {
  name: 'template-rename-me',
  tags: ['example'],
  /** @param {HarnessContext} ctx */
  async run(ctx) {
    const res = await ctx.client.get('/');
    assertStatus(res, 200, 'example');
    ctx.log('optional diagnostic');
  }
};
