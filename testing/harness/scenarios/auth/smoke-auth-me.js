const { assertStatus } = require('../../lib/assertx');

module.exports = {
  name: 'smoke-auth-me',
  tags: ['smoke', 'auth'],
  async run(ctx) {
    const res = await ctx.client.me();
    assertStatus(res, 200, 'GET /api/auth/me');
    if (!res.data?.user) {
      throw new Error('me response missing user');
    }
  }
};
