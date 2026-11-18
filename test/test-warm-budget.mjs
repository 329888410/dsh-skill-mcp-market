#!/usr/bin/env node
// test-warm-budget.mjs — TDD: clawhub 预热必须有行数预算，不能对着 28k+ 的无限 cursor 流一直爬。
// 症状：catalogue 已 28800 条仍 done=false，warm-up 永不终止 → 内存与 API 无界增长。
import { warmClawHubCatalog } from '../src/extra-sources.js';
import { makeCache } from '../src/sources.js';
import os from 'node:os';
import path from 'node:path';

let passed = 0, failed = 0;
const check = (n, c, d = '') => { if (c) { passed++; console.log('  \u2713 ' + n); } else { failed++; console.log('  \u2717 ' + n + (d ? '  ' + d : '')); } };

console.log('\nTest 1: warmClawHubCatalog respects a row budget and terminates');
{
  const dir = path.join(os.tmpdir(), 'dsh-wb-' + Date.now());
  const cache = makeCache(dir);
  const t0 = Date.now();
  const r = await warmClawHubCatalog(cache, { budget: 300 });
  const elapsed = Math.round((Date.now() - t0) / 1000);
  check('returns rows array', Array.isArray(r.rows));
  check('rows <= budget + slack (300..360)', r.rows.length >= 200 && r.rows.length <= 360, 'got ' + r.rows.length);
  check('terminates in < 120s', elapsed < 120, 'took ' + elapsed + 's');
  console.log('  (rows=' + r.rows.length + ', ' + elapsed + 's)');
}

console.log('\nTest 2: default budget is finite (not 99999 / not infinite)');
{
  const dir = path.join(os.tmpdir(), 'dsh-wb2-' + Date.now());
  const cache = makeCache(dir);
  const t0 = Date.now();
  const r = await warmClawHubCatalog(cache);
  const elapsed = Math.round((Date.now() - t0) / 1000);
  check('default run terminates in < 300s', elapsed < 300, 'took ' + elapsed + 's');
  check('default rows <= 2200', r.rows.length <= 2200, 'got ' + r.rows.length);
  console.log('  (rows=' + r.rows.length + ', ' + elapsed + 's, done=' + r.done + ')');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
