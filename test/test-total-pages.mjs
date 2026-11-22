#!/usr/bin/env node
// test-total-pages.mjs — TDD: 分页总页数的诚实性。
// 事实：clawhub 的 browse 目录是 30k+ 且不封顶的 cursor 流，上游从不返回 total。
//       因此「精确总页数」对它是不可能的；谎报一个下界（共 2 页）比说「未知」更糟。
// 规格：单源若不知道自己有多少页 → totalPages 必须是 undefined，客户端走窗口式 +「可继续加载」；
//       只有真正耗尽游标（done=true）才给精确值。
import { searchSkills, makeCache } from '../src/sources.js';
import { searchLobeHubMarket } from '../src/lobehub-market.js';
import fs from 'node:fs';
import path from 'node:path';
import { safeTempDir } from '../src/home.js';

let passed = 0, failed = 0, skipped = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log('  \u2713 ' + name); }
  else { failed++; console.log('  \u2717 ' + name + (detail ? '  ' + detail : '')); }
};
const skip = (n, d = '') => { skipped++; console.log('  SKIP ' + n + (d ? '  [' + String(d).slice(0, 70) + ']' : '')); };

const W = path.resolve(import.meta.dirname, '..');
const dir = path.join(safeTempDir(), 'dsh-tp-' + Date.now());
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
  // 证据门控（0.5.140 改口径后必须跟着改，否则门内假红）：空查询走 browseSkillsSh，
  // 它的总数来自本地全量目录（sitemap ~2MB）。目录没载入成功时本页 items=0，聚合层
  // 如实报「页数未知」—— 那正是 0.5.140 立的规矩（一次取数失败不许谎称「共 1 页」，
  // 也不许谎称已到底），不是回归。旧注释写的「不可达时 totalPages=1」就是被修掉的缺陷。
  // 所以：只有本页真取到条目，才有资格断言数字；取不到就是没测成。
  if (r.items.length === 0) {
    skip('skills.sh totalPages is a number', '目录未载入：items=0，无证据可断言（degraded=' + (r.degraded || []).length + '）');
  } else {
    check('skills.sh totalPages is a number', typeof r.totalPages === 'number' && r.totalPages >= 1, 'got ' + r.totalPages);
    check('总页数与总数同源于证据（ceil(total/pageSize)）',
      r.totalPages === Math.ceil(Number(r.total) / r.pageSize), 'pages=' + r.totalPages + ' total=' + r.total + ' size=' + r.pageSize);
  }
}

console.log('\nTest 4: 聚合 all 模式仍给出可用的 pages');
{
  const r = await searchSkills({ query: 'mcp', source: 'all', page: 1, pageSize: 24, cache });
  check('pages positive or unknown', r.pages === undefined || r.pages >= 1, 'got ' + r.pages);
}

