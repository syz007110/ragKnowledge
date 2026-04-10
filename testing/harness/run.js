#!/usr/bin/env node
/**
 * API harness: login once, run registered scenarios (HTTP black-box).
 *
 * Usage:
 *   node testing/harness/run.js
 *   node testing/harness/run.js --grep=presign
 *   HARNESS_GREP=auth node testing/harness/run.js
 *
 * Env: see testing/harness/env.example
 */
const path = require('path');
const { loadConfig } = require('./lib/config');
const { createSession } = require('./lib/session');
const scenarios = require('./registry');

function matchesGrep(name, grep) {
  if (!grep) return true;
  return name.toLowerCase().includes(grep.toLowerCase());
}

async function main() {
  const config = loadConfig(process.argv);
  const grep = config.grep;

  const log = (...args) => console.log('[harness]', ...args);

  log(`apiBaseUrl=${config.apiBaseUrl}`);
  const { client } = await createSession(config);

  const ctx = {
    config,
    client,
    log
  };

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const scenario of scenarios) {
    if (!matchesGrep(scenario.name, grep)) {
      skipped += 1;
      continue;
    }
    const t0 = Date.now();
    process.stdout.write(`→ ${scenario.name} ... `);
    try {
      await scenario.run(ctx);
      console.log(`OK (${Date.now() - t0}ms)`);
      passed += 1;
    } catch (e) {
      console.log(`FAIL (${Date.now() - t0}ms)`);
      console.error(e?.stack || e?.message || e);
      failed += 1;
    }
  }

  if (grep) {
    log(`filter: --grep=${grep} (non-matching scenarios were not run)`);
  }
  log(`done: passed=${passed} failed=${failed} skipped-by-grep=${skipped}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('[harness] fatal', e);
  process.exitCode = 1;
});
