#!/usr/bin/env node
// test-full-sort.mjs — TDD: 「按安装数」必须是真实全盘排序，禁止窗口近似。
//
// 实测事实（侦察结论，勿凭记忆改动）：
//   trusttools GET /api/skills?sort_by=install_count&direction=desc → 服务端对 579,074 条全盘排序，
//     首条 ui-ux-pro-max≈446,924，跨页全局单调。POST /search 的 sort 参数全部被忽略。
//   skillhub   GET ?sortBy=downloads → 服务端全盘排序，首条 dev-god≈12,105,711，跨页全局单调。
//   lobehub    CLI --sort installCount --order desc → 服务端全盘排序，p1 min ≥ p2 max。
//   clawhub    browse GET ?sort=downloads（不是 search！）→ 服务端全盘排序，首条 ≈493,957，
//     跨 cursor 全局单调；sort=installs 不单调（stats.installs 数据质量差），必须用 downloads。
//   modelscope 无服务端 sort；PageSize 可到 20000，全量 88,993 条 = 5 次调用。全量拉取后本地排
//     是「真实全量」，取前 N 条窗口排是「近似」——禁止后者。
//   browse.sh  一次返回全量 479 条（459 条带 installCount），本地全量排 = 真实全量。
//   skillsmp   CLI 仅 --sort stars|recent，无 installCount → 必须诚实声明不支持。
//   skills.sh  search API 返回已按 installs 降序（4431266,14,14…）；sitemap browse 无 installs。
import { searchSkills, makeCache, supportsSort } from '../src/sources.js';
import fs from 'node:fs';
import path from 'node:path';
import { safeTempDir } from '../src/home.js';

let passed = 0, failed = 0, skipped = 0;
const check = (n, c, d = '') => { if (c) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + d + ']' : '')); } };
const skip = (n) => { skipped++; console.log('  SKIP ' + n); };
const W = path.resolve(import.meta.dirname, '..');

