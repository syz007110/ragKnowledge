const { createApiClient } = require('./client');

/**
 * Login via MKnowledge → Logtool, or use HARNESS_BEARER_TOKEN.
 */
async function createSession(config) {
  if (config.bearerToken) {
    return {
      token: config.bearerToken,
      client: createApiClient({ baseURL: config.apiBaseUrl, token: config.bearerToken })
    };
  }
  if (!config.username || !config.password) {
    throw new Error(
      'Set HARNESS_USERNAME + HARNESS_PASSWORD or HARNESS_BEARER_TOKEN (see testing/harness/env.example)'
    );
  }
  const anon = createApiClient({ baseURL: config.apiBaseUrl, token: '' });
  const res = await anon.login({
    username: config.username,
    password: config.password
  });
  if (res.status !== 200 || !res.data?.token) {
    throw new Error(
      `login failed: HTTP ${res.status} ${JSON.stringify(res.data || '').slice(0, 300)}`
    );
  }
  const token = res.data.token;
  return {
    token,
    client: createApiClient({ baseURL: config.apiBaseUrl, token })
  };
}

module.exports = { createSession };
