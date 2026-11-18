#!/usr/bin/env node
// test-total-pages.mjs — TDD: 分页总页数的诚实性。
// 事实：clawhub 的 browse 目录是 30k+ 且不封顶的 cursor 流，上游从不返回 total。
//       因此「精确总页数」对它是不可能的；谎报一个下界（共 2 页）比说「未知」更糟。
// 规格：单源若不知道自己有多少页 → totalPages 必须是 undefined，客户端走窗口式 +「可继续加载」；
//       只有真正耗尽游标（done=true）才给精确值。
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
const fakeRows = Array.from({ length: 600 }, (_, i) => ({
  id: 'fake-' + i, slug: 'fake-skill-' + i, displayName: 'Fake ' + i,
  summary: 'x', ownerHandle: 'owner', downloads: i,
}));

console.log('\nTest 1: 游标未尽（无界流）→ totalPages 未知，绝不谎报');
{
  await cache.put('clawhub_catalog_v1', { rows: fakeRows, cursor: 'still-going', done: false });
  const r = await searchSkills({ query: '', source: 'clawhub', page: 1, pageSize: 24, cache });
  check('items = 24', r.items.length === 24);
  check('hasMore = true', r.hasMore === true, 'got ' + r.hasMore);
  check('totalPages undefined (honest unknown)', r.totalPages === undefined, 'got ' + r.totalPages);
  check('pages undefined too (client needs 0)', r.pages === undefined || r.pages === 0, 'got ' + r.pages);
}

console.log('\nTest 2: 游标耗尽 → 精确总页数');
{
  await cache.put('clawhub_catalog_v1', { rows: fakeRows, cursor: null, done: true });
  const r = await searchSkills({ query: '', source: 'clawhub', page: 25, pageSize: 24, cache });
  check('totalPages = ceil(600/24) = 25', r.totalPages === 25, 'got ' + r.totalPages);
  check('hasMore = false on last page', r.hasMore === false, 'got ' + r.hasMore);
}

console.log('\nTest 3: 有精确总数的源照常报数（skills.sh sitemap）');
{
  const r = await searchSkills({ query: '', source: 'skills.sh', page: 1, pageSize: 24, cache });
  check('skills.sh totalPages is a number', typeof r.totalPages === 'number' && r.totalPages >= 1, 'got ' + r.totalPages);
}

console.log('\nTest 4: 聚合 all 模式仍给出可用的 pages');
{
  const r = await searchSkills({ query: 'mcp', source: 'all', page: 1, pageSize: 24, cache });
  check('pages positive or unknown', r.pages === undefined || r.pages >= 1, 'got ' + r.pages);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