// D3（0.5.144）：LobeHub 的 totalCount/totalPages 缺失时不得编造。
// 实测（真 Node，2026-11-22）上游正常时确实给数：total=127537 totalPages=63769。
// 但旧实现写 `Number(data.totalCount) || items.length` 与 `Number(data.totalPages) || 1`：
// 字段一旦缺失/为 0/非数字，面板就显示「共 40 个 · 第 1/1 页」并永久禁用下一页 ——
// 把「本页窗口条数」当目录规模、把「不知道」当「只有一页」，正是 0.5.140/0.5.141
// 已对其它源立过的规矩：没有证据就不给数字。
console.log('\nTest 5: LobeHub 缺字段时报未知，不报窗口条数/共 1 页');
{
  const lmSrc = fs.readFileSync(new URL('../src/lobehub-market.js', import.meta.url), 'utf8');
  check('totalCount 的 || items.length 兜底已消失', !lmSrc.includes('Number(data.totalCount) || items.length'), '仍在拿本页条数当总数');
  check('totalPages 的 || 1 兜底已消失', !lmSrc.includes('Number(data.totalPages) || 1'), '仍在拿 1 当总页数');
  check('可注入 run 接缝存在（否则下面四组用例只能打真网络）',
    /run = runCli/.test(lmSrc) && /await run\(/.test(lmSrc), '没有 run 接缝');
}

// Test 6 是 Test 5 的运行时证据：同一个判定在缺字段/给数/给 0 三种上游输出下的实际值。
console.log('\nTest 6: LobeHub 注入用例 —— 缺字段报未知，给数照常透传，0 不算规模');
{
  const mk = (n) => Array.from({ length: n }, (u, i) => ({ identifier: 'm' + i, name: 'm' + i }));
  // 桩返回真实 CLI 形态的 JSON 文本；这里刻意不给 totalCount/totalPages（潜伏缺陷的触发条件）。
  const noScale = async (args) => JSON.stringify({ items: mk(Number(args[args.indexOf('--page-size') + 1])) });
  const r = await searchLobeHubMarket({ pageSize: 24, page: 1, run: noScale });
  check('缺失时 total 是 undefined（不拿 24 冒充总数）', r.total === undefined, 'total=' + r.total);
  check('缺失时 totalPages 是 undefined（不谎称共 1 页）', r.totalPages === undefined, 'totalPages=' + r.totalPages);
  check('本页条数不受影响', r.items.length === 24, 'items=' + r.items.length);
  const r2 = await searchLobeHubMarket({ pageSize: 2, page: 1, run: async () => JSON.stringify({ items: mk(2), totalCount: 127537, totalPages: 63769 }) });
  check('上游真给数时照常透传', r2.total === 127537 && r2.totalPages === 63769, 'total=' + r2.total + ' totalPages=' + r2.totalPages);
  const r3 = await searchLobeHubMarket({ pageSize: 2, page: 1, run: async () => JSON.stringify({ items: mk(2), totalCount: 0, totalPages: 0 }) });
  check('0 也不是规模证据', r3.total === undefined && r3.totalPages === undefined, 'total=' + r3.total + ' totalPages=' + r3.totalPages);
}


console.log('');
console.log('Test 10: LobeHub 规模未知时仍要说清还能不能翻页（D3 接线）');
{
  const LM = fs.readFileSync(path.resolve(W, 'src/lobehub-market.js'), 'utf8');
  const IX = fs.readFileSync(path.resolve(W, 'index.js'), 'utf8');
  const CL = fs.readFileSync(path.resolve(W, 'client.js'), 'utf8');
  check('lobehub 返回体带诚实 hasMore（本页取满即还有）',
    LM.includes('hasMore: items.length >= size'), '返回体里没有 hasMore：下一页会被永久禁用');
  const lb = IX.slice(IX.indexOf('async function loadLobeHubCatalog'), IX.indexOf('async function registerInstalledSkillToCatalog'));
  check('loadLobeHubCatalog 把 hasMore 透传出去（成功分支两处）',
    (lb.match(/hasMore: result\.hasMore/g) || []).length === 2, (lb.match(/hasMore: result\.hasMore/g) || []).length + ' 处');
  const cwAt = CL.indexOf('resultCacheRef.current[cacheKey] = { items: rows');
  check('MCP 缓存写入不再把本页条数当总数', cwAt > 0 && !CL.slice(cwAt, cwAt + 320).includes('total: d.total || rows.length'), cwAt < 0 ? '未找到 MCP 缓存写入点' : '缓存写进的就是窗口条数');
  check('LobeHub 专行走 pagerSummary 同一判据',
    CL.includes("pagerSummary({ label: 'LobeHub'"), '专行仍自己拼数量与 1/0 页');
  check('专行裸模板已消失（不再有 第 N/0 页）', !CL.includes('个连接器 · 第 ${mcpPage}/${mcpTotalPages} 页'), '仍在裸插 totalPages');
  const lmCalls = [];
  const stubRun = (data) => async () => JSON.stringify(data);
  {
    const items = [];
    for (let i = 0; i < 40; i++) items.push({ id: 'full' + i, identifier: 'full' + i, name: 'x' });
    const r = await searchLobeHubMarket({ query: 'lead-full', pageSize: 40, page: 1, run: stubRun({ items }) });
    check('本页取满 40 条且无 totalCount ⇒ hasMore 为真', r.hasMore === true, String(r.hasMore));
  }
  {
    const r = await searchLobeHubMarket({ query: 'lead-tail', pageSize: 40, page: 1, run: stubRun({ items: [{ id: 'a', identifier: 'a', name: 'x' }] }) });
    check('本页没取满 ⇒ hasMore 为假（真的到底了）', r.hasMore === false, String(r.hasMore));
  }
}

console.log('');
console.log('Test 11: 工具面 total 与 RPC 面同口径（D5）');
{
  const IX = fs.readFileSync(path.resolve(W, 'index.js'), 'utf8');
  check('工具面不再拿本页条数当总数', !IX.includes('total: catalog.total || items.length'), 'index.js 仍写着 catalog.total || items.length');
  check('工具面优先用估算总数（与 RPC 面一致）',
    IX.includes('total: catalog.estimatedTotal || catalog.total || undefined'), '工具面没有 estimatedTotal 口径');
  check('两面的 canLoadMore 判据同源（同一表达式两次）',
    (IX.match(/catalog\.hasMore !== undefined \? Boolean\(catalog\.hasMore\)/g) || []).length === 2, (IX.match(/catalog\.hasMore !== undefined/g) || []).length + ' 处');
  // 同缺陷的第二处：RPC 面也拿本页条数兜底（catalog.estimatedTotal || catalog.total || catalog.items.length）。
  check('RPC 面不再拿本页条数当总数', !IX.includes('catalog.total || catalog.items.length'), 'RPC 面仍在本页条数兜底');
  check('两面 total 口径为同一表达式', (IX.match(/total: catalog\.estimatedTotal \|\| catalog\.total \|\| undefined/g) || []).length === 2, '两面 total 写法不同');
  // canLoadMore 的回落分支也要锁：totalPages 未知时旧写法算成 page < 1 恒假，
  // 下一页被永久禁用 —— 与 hasMore 缺失时「不知道能不能翻」是两回事。
  check('两面 totalPages 未知时不回落成「只有 1 页」',
    (IX.match(/catalog\.totalPages \|\| Infinity/g) || []).length === 2 && !IX.includes('catalog.totalPages || 1'),
    (IX.match(/catalog\.totalPages \|\| Infinity/g) || []).length + ' 处 Infinity 回落');
}

console.log('');
console.log('Test 12: SkillHub 钳制后的请求页宽必须用于分页判据（D4）');
{
  const SH = fs.readFileSync(path.resolve(W, 'src/skillhub.js'), 'utf8');
  check('hasMore 不再与未钳制的入参比', !SH.includes('items.length >= pageSize'), '仍在用 pageSize 原值');
  check('hasMore 与钳制后的 size 比', SH.includes('items.length >= size'), '没换成 size');
  check('pageSize 字段回的是真实页宽', SH.includes('pageSize: size') && !SH.includes('pageSize: items.length || pageSize'), 'pageSize 仍拿本页条数或入参');
  check('上游没报 total 时不给数字', !SH.includes('Number(data.total ?? items.length) || items.length'), '仍拿本页条数兜底');
  let shSeen = null;
  globalThis.fetch = async (url) => {
    shSeen = String(url);
    const skills = [];
    for (let i = 0; i < 50; i++) skills.push({ slug: 'lead-s' + i, name: 'n', description: '', displayName: 'd' });
    const data = { skills };
    return { ok: true, status: 200, json: async () => ({ code: 0, message: 'success', data }), text: async () => JSON.stringify(data) };
  };
  try {
    const r = await searchSkills({ query: 'lead', source: 'skillhub', page: 1, pageSize: 60, cache: makeCache(dir) });
    check('请求实际发出去的页宽已钳到 50', /pageSize=50/.test(shSeen || ''), shSeen || '未发出请求');
    check('取满钳后页宽 ⇒ 还有下一页', r.hasMore === true, String(r.hasMore));
  } finally { delete globalThis.fetch; }
}

console.log('');
console.log('Test 13: browse.sh CLI 兜底窗口不得当总数（D6）');
{
  const SR = fs.readFileSync(path.resolve(W, 'src/sources.js'), 'utf8');
  const cli = SR.slice(SR.indexOf('if (cliRows.length) {'));
  check('CLI 分支不再把窗口条数当总数', !cli.slice(0, 1200).includes('total: cliItems.length'), 'total 仍是 cliItems.length');
  check('CLI 分支披露单次上限与总数未知', /CLI 单次最多返回 /.test(cli.slice(0, 1600)), 'hint 没写窗口上限');
}
console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
process.exit(failed ? 1 : 0);
