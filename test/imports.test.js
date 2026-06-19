// Smoke test: every lib/ and api/ module must import cleanly. This catches
// broken imports, missing exports, and syntax errors across the module graph —
// the main safety net for the db.js refactor (a consumer importing a function
// that no longer exists fails here). No DB/network is touched at import time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

const dirs = ['lib', 'api', 'api/cron'];
const modules = [];
for (const d of dirs) {
  let entries = [];
  try { entries = readdirSync(d); } catch { continue; }
  for (const f of entries) {
    if (f.endsWith('.js')) modules.push('../' + d + '/' + f);
  }
}

for (const m of modules) {
  test(`imports cleanly: ${m}`, async () => {
    await assert.doesNotReject(import(m));
  });
}
