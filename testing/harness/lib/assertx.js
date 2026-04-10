function assert(cond, message = 'assertion failed') {
  if (!cond) {
    const err = new Error(message);
    err.name = 'HarnessAssertionError';
    throw err;
  }
}

function assertStatus(response, expected, hint = '') {
  const got = response?.status;
  const extra = hint ? ` (${hint})` : '';
  assert(
    got === expected,
    `expected HTTP ${expected}, got ${got}${extra}: ${JSON.stringify(response?.data || '').slice(0, 500)}`
  );
}

function assertHas(obj, keys, hint = '') {
  for (const k of keys) {
    assert(obj && Object.prototype.hasOwnProperty.call(obj, k), `missing "${k}" ${hint}`.trim());
  }
}

module.exports = { assert, assertStatus, assertHas };