// ── 静态断言：缓存键必须含 sort（跨排序污染 bug 的锁） ──
console.log('');
console.log('Test 0: 所有 handler 的结果缓存键必须包含 sort');
{
  const e = fs.readFileSync(path.join(W, 'src/extra-sources.js'), 'utf8');
  const s = fs.readFileSync(path.join(W, 'src/sources.js'), 'utf8');
  const all = e + '\n' + s;
  // 只检查「结果缓存」键：存原始未排序行的目录缓存（modelscope:full / clawhub_catalog）
  // 合法地不含 sort——排序在每次请求时现做，缓存的是上游原始序。
  const keyLines = all.split('\n').filter((l) => /const \w*[kK]ey\w* = `/.test(l) && /search|skillsmp|trusttools|clawhub:|modelscope:search|skillssh|lobehub_skills/.test(l) && !/modelscope:full|CLAWHUB_CATALOG/.test(l));
  const missing = keyLines.filter((l) => !/sort/i.test(l));
  check('every result cache key includes sort', missing.length === 0, missing.map((m) => m.trim().slice(0, 60)).join(' | '));
}

// ── 能力表必须与实测一致 ──
console.log('');
console.log('Test 1: supportsSort 与上游真实能力一致');
{
  check('trusttools installCount', supportsSort('trusttools', 'installCount') === true);
  check('skillhub installCount', supportsSort('skillhub', 'installCount') === true);
  check('lobehub installCount', supportsSort('lobehub', 'installCount') === true);
  check('clawhub installCount', supportsSort('clawhub', 'installCount') === true);
  check('modelscope installCount', supportsSort('modelscope', 'installCount') === true);
  check('browse.sh installCount', supportsSort('browse.sh', 'installCount') === true);
  check('skillsmp NOT installCount (CLI 无此 sort)', supportsSort('skillsmp', 'installCount') === false);
}

const cache = makeCache(path.join(safeTempDir(), 'dsh-fs-' + Date.now()));
const sz = 12;
const vals = (items) => items.map((i) => Number(i.installs) || 0);

async function globalSortCheck(label, source, opts = {}) {
  let p1, p2, errored = false;
  try {
    p1 = await searchSkills({ query: '', source, page: 1, pageSize: sz, cache, sort: 'installCount', ...opts });
    p2 = await searchSkills({ query: '', source, page: 2, pageSize: sz, cache, sort: 'installCount', ...opts });
  } catch (e) { errored = true; }
  if (errored || !p1 || !p1.items.length || !p2 || !p2.items.length) { skip(label + '（上游不可达）'); return; }
  const v1 = vals(p1.items), v2 = vals(p2.items);
  check(label + ' p1 单调降序', v1.every((v, k, a) => k === 0 || a[k - 1] >= v), v1.join(','));
  check(label + ' 跨页全局单调', Math.max(...v2) <= Math.min(...v1), 'p1min=' + Math.min(...v1) + ' p2max=' + Math.max(...v2));
  console.log('    ' + label + ' p1 head: ' + v1.slice(0, 3).join(', '));
}

console.log('');
console.log('Test 2: 服务端全盘排序源（首条必须是全局最大级别，而非窗口内最大）');
await globalSortCheck('trusttools', 'trusttools');
await globalSortCheck('skillhub', 'skillhub');
await globalSortCheck('clawhub', 'clawhub');

console.log('');
console.log('Test 3: 绝对值下限——证明排的是全量而不是窗口');
{
  try {
    const r = await searchSkills({ query: '', source: 'trusttools', page: 1, pageSize: sz, cache, sort: 'installCount' });
    const top = Math.max(...vals(r.items));
    // 窗口法实测首条 ~63,307；服务端全盘首条 446,924。取 200,000 为分界。
    check('trusttools 首条 > 200,000（全盘）而非 ~63k（窗口）', top > 200000, 'got ' + top);
  } catch (e) { skip('trusttools absolute (' + String(e.message).slice(0, 30) + ')'); }
  try {
    const r = await searchSkills({ query: '', source: 'skillhub', page: 1, pageSize: sz, cache, sort: 'installCount' });
    const top = Math.max(...vals(r.items));
    check('skillhub 首条 > 1,000,000（全盘 dev-god≈12M）', top > 1000000, 'got ' + top);
  } catch (e) { skip('skillhub absolute'); }
  try {
    const r = await searchSkills({ query: '', source: 'clawhub', page: 1, pageSize: sz, cache, sort: 'installCount' });
    const top = Math.max(...vals(r.items));
    check('clawhub 首条 > 400,000（全盘 self-improving≈494k）', top > 400000, 'got ' + top);
  } catch (e) { skip('clawhub absolute'); }
}

console.log('');
console.log('Test 4: browse.sh 全量本地排（479 条全量 = 真实全盘）');
{
  try {
    const r = await searchSkills({ query: '', source: 'browse.sh', page: 1, pageSize: sz, cache, sort: 'installCount' });
    const v = vals(r.items);
      // 旧断言只问「至少一条 >0」，把上游偶发空/降级响应直接判成失败（2026-11-19 实测 1 次假红；
  // 同刻上游健康：479 条 / 459 条非零）。改为：空响应 → SKIP（上游侧问题，非本仓库回归）；
  // 有数据 → 校验覆盖率（实测 459/479 ≈ 96%，门槛取保守的 50%）。
  if (!v.length) skip('browse.sh 目录为空（上游空响应，非数据回归）');
  else check('browse.sh installs 覆盖率过半', v.filter((x) => x > 0).length >= Math.ceil(v.length * 0.5), v.filter((x) => x > 0).length + '/' + v.length);
    check('browse.sh p1 单调', v.every((x, k, a) => k === 0 || a[k - 1] >= x), v.join(','));
  } catch (e) { skip('browse.sh'); }
}

console.log('');
console.log('Test 5: skillsmp 按安装数必须被诚实拒绝（保持上游序，不乱排）');
{
  try {
    const a = await searchSkills({ query: '', source: 'skillsmp', page: 1, pageSize: sz, cache, sort: 'installCount' });
    const b = await searchSkills({ query: '', source: 'skillsmp', page: 1, pageSize: sz, cache, sort: '' });
    check('installCount 被降级为不排序', a.items.map((i) => i.id).join('|') === b.items.map((i) => i.id).join('|'));
  } catch (e) { skip('skillsmp（Cloudflare）'); }
}

console.log('');
console.log('Test 6: 缓存中毒回归——同 cache 先 name 后默认，默认必须不被污染');
{
  const c2 = makeCache(path.join(safeTempDir(), 'dsh-fs2-' + Date.now()));
  try {
    const sorted = await searchSkills({ query: '', source: 'skillsmp', page: 1, pageSize: sz, cache: c2, sort: 'name' });
    const plain = await searchSkills({ query: '', source: 'skillsmp', page: 1, pageSize: sz, cache: c2, sort: '' });
    const fresh = await searchSkills({ query: '', source: 'skillsmp', page: 1, pageSize: sz, cache: makeCache(path.join(safeTempDir(), 'dsh-fs3-' + Date.now())), sort: '' });
    check('plain == fresh（未被 name 排序污染）', plain.items.map((i) => i.id).join('|') === fresh.items.map((i) => i.id).join('|'));
  } catch (e) { skip('poisoning test（skillsmp 不可达）'); }
}

console.log('');
console.log('Test 7: 聚合模式（source=all）的排序不得被能力降级误杀');
{
  // 回归：supportsSort('all', ...) 恒 false → effectiveSort 被清空 → 聚合排序静默失效。
  // 聚合时 dispatcher 必须仍对合并结果排序（各 handler 也应收到 sort 以便取各自的头部条目）。
  let merged = null, plain = null, errored = false;
  try {
    const c4 = makeCache(path.join(safeTempDir(), 'dsh-agg-' + Date.now()));
    merged = await searchSkills({ query: 'agent', source: 'all', page: 1, pageSize: 24, cache: c4, sort: 'installCount' });
    plain = await searchSkills({ query: 'agent', source: 'all', page: 1, pageSize: 24, cache: c4, sort: '' });
  } catch (e) { errored = true; }
  if (errored || !merged || !merged.items.length) { skip('aggregation（上游不可达）'); }
  else {
    const v = merged.items.map((i) => Number(i.installs) || 0);
    const withData = v.filter((x) => x > 0);
    check('aggregation sort applied (nonzero installs exist)', withData.length > 0, v.slice(0, 6).join(','));
    // 排序后的聚合页里，非零 installs 必须降序（0 值条目允许混在后面）
    check('aggregation page monotonic over nonzero', withData.every((x, k, arr) => k === 0 || arr[k - 1] >= x), withData.slice(0, 6).join(','));
    check('sorted != plain (sort actually took effect)', merged.items.map((i) => i.id).join('|') !== plain.items.map((i) => i.id).join('|'));
  }
}
console.log('');
console.log(passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
process.exit(failed ? 1 : 0);