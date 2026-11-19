#!/usr/bin/env node
// test-sort-options.mjs — TDD: 按官方原生能力扩展排序（实测矩阵，勿凭记忆改）。
//
//   clawhub browse sort=: downloads✓ stars✓ newest✓(createdAt desc) updated✓(updatedAt desc)
//     trending✓ name(server, collation≠localeCompare) installs✗(不单调→用 downloads)
//   skillhub sortBy=: downloads✓ stars✓ updated✓ | name=EMPTY(上游bug)→本地
//   trusttools GET sort_by=: install_count✓(全局) | stars被忽略 newest/updated/trending/name=EMPTY
//   lobehub CLI --sort: createdAt|stars|installCount|name|relevance|ratingAverage|commentCount|updatedAt
//   modelscope: 无服务端 sort→全量拉(≤45k)后本地排 DownloadCount/Likes/GmtCreate/GmtModify/Name
//   browse.sh: 一次全量479→本地排 installCount/updated/name
//   skillsmp: API被Cloudflare挡→诚实不支持任何 sort
import { searchSkills, makeCache, supportsSort } from '../src/sources.js';
import path from 'node:path';
import { safeTempDir } from '../src/home.js';

let passed = 0, failed = 0, skipped = 0;
const check = (n, c, d = '') => { if (c) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + d + ']' : '')); } };
const skip = (n) => { skipped++; console.log('  SKIP ' + n); };

console.log('');
console.log('Test 1: supportsSort 能力矩阵与实测一致');
{
  check('clawhub stars', supportsSort('clawhub', 'stars') === true);
  check('clawhub newest', supportsSort('clawhub', 'newest') === true);
  check('clawhub updated', supportsSort('clawhub', 'updated') === true);
  check('clawhub trending', supportsSort('clawhub', 'trending') === true);
  check('skillhub stars', supportsSort('skillhub', 'stars') === true);
  check('skillhub updated', supportsSort('skillhub', 'updated') === true);
  check('lobehub stars', supportsSort('lobehub', 'stars') === true);
  check('lobehub newest', supportsSort('lobehub', 'newest') === true);
  check('modelscope newest', supportsSort('modelscope', 'newest') === true);
  check('modelscope stars', supportsSort('modelscope', 'stars') === true);
  check('browse.sh updated', supportsSort('browse.sh', 'updated') === true);
  check('trusttools stars NOT (upstream ignores)', supportsSort('trusttools', 'stars') === false);
  check('trusttools newest NOT (EMPTY)', supportsSort('trusttools', 'newest') === false);
  check('skillsmp nothing', supportsSort('skillsmp', 'stars') === false && supportsSort('skillsmp', 'installCount') === false);
}

const cache = makeCache(path.join(safeTempDir(), 'dsh-so-' + Date.now()));
const sz = 12;
const desc = (arr) => arr.every((v, k, a) => k === 0 || a[k - 1] >= v);

async function sortTest(label, source, sort, fieldOf) {
  let r, errored = false;
  try { r = await searchSkills({ query: '', source, page: 1, pageSize: sz, cache, sort }); } catch (e) { errored = true; }
  if (errored || !r || !r.items.length) { skip(label); return; }
  const v = r.items.map(fieldOf);
  check(label + ' 单调', desc(v), v.slice(0, 5).join(','));
}

console.log('');
console.log('Test 2: 服务端/本地全盘排序对新 key 生效');
await sortTest('clawhub stars', 'clawhub', 'stars', (i) => Number(i.stars) || 0);
await sortTest('clawhub newest', 'clawhub', 'newest', (i) => Number(i.createdAt) || 0);
await sortTest('skillhub stars', 'skillhub', 'stars', (i) => Number(i.stars) || 0);
await sortTest('browse.sh updated', 'browse.sh', 'updated', (i) => Date.parse(i.updated || '1970') || 0);

console.log('');
console.log('Test 3: 不支持的组合必须保持上游默认序（不乱排、不近似）');
{
  let a, b, errored = false;
  try {
    a = await searchSkills({ query: '', source: 'trusttools', page: 1, pageSize: sz, cache, sort: 'stars' });
    b = await searchSkills({ query: '', source: 'trusttools', page: 1, pageSize: sz, cache, sort: '' });
  } catch (e) { errored = true; }
  if (errored || !a || !a.items.length) skip('trusttools stars-vs-default');
  else check('trusttools stars == default (honest no-op)', a.items.map((i) => i.id).join('|') === b.items.map((i) => i.id).join('|'));
}

console.log('');
console.log('Test 4: 卡片必须带上新排序字段（排序键与展示同源）');
{
  try {
    const r = await searchSkills({ query: '', source: 'clawhub', page: 1, pageSize: 5, cache, sort: 'stars' });
    const it = r.items[0] || {};
    check('clawhub item.stars present', typeof it.stars === 'number', String(it.stars));
    check('clawhub item.createdAt present', typeof it.createdAt === 'number', String(it.createdAt));
  } catch (e) { skip('fields'); }
}

console.log('');
console.log('Test 5: UI 下拉必须提供新排序项');
{
  const fs2 = await import('node:fs');
  const c = fs2.readFileSync(path.resolve(import.meta.dirname, '..', 'client.js'), 'utf8');
  // 下拉按能力矩阵动态生成（CAPS 表 + LABEL 表），不是硬编码 option 字面量
  check('stars in capability map', /stars/.test(c) && c.includes("'按星级'"));
  check('newest in capability map', c.includes("'最新'"));
  check('updated in capability map', c.includes("'最近更新'"));
}

console.log('');
console.log('Test 6: client 的 CAPS 表与 src/sort-capability.js 逐源一致（兑现 0.5.101 CHANGELOG 承诺）');
{
  const fsx = await import('node:fs');
  const cap = fsx.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'sort-capability.js'), 'utf8');
  const client = fsx.readFileSync(path.resolve(import.meta.dirname, '..', 'client.js'), 'utf8');
  const parse = (text, re) => {
    const m = text.match(re);
    if (!m) return null;
    const out = {};
    for (const line of m[1].split('\n')) {
      const e = /^\s*["']?([\w.-]+)["']?:\s*\[([^\]]*)\]/.exec(line);
      if (e) out[e[1]] = e[2].split(',').map((x) => x.trim().replace(/["']/g, '')).filter(Boolean);
    }
    return out;
  };
  const srv = parse(cap, /const CAPABILITIES = \{([\s\S]*?)\n\};/);
  const cli = parse(client, /const CAPS = \{([\s\S]*?)\n\s*\};/);
  check('两表都能解析', !!srv && !!cli);
  if (srv && cli) {
    const keys = [...new Set([...Object.keys(srv), ...Object.keys(cli)])];
    const drift = keys.filter((k) => (srv[k] || []).join(',') !== (cli[k] || []).join(','));
    check('每个源的排序键列表逐字一致', drift.length === 0, drift.map((k) => k + ': srv=' + (srv[k] || []).join('|') + ' cli=' + (cli[k] || []).join('|')).join(' ; '));
    check('源集合大小一致', Object.keys(srv).length === Object.keys(cli).length, Object.keys(srv).length + ' vs ' + Object.keys(cli).length);
  }
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
process.exit(failed ? 1 : 0);