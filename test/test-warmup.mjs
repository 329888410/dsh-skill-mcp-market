#!/usr/bin/env node
// test-warmup.mjs — TDD: clawhub 并行预热 + 总页数
// 用法: node test-warmup.mjs

import { searchClawHub, warmClawHubCatalog } from '../src/extra-sources.js';
import { makeCache } from '../src/sources.js';
import os from 'node:os';
import path from 'node:path';

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}

// ── Test 1: warmClawHubCatalog accumulates > 500 rows ──
console.log('\nTest 1: warmClawHubCatalog accumulates > 500 rows');
{
  const dir = path.join(os.tmpdir(), 'dsh-warmup-test-' + Date.now());
  const cache = makeCache(dir);
  const result = await warmClawHubCatalog(cache);
  check('rows > 500', result.rows.length > 500);
  check('rows is array', Array.isArray(result.rows));
  check('done is boolean', typeof result.done === 'boolean');
  console.log('  (actual: rows=' + result.rows.length + ', done=' + result.done + ')');
}

// ── Test 2: searchClawHub page 1 shows lower-bound totalPages ──
console.log('\nTest 2: searchClawHub page 1 returns totalPages (lower bound or exact)');
{
  const dir = path.join(os.tmpdir(), 'dsh-warmup-test2-' + Date.now());
  const cache = makeCache(dir);
  // Warm up first (background, don't await — just start)
  const warmPromise = warmClawHubCatalog(cache);
  // Give it a few seconds to accumulate some rows
  await new Promise(r => setTimeout(r, 5000));
  const r = await searchClawHub({ query: '', page: 1, pageSize: 24, cache });
  check('totalPages is a number > 1', typeof r.totalPages === 'number' && r.totalPages > 1);
  check('hasMore is boolean', typeof r.hasMore === 'boolean');
  check('items length = 24', r.items.length === 24);
  console.log('  (actual: totalPages=' + r.totalPages + ', hasMore=' + r.hasMore + ', items=' + r.items.length + ')');
  // Let the warm-up finish
  await warmPromise.catch(() => {});
}

// ── Test 3: after warm-up, totalPages is exact ──
console.log('\nTest 3: after warm-up completes, totalPages is exact');
{
  const dir = path.join(os.tmpdir(), 'dsh-warmup-test3-' + Date.now());
  const cache = makeCache(dir);
  const warm = await warmClawHubCatalog(cache);
  check('warm-up done', warm.done === true);
  check('warm-up rows > 1000', warm.rows.length > 1000);
  const r = await searchClawHub({ query: '', page: 1, pageSize: 24, cache });
  check('totalPages = ceil(rows/size)', r.totalPages === Math.ceil(warm.rows.length / 24));
  check('hasMore = false (cursor exhausted)', r.hasMore === false);
  console.log('  (actual: totalPages=' + r.totalPages + ', hasMore=' + r.hasMore + ', rows=' + warm.rows.length + ')');
}

// ── Test 4: parallel warm-up is faster than serial ──
console.log('\nTest 4: parallel warm-up speed');
{
  const dir = path.join(os.tmpdir(), 'dsh-warmup-test4-' + Date.now());
  const cache = makeCache(dir);
  const t0 = Date.now();
  const warm = await warmClawHubCatalog(cache);
  const elapsed = Math.round((Date.now() - t0) / 1000);
  check('completes in < 10 min', elapsed < 600);
  check('rows > 2000', warm.rows.length > 2000);
  console.log('  (actual: ' + elapsed + 's, rows=' + warm.rows.length + ')');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
