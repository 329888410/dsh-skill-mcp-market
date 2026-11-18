#!/usr/bin/env node
// test-total-pages.mjs — TDD: dispatcher 必须透传单源的 totalPages，
// 而不是用被下限钳制的 total 反推（症状：clawhub 明明缓存了 3016 条却显示"共 2 页"）。
import { searchSkills, makeCache } from '../src/sources.js';
import os from 'node:os';
import path from 'node:path';

let passed = 0, failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log('  \u2713 ' + name); }
  else { failed++; console.log('  \u2717 ' + name + (detail ? '  ' + detail : '')); }
};

const dir = path.join(os.tmpdir(), 'dsh-tp-' + Date.now());
const cache = makeCache(dir);

// Seed a clawhub catalog cache with 600 fake rows so the handler knows
// the catalogue depth without any network round-trips.
const fakeRows = Array.from({ length: 600 }, (_, i) => ({
  id: 'fake-' + i, slug: 'fake-skill-' + i, displayName: 'Fake ' + i,
  summary: 'x', ownerHandle: 'owner', downloads: i,
}));
await cache.put('clawhub_catalog_v1', { rows: fakeRows, cursor: 'still-going', done: false });

console.log('\nTest 1: clawhub browse reports totalPages from the accumulated catalogue, not the clamped total');
{
  const r = await searchSkills({ query: '', source: 'clawhub', page: 1, pageSize: 24, cache });
  check('items = 24', r.items.length === 24);
  // 600 rows accumulated → at least ceil(600/24)=25 pages known
  check('totalPages >= 25 (catalogue-aware)', (r.totalPages || 0) >= 25, 'got ' + r.totalPages);
  check('pages mirrors totalPages', r.pages === r.totalPages, 'pages=' + r.pages + ' totalPages=' + r.totalPages);
}

console.log('\nTest 2: exact when cursor exhausted (done=true)');
{
  await cache.put('clawhub_catalog_v1', { rows: fakeRows, cursor: null, done: true });
  const last = await searchSkills({ query: '', source: 'clawhub', page: 25, pageSize: 24, cache });
  check('totalPages = ceil(600/24) = 25', last.totalPages === 25, 'got ' + last.totalPages);
  check('hasMore = false on last page', last.hasMore === false, 'got ' + last.hasMore);
  const first = await searchSkills({ query: '', source: 'clawhub', page: 1, pageSize: 24, cache });
  check('hasMore = true on page 1 of 25', first.hasMore === true, 'got ' + first.hasMore);
}

console.log('\nTest 3: multi-source "all" keeps a sane pages value');
{
  const r = await searchSkills({ query: 'mcp', source: 'all', page: 1, pageSize: 24, cache });
  check('pages is a positive number', Number.isFinite(r.pages) && r.pages >= 1, 'got ' + r.pages);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
