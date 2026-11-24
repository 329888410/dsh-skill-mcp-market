#!/usr/bin/env node
// test-search-latency-recovery.mjs — 重复搜索为什么还等 12s：源冷却 + 在途合并。
//
// 实测基线（本机真实网络、面板同一条代码路径 src/sources.js:588 → fanOutSources:554，
// C:\\Users\\Public\\dsh-scratch\\perf-base.log，job pwsh-c443464d05f74628，budgetMs=12000 未改）：
//   A1 冷 12008ms degraded=[clawhub,trusttools]
//   A2 同参数第二次 12005ms degraded=[clawhub,trusttools,browse.sh]
//   A3 第三次 12007ms（热/冷 = 1.0x —— 缓存没救到等待）
//   A4 page=2 12011ms ｜ A5 换词冷 12013ms ｜ A6 换词热 12010ms
//   B 单源各自独立冷缓存：lobehub 1 / skillhub 1 / modelscope 1 / clawhub 2 / skillsmp 2 /
//     browse.sh 11 / skills.sh 9010 / trusttools 12010（items=0，撞满预算）
//   单源之和 21038ms vs 聚合 12008ms ⇒ 并发已生效（省 9030ms），聚合 wall = max(最慢源)，
//   而最慢那个源是注定失败的 trusttools。
// ⇒ 六次全部 12.0s ≈ budgetMs：sources.js:556-566 对超时没有记忆，每轮搜索都把坏源重新
//   等满一遍预算；同时同一条件的并发请求各打各的（全仓无在途合并，AbortController 只在
//   fetchJson 内部）。仓库里已有同类做法的先例：src/enrich.js:89-115 skillmd_miss 24h 负缓存。
//
// 本套件全部用注入 handler，零网络，CI 可重复；判据是行为，不是文案。
import { makeCache, searchSkills } from '../src/sources.js';
import { absent } from './anchor-lib.mjs';
import { safeTempDir } from '../src/home.js';

let passed = 0, failed = 0;
const check = (n, cond, d) => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d !== undefined ? '  [' + String(d).slice(0, 170) + ']' : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freshCache = () => makeCache(safeTempDir() + '/lat-' + Math.random().toString(36).slice(2));
const dgOf = (r) => (r.degraded || []).map((d) => d.source + '|' + String(d.error || '')).join(' ');

console.log('Test 1: 超时源进入短冷却，第二次同条件不再付预算');
{
  const calls = { dead: 0, ok1: 0 };
  const handlers = {
    dead: async () => { calls.dead++; await sleep(5000); return { items: [{ slug: 'd', name: 'd', source: 'dead' }], total: 1, totalPages: 1 }; },
    ok1: async () => { calls.ok1++; return { items: [{ slug: 'o', name: 'o', source: 'ok1' }], total: 1, totalPages: 1 }; },
  };
  const cache = freshCache();
  const ps = { query: 'q', source: 'all', page: 1, pageSize: 24, handlers, cache, budgetMs: 300 };
  const t1 = Date.now(); const r1 = await searchSkills(ps); const ms1 = Date.now() - t1;
  check('首次：坏源在预算内被切断', ms1 < 1500, ms1 + 'ms');
  check('首次：坏源 degraded 写明超时', /超时|timeout/i.test(dgOf(r1)) && /dead/.test(dgOf(r1)), dgOf(r1));
  const t2 = Date.now(); const r2 = await searchSkills(ps); const ms2 = Date.now() - t2;
  check('第二次：不再重付预算（等待与首次差一个量级）', ms2 < ms1 / 3, '首次' + ms1 + 'ms 第二次' + ms2 + 'ms');
  check('第二次：上游确实没有被重新问（calls.dead 仍为 1）', calls.dead === 1, 'calls.dead=' + calls.dead);
  check('第二次：坏源仍如实进 degraded（冷却≠静默丢源）', (r2.degraded || []).some((d) => d.source === 'dead'), dgOf(r2));
  check('第二次：文案如实写明本轮不再重试（冷却/稍后）', /不再重试|冷却|稍后/.test(dgOf(r2)), dgOf(r2));
  check('第二次：健康源条目不受影响', r2.items.map((i) => i.slug).join(',') === 'o', JSON.stringify(r2.items));
  check('第二次：槽位数不减（results 仍按 names 折叠）', r2.total <= 1 && Number(r2.total) === 1, r2.total);
  check('健康源每次都真取（结果缓存责任在 handler，本层不越权缓存）', calls.ok1 === 2, 'calls.ok1=' + calls.ok1);
}

console.log('');
console.log('Test 2: 只有「等满预算」才冷却；抛错/空结果绝不进冷却');
{
  const calls = { boom: 0, empty: 0 };
  const handlers = {
    boom: async () => { calls.boom++; throw new Error('上游 503'); },
    empty: async () => { calls.empty++; return { items: [], total: 0, totalPages: 0, hint: '上游没有匹配' }; },
  };
  const cache = freshCache();
  const ps = { query: 'q', source: 'all', page: 1, pageSize: 24, handlers, cache, budgetMs: 300 };
  await searchSkills(ps);
  const r2 = await searchSkills(ps);
  check('抛错源每次都真重试（不进冷却）', calls.boom === 2, 'calls.boom=' + calls.boom);
  check('抛错源错误原文保留（与 test-search-fanout-latency Test 2 同口径）', /503/.test(dgOf(r2)), dgOf(r2));
  check('真实空结果不是失败：绝不进冷却', calls.empty === 2, 'calls.empty=' + calls.empty);
  check('真实空结果不产生 degraded', !(r2.degraded || []).some((d) => d.source === 'empty'), dgOf(r2));
}

console.log('');
console.log('Test 3: 冷却窗口到期后自动重试（TTL 是上限不是永久）');
{
  const calls = { dead: 0 };
  // 冷却只在聚合路径开启（Test 7），窗口测试因此多带一个健康 handler 凑成多源。
  const handlers = { dead: async () => { calls.dead++; await sleep(5000); return { items: [], total: 0 }; }, ok: async () => ({ items: [{ slug: 'k', name: 'k', source: 'ok' }], total: 1, totalPages: 1 }) };
  const cache = freshCache();
  const ps = { query: 'q', source: 'all', page: 1, pageSize: 24, handlers, cache, budgetMs: 300 };
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    await searchSkills(ps);
    check('窗口内：跳过上游', calls.dead === 1, 'calls.dead=' + calls.dead);
    await searchSkills(ps);
    check('窗口内：两次调用仍只有一次打到上游', calls.dead === 1, 'calls.dead=' + calls.dead);
    offset = 119000;
    await searchSkills(ps);
    check('未到期（119s）：仍跳过上游', calls.dead === 1, 'calls.dead=' + calls.dead);
    offset = 121000;
    await searchSkills(ps);
    check('到期（121s）：必须重新尝试', calls.dead === 2, 'calls.dead=' + calls.dead);
  } finally { Date.now = realNow; }
}

console.log('');
console.log('Test 4: 同条件并发在途合并，不同条件绝不合并');
{
  const seen = [];
  const mk = (name, delay) => async (opts) => {
    seen.push(name + ':' + String(opts.query || '') + ':' + opts.page + ':' + (opts.sort || '') + ':' + (opts.category || ''));
    await sleep(delay);
    return { items: [{ slug: name, name, source: name }], total: 1, totalPages: 1 };
  };
  const handlers = { a: mk('a', 120), b: mk('b', 120) };
  const cache = freshCache();
  const base = { query: 'agent', source: 'all', page: 1, pageSize: 24, handlers, cache };
  const [x, y] = await Promise.all([searchSkills(base), searchSkills(base)]);
  check('同条件并发只打上游一次', seen.filter((s) => s.startsWith('a:')).length === 1, seen.join(','));
  check('两个调用方都拿到完整结果（不是只有发起者）', x.items.length === 2 && y.items.length === 2, x.items.length + '/' + y.items.length);
  check('共享结果不得互相污染（各自 items 数组独立）', x.items !== y.items, '同一引用');
  await searchSkills({ ...base, page: 2 });
  check('page 不同必须各打各的', seen.filter((s) => s.startsWith('a:')).length === 2, seen.join(','));
  await searchSkills({ ...base, query: 'pdf' });
  check('query 不同必须各打各的', seen.filter((s) => s.startsWith('a:')).length === 3, seen.join(','));
  await searchSkills({ ...base, sort: 'stars' });
  check('sort 不同必须各打各的', seen.filter((s) => s.startsWith('a:')).length === 4, seen.join(','));
  await searchSkills({ ...base, category: 'dev' });
  check('category 不同必须各打各的', seen.filter((s) => s.startsWith('a:')).length === 5, seen.join(','));
  await searchSkills(base);
  check('在途结束后同条件再来必须重新取（合并≠永久缓存）', seen.filter((s) => s.startsWith('a:')).length === 6, seen.join(','));
}

console.log('');
console.log('Test 5: 源码锁 —— 冷却与合并必须写在真实实现里');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src/sources.js'), 'utf8').replace(/\r\n/g, String.fromCharCode(10));
  const call = src.slice(src.indexOf('await fanOutSources({'), src.indexOf('await fanOutSources({') + 420);
  const hasCacheArg = call.split(String.fromCharCode(10)).some((l) => l.trim() === 'cache,' || l.trim() === 'cache');
  check('调用 fanOutSources 时把 cache 交进去（冷却需要它）', hasCacheArg, JSON.stringify(call.slice(0, 140)));
  check('冷却键前缀存在', src.indexOf('market_src_timeout') >= 0, '');
  // 冷却归属由源码锁住：默认关、只有聚合路径显式开（剥注释，否则被解释文字骗过）。
  const code = src.split(String.fromCharCode(10)).filter((l) => {
    const t = l.trimStart();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  }).join(String.fromCharCode(10));
  check('fanOutSources 默认不冷却（cooldownMs = 0）', /cooldownMs = 0[,}]/.test(code), '');
  check('聚合冷却时长是具名常量', /const AGGREGATE_COOLDOWN_MS = 120000;/.test(code), '');
  check('只有聚合路径才传冷却时长（单源恒 0）', /const aggregate = picked\.length > 1;/.test(code) && /cooldownMs: aggregate \? AGGREGATE_COOLDOWN_MS : 0/.test(code), '');
  check('源码锁：单源路径的预算恒为 0（面板永不被截断）', /const fanBudget = aggregate \? budgetMs : 0;/.test(code) && /budgetMs: fanBudget,/.test(code), '');
  check('源码锁：单源路径不带上游预算表（否则表里的值会绕过 0）', /const fanOverrides = aggregate \? budgetOverrides : null;/.test(code) && /budgetOverrides: fanOverrides,/.test(code), '');
  check('在途合并表在 settle 时清除（合并 ≠ 永久缓存）', /inflight[A-Za-z]*\.delete\(/.test(src), '');
  check('既有超时文案保持不变（其它套件的判据依赖它）', src.indexOf('来源响应超时（预算 ') >= 0, '');
}


console.log('');
console.log('Test 6: 死分支移除后，槽位契约与冷却短路仍然成立');
{
  // M5 反向破坏（去掉 names 同名 merged 复用）跑出 29 passed 0 failed —— 说明 picked 永不含重复名，
  // 那 3 行是测不到的死分支。移除它之后必须锁两件事：槽位长度/顺序契约不变，冷却短路仍然生效。
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src/sources.js'), 'utf8').replace(/\r\n/g, String.fromCharCode(10));
  // firstIdx 是纯标识符，必须走 absent()（test-anchor-lib 的裸子串否定断言守卫）：
  // 裸 !src.includes('firstIdx') 会被未来任何含 firstIdx 前缀的更长标识符误红。
  check('死分支确已移除（不再有 merged / firstIdx）', src.indexOf('const merged = new Map();') < 0 && absent(src, 'firstIdx'), '');
  check('冷却短路仍在（cooldownNow 命中直接进 cooldown 槽）', /cooldownNow\[i\] \? Promise\.resolve\(\{ cooldown: true \}\)/.test(src), '');
  const { fanOutSources } = await import('../src/sources.js');
  let n = 0;
  const dup = await fanOutSources({
    names: ['dead', 'dead', 'ok'],
    budgetMs: 300,
    run: async (name) => { n++; if (name === 'dead') { await sleep(5000); return { source: 'dead' }; } return { source: 'ok', items: [1] }; },
  });
  check('names 含重复名时 results/degraded 槽位数不变', dup.results.length === 3 && dup.degraded.length === 2, JSON.stringify({ r: dup.results.length, d: dup.degraded.length }));
  check('重复名两次都真取上游（不再有隐式复用；picked 实际不含重复）', n === 3, 'n=' + n);
  check('同名的两条 degraded 文案都是超时（不是冷却）', dup.degraded.every((x) => /已跳过/.test(x.error) && !/冷却中/.test(x.error)), dgOf(dup));
}

console.log('');
console.log('');
console.log('Test 7: 面板单源路径既不截断也不冷却（用户 2026-11-24 口径：不管快慢，都得等待面板加载完毕）');
{
  const calls = { lone: 0, slow: 0 };
  const handlers = {
    lone: async () => { calls.lone++; await sleep(400); return { items: [{ slug: 'l', name: 'l', source: 'lone' }], total: 1, totalPages: 1 }; },
    slow: async () => { calls.slow++; await sleep(700); return { items: [{ slug: 's', name: 's', source: 'slow' }], total: 1, totalPages: 1 }; },
  };
  const cache = freshCache();
  // ① 面板形态：单源 + 显式小预算 ⇒ 预算必须被忽略，等到真返回
  const ps = { query: 'q', source: 'slow', page: 1, pageSize: 24, handlers, cache, budgetMs: 300 };
  const t1 = Date.now(); const r1 = await searchSkills(ps); const ms1 = Date.now() - t1;
  check('面板单源：预算被忽略，条目真到手', r1.items.length === 1 && r1.items[0].source === 'slow', 'items=' + r1.items.length + ' ' + JSON.stringify(r1.items.map((i) => i.source)));
  check('面板单源：degraded 必须为空（不再出现「已跳过」）', (r1.degraded || []).length === 0, dgOf(r1));
  check('面板单源：真实等待而非 300ms 截断', ms1 >= 600, ms1 + 'ms');
  check('面板单源：sourceErrors 不再谎称没找到', JSON.stringify(r1.sourceErrors) === '[]', JSON.stringify(r1.sourceErrors));
  const t2 = Date.now(); const r2 = await searchSkills(ps); const ms2 = Date.now() - t2;
  check('面板单源第二次：仍真重试（calls.slow=2，没有被冷却短路）', calls.slow === 2, 'calls.slow=' + calls.slow);
  check('面板单源第二次：文案不再出现「冷却/不再重试/稍后/已跳过」', !/冷却|不再重试|稍后|已跳过/.test(dgOf(r2) + JSON.stringify(r2.sourceErrors)), dgOf(r2));
  check('面板单源第二次：等待与首次同量级', ms2 >= ms1 / 3, '首次' + ms1 + 'ms 第二次' + ms2 + 'ms');
  await searchSkills(ps); await searchSkills(ps);
  check('面板单源第四次同词：累计四次全部打到上游', calls.slow === 4, 'calls.slow=' + calls.slow);
  // ② 对照组：同一个慢源走聚合路径（两个 handler ⇒ wanted>1），预算与冷却都必须照旧生效
  const agg = { query: 'q', source: 'all', page: 1, pageSize: 24, handlers, cache, budgetMs: 300 };
  calls.slow = 0; calls.lone = 0;
  await searchSkills(agg);
  check('聚合首次：慢源真打上游', calls.slow === 1, 'calls.slow=' + calls.slow);
  const ta = Date.now(); const ra = await searchSkills(agg); const msa = Date.now() - ta;
  check('聚合第二次：冷却仍生效（不再打上游）', calls.slow === 1, 'calls.slow=' + calls.slow);
  check('聚合第二次：不再重付整段预算', msa < 150, msa + 'ms');
  check('聚合第二次：坏源仍如实进 degraded（冷却≠静默丢源）', (ra.degraded || []).some((d) => d.source === 'slow'), dgOf(ra));
  // ③ 直调 fanOutSources：底层预算能力保留（聚合与工具路径仍可用）
  const { fanOutSources } = await import('../src/sources.js');
  let direct = 0;
  const dcache = freshCache();
  const dargs = { names: ['slow'], budgetMs: 300, cache: dcache, cooldownKey: 'q', run: async () => { direct++; await sleep(5000); return { items: [], total: 0 }; } };
  await fanOutSources(dargs); await fanOutSources(dargs);
  check('直调不传 cooldownMs：默认不冷却（两次都真取）', direct === 2, 'direct=' + direct);
  let explicit = 0;
  const eargs = { names: ['slow'], budgetMs: 300, cache: dcache, cooldownKey: 'q', cooldownMs: 120000, run: async () => { explicit++; await sleep(5000); return { items: [], total: 0 }; } };
  await fanOutSources(eargs); await fanOutSources(eargs);
  check('显式传 cooldownMs：冷却能力仍在（第二次被短路）', explicit === 1, 'explicit=' + explicit);
}

console.log('');
console.log('Test 8: 每源预算可配置，但默认表为空 ⇒ 可见结果逐条不变（效率项「不改变可见结果」那半）');
{
  const mk = (delay, slug, n) => async () => { calls8[slug] = (calls8[slug] || 0) + 1; await sleep(delay); return { items: [{ id: slug + '1', slug: slug + '1', name: slug + '1', source: slug }, { id: slug + '2', slug: slug + '2', name: slug + '2', source: slug }], total: n || 2, totalPages: 1 }; };
  let calls8 = {};
  const h8 = { slow: mk(2500, 'slow'), a: mk(200, 'a'), b: mk(200, 'b') };
  const dgSlugs = (r) => (r.items || []).map((i) => i.slug).join(',');
  // ① 基线：统一预算 1000ms —— slow 超时，a/b 正常回
  const base = { query: 'q8', source: 'all', page: 1, pageSize: 24, handlers: h8, cache: freshCache(), budgetMs: 1000 };
  const t0 = Date.now(); const rBase = await searchSkills(base); const msBase = Date.now() - t0;
  check('基线（无 overrides）：slow 超时进 degraded，a/b 条目齐全', dgOf(rBase).includes('slow|来源响应超时（预算 1s），已跳过') && dgSlugs(rBase) === 'a1,a2,b1,b2', dgOf(rBase) + ' items=' + dgSlugs(rBase));
  // ② 只给 slow 单独设预算（其余仍是调用方的 1000）：条目集合与基线逐条相同，文案写它自己那一份预算
  const only = { query: 'q8', source: 'all', page: 1, pageSize: 24, handlers: h8, cache: freshCache(), budgetMs: 1000, budgetOverrides: { slow: 1000 } };
  const rOnly = await searchSkills(only);
  check('overrides 与默认值相等时：items 集合与 total 逐条等于基线', dgSlugs(rOnly) === dgSlugs(rBase) && rOnly.total === rBase.total, dgSlugs(rOnly) + ' total=' + rOnly.total + ' vs ' + dgSlugs(rBase) + ' total=' + rBase.total);
  check('overrides 与默认值相等时：degraded 文案逐字符等于基线（可见结果零变化）', dgOf(rOnly) === dgOf(rBase), dgOf(rOnly) + ' vs ' + dgOf(rBase));
  // ③ 单独放宽 slow：只多回来 slow 那两条，a/b 一字不变
  const wide = { query: 'q8', source: 'all', page: 1, pageSize: 24, handlers: h8, cache: freshCache(), budgetMs: 1000, budgetOverrides: { slow: 5000 } };
  const t1 = Date.now(); const rWide = await searchSkills(wide); const msWide = Date.now() - t1;
  check('给慢源单独放宽预算：该源条目回来（这才是这套机制的用意）', dgSlugs(rWide) === 'slow1,slow2,a1,a2,b1,b2' && rWide.degraded.length === 0, dgSlugs(rWide) + ' ' + dgOf(rWide));
  check('放宽后只等该源的真实耗时，不受调用方 1000ms 预算误砍', msWide >= 2400 && msWide < 4600, msWide + 'ms 基线' + msBase + 'ms');
  const dgA = (r) => (r.items || []).filter((i) => i.source !== 'slow').map((i) => i.slug).join(',');
  check('其余源的条目不因某源预算变化而改变（不是把结果搅乱）', dgA(rWide) === dgSlugs(rBase).replace('b1,b2', 'b1,b2') && dgA(rWide) === 'a1,a2,b1,b2', dgA(rWide));
  // ③b 两个慢源各配各的预算：降级文案里的秒数必须是该源自己的预算，判定也必须按各自的值。
  const two = {
    slow: async () => { await sleep(5000); return { items: [{ slug: 'slow1', name: 's', source: 'slow' }], total: 1, totalPages: 1 }; },
    middling: async () => { await sleep(4000); return { items: [{ slug: 'mid1', name: 'm', source: 'middling' }], total: 1, totalPages: 1 }; },
    a: async () => ({ items: [{ slug: 'a1', name: 'A', source: 'a' }], total: 1, totalPages: 1 }),
  };
  const r7 = await searchSkills({ query: 'q8two', source: 'all', page: 1, pageSize: 24, handlers: two, cache: freshCache(), budgetMs: 1000, budgetOverrides: { slow: 5200, middling: 2000 } });
  const slugs7 = dgSlugs(r7);
  check('各自预算：放宽到 5.2s 的源按时回来（不是整批共用调用方的 1s）', slugs7.indexOf('slow1') >= 0, slugs7);
  check('各自预算：只放宽到 2s 的源仍被自己那一份砍掉（不是整批共用 5.2s）', slugs7.indexOf('mid1') < 0, slugs7);
  const dg7 = (r7.degraded || []).map((x) => x.source + '|' + x.error).join(' || ');
  check('降级文案按各自的预算写秒数', dg7.indexOf('middling|来源响应超时（预算 2s），已跳过') >= 0, dg7);
  check('降级文案里不许出现调用方的 1s（那会把实际等了 2s 的源说成 1s）', dg7.indexOf('预算 1s）') < 0, dg7);
  // ④ 表里没有这个源 / 值不是正数 ⇒ 原样用调用方预算（默认路径不可能被表污染）
  const junk = { query: 'q8', source: 'all', page: 1, pageSize: 24, handlers: h8, cache: freshCache(), budgetMs: 1000, budgetOverrides: { slow: 0, a: '12000', b: null } };
  const rJunk = await searchSkills(junk);
  check('表里的 0/字符串/null 一律不生效（等价于不传）', dgSlugs(rJunk) === dgSlugs(rBase) && dgOf(rJunk) === dgOf(rBase), dgSlugs(rJunk) + ' ' + dgOf(rJunk));
  // ⑤ 在途合并：预算段进键后，同条件仍只打一次；不同预算表不合并
  calls8 = {};
  const c8 = freshCache();
  const pair = { query: 'q8m', source: 'all', page: 1, pageSize: 24, handlers: { a: mk(120, 'a'), b: mk(120, 'b') }, cache: c8, budgetMs: 3000 };
  await Promise.all([searchSkills(pair), searchSkills(pair)]);
  check('空表下同条件并发仍合并（每个源只打一次上游）', calls8.a === 1 && calls8.b === 1, JSON.stringify(calls8));
  calls8 = {};
  await Promise.all([searchSkills({ ...pair, query: 'q8m' }), searchSkills({ ...pair, query: 'q8m', budgetOverrides: { a: 9000 } })]);
  check('预算表不同 ⇒ 合并键不同（各打各的，不会把不同口径的结果互相顶替）', calls8.a === 2, JSON.stringify(calls8));
  // ⑥ 源码锁：默认值提常量、默认表为空、文案按该源自己的预算算秒数
  const fs2 = await import('node:fs');
  const path2 = await import('node:path');
  const src = fs2.readFileSync(path2.resolve(import.meta.dirname, '..', 'src/sources.js'), 'utf8').replace(/\r\n/g, String.fromCharCode(10));
  const code6 = src.split(String.fromCharCode(10)).filter((l) => { const t = l.trimStart(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); }).join(String.fromCharCode(10));
  check('默认预算是具名常量且等于 12000（现状没被动过）', /const DEFAULT_BUDGET_MS = 12000;/.test(code6), '');
  check('默认可配置表必须是空表（非空就是改变用户可见行为，需另立版本与口径）', /const SOURCE_BUDGET_OVERRIDES = \{\};/.test(code6), '');
  check('fanOutSources 与 searchSkills 的默认值都取自常量，不再是裸 12000', (code6.match(/budgetMs = DEFAULT_BUDGET_MS/g) || []).length === 2, String((code6.match(/budgetMs = DEFAULT_BUDGET_MS/g) || []).length));
  check('两条超时文案的秒数按该源实际预算算（否则多源文案会说谎）', (code6.match(/Math\.round\(budgetFor\(name, budgetMs, budgetOverrides\) \/ 1000\)/g) || []).length === 2 && code6.indexOf('Math.round(budgetMs / 1000)') < 0, '');
  check('超时判定用解析后的预算 b（不是整批共用一个 budgetMs）', /const b = budgetFor\(name, budgetMs, budgetOverrides\);/.test(code6) && /setTimeout\(\(\) => resolve\(\{ timeout: true \}\), b\)/.test(code6), '');
  check('合并键的预算段走 budgetKey（单源恒为 "0"，与聚合不串）', /budgetKey\(picked, fanBudget, fanOverrides\)/.test(code6) && /return same \? String\(budgetMs\)/.test(code6), '');
}

console.log('');
console.log('Test 9: 空结果与取数失败必须可区分（非空 query 不再吞掉失败披露，S1）');
{
  // 真实形态取自 0.5.161 逐源 sweep（C:/Users/Public/dsh-scratch/probe161-sweep.log）：
  //   trusttools/lobehub 撞满预算、skillhub HTTP 400、clawhub python traceback、browse.sh fetch failed。
  // 判据是 searchSkills 的返回值，不是文案正则：同一批 handler、只差 query 是否为空。
  const shapes = {
    tmo: async () => { await sleep(400); return { items: [], total: 0 }; },
    http: async () => { throw new Error('SkillHub HTTP 400'); },
    script: async () => { throw new Error('python 取数失败：Traceback (most recent call last):' + String.fromCharCode(10) + '  File ' + String.fromCharCode(34) + '<string>' + String.fromCharCode(34) + ', line 4, in <module>' + String.fromCharCode(10) + '    with urllib.request.urlopen(req) as r:'); },
    net: async () => { throw new Error('fetch failed'); },
    okEmpty: async () => ({ items: [], total: 0, totalPages: 1 }),
  };
  const seOf = (r) => (r.sourceErrors || []).join(' | ');
  const byName = (r, n) => (r.sourceErrors || []).find((x) => x.startsWith(n + '：')) || '';
  const psFail = { query: 'pdf', source: 'all', page: 1, pageSize: 24, handlers: shapes, cache: freshCache(), budgetMs: 120 };
  const rA = await searchSkills(psFail);
  check('(a) 非空 query + 四个源取数失败：sourceErrors 必须逐源点名', (rA.sourceErrors || []).length === 4, JSON.stringify(rA.sourceErrors) + ' degraded=' + dgOf(rA));
  check('(a) 不许把上游失败说成「没有找到匹配的技能」', !/没有找到匹配的技能/.test(seOf(rA)), seOf(rA));
  check('(a) 撞满预算的源说「响应超时」并带该源预算秒数', /响应超时/.test(byName(rA, 'tmo')), byName(rA, 'tmo'));
  check('(a) 上游回 4xx 的源报出状态码（不是笼统不可达）', /HTTP 400/.test(byName(rA, 'http')), byName(rA, 'http'));
  check('(a) 取数脚本异常只说脚本异常，不把 traceback 喷进面板', /取数脚本异常/.test(byName(rA, 'script')) && !/Traceback/.test(byName(rA, 'script')), byName(rA, 'script'));
  check('(a) 网络连接失败如实说不可达', /网络连接失败|不可达/.test(byName(rA, 'net')), byName(rA, 'net'));
  check('(a) 披露文案单行且不超过 80 字（截断只作兜底）', (rA.sourceErrors || []).every((x) => x.length <= 80 && !/[\r\n\t]/.test(x)), JSON.stringify((rA.sourceErrors || []).map((x) => x.length)));
  check('(a) 成功但空的源不得混进失败披露', !/okEmpty/.test(seOf(rA)), seOf(rA));
  const allOk = { query: 'pdf', source: 'all', page: 1, pageSize: 24, handlers: { okEmpty: shapes.okEmpty }, cache: freshCache(), budgetMs: 120 };
  const rB = await searchSkills(allOk);
  check('(b) 全部成功、确实没匹配：仍要说没有匹配', /没有/.test(seOf(rB)) && (rB.sourceErrors || []).length === 1, JSON.stringify(rB.sourceErrors));
  check('(b) 不许谎报上游不可达（没有任何源失败）', !/不可达|超时|HTTP|脚本/.test(seOf(rB)), seOf(rB));
  const psBlank = { ...psFail, query: '', cache: freshCache() };
  const rC = await searchSkills(psBlank);
  check('(c) 空 query + 取数失败：点名失败源的老行为不回归', (rC.sourceErrors || []).length === 4 && /tmo：/.test(seOf(rC)), JSON.stringify(rC.sourceErrors));
  const rD = await searchSkills({ ...allOk, query: '', cache: freshCache() });
  check('(d) 空 query + 全源正常空：仍是「暂时没有取到数据」口径', /暂时没有取到数据/.test(seOf(rD)), seOf(rD));
  // (e) 上游原文超长时（真实 clawhub traceback / 长 timeout 文案都能到几百字），单条披露必须被
  // 压回一行 80 字以内，而且截断不许吞掉真实原因——这锁的是 describeFailure 的最后兜底。
  const huge = '来源响应超时（预算 12s），已跳过 ' + '详'.repeat(200);
  const rE = await searchSkills({ query: 'pdf', source: 'all', page: 1, pageSize: 24, handlers: { huge: async () => { throw new Error(huge); } }, cache: freshCache(), budgetMs: 120 });
  check('(e) 上游原文再长，单条披露也压回 80 字以内且不含换行', (rE.sourceErrors || []).length === 1 && (rE.sourceErrors[0] || '').length <= 80 && !/[\r\n]/.test(rE.sourceErrors[0] || ''), JSON.stringify((rE.sourceErrors || []).map((x) => x.length)));
  check('(e) 截断不许吞掉真实原因（超时仍写成超时）', /响应超时/.test(seOf(rE)), seOf(rE).slice(0, 90));
  const fs9 = await import('node:fs');
  const path9 = await import('node:path');
  const src9 = fs9.readFileSync(path9.resolve(import.meta.dirname, '..', 'src/sources.js'), 'utf8').replace(/\r\n/g, String.fromCharCode(10));
  const code9 = src9.split(String.fromCharCode(10)).filter((l) => { const t = l.trimStart(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); }).join(String.fromCharCode(10));
  check('源码锁：查询词非空不再是屏蔽失败披露的条件（旧判据整行消失）', !/items\.length > 0 \|\| String\(query/.test(code9), '');
  check('源码锁：失败披露走逐源分类函数（不是一个 slice 截断了事）', (code9.match(/describeFailure\(entry\.source, entry\.error\)/g) || []).length === 1, String((code9.match(/describeFailure/g) || []).length));
}

console.log('');
console.log('Test 10: 面板必须完整呈现（浏览态给满一页、搜索态给全匹配集，预算值不得改变可见集合）');
{
  // 用户 2026-11-24 口径：「技能市场的UI面板必须完整地呈现所有技能，在搜索时完整地呈现所有搜索结果」。
  // 判据形状：同一个 handler、只差 budgetMs 与超时预算的关系 —— 可见条目、total、页码必须逐条相同。
  const rows = (n, tag) => Array.from({ length: n }, (_, i) => ({ slug: tag + i, name: tag + i, source: 'full', installs: n - i }));
  let mode = 'browse';
  const calls9 = { full: 0 };
  const handlers9 = {
    full: async (a) => {
      calls9.full++;
      await sleep(700);
      if (mode === 'browse') return { items: rows(24, 'b'), total: 89020, totalPages: 3710 };
      return { items: rows(7, 's'), total: 7, totalPages: 1 };
    },
  };
  const cache9 = freshCache();
  const shape = (r) => r.items.map((i) => i.slug).join(',') + '|' + r.total + '|' + r.page + '|' + r.pageSize + '|' + (r.pages === undefined ? 'undef' : r.pages) + '|' + (r.hasMore === undefined ? 'undef' : r.hasMore);
  mode = 'browse';
  const bNo = await searchSkills({ query: '', source: 'full', page: 1, pageSize: 24, handlers: handlers9, cache: cache9 });
  const bCut = await searchSkills({ query: '', source: 'full', page: 1, pageSize: 24, handlers: handlers9, cache: cache9, budgetMs: 300 });
  check('浏览态：一页 24 条必须一条不少（旧口径下预算 300ms 会砍成 0 条）', bNo.items.length === 24 && bCut.items.length === 24, '无预算=' + bNo.items.length + ' 小预算=' + bCut.items.length);
  check('浏览态：上游 total 原样保留，不被预算截断改写', bNo.total === 89020 && bCut.total === 89020, '无预算=' + bNo.total + ' 小预算=' + bCut.total);
  check('浏览态：有无预算两次可见结果逐字符相同', shape(bNo) === shape(bCut), shape(bNo) + ' vs ' + shape(bCut));
  check('浏览态：两次都不许出现 degraded/hint 类截断文案', dgOf(bNo) === '' && dgOf(bCut) === '', dgOf(bCut));
  mode = 'search';
  const sNo = await searchSkills({ query: 'pdf', source: 'full', page: 1, pageSize: 24, handlers: handlers9, cache: cache9 });
  const sCut = await searchSkills({ query: 'pdf', source: 'full', page: 1, pageSize: 24, handlers: handlers9, cache: cache9, budgetMs: 300 });
  check('搜索态：匹配集必须给全（7 条就是 7 条）', sNo.items.length === 7 && sCut.items.length === 7, '无预算=' + sNo.items.length + ' 小预算=' + sCut.items.length);
  check('搜索态：total 说清匹配总数且无下一页', sNo.total === 7 && sNo.hasMore === false && sCut.total === 7 && sCut.hasMore === false, 'hasMore=' + sNo.hasMore + '/' + sCut.hasMore + ' total=' + sNo.total + '/' + sCut.total);
  check('搜索态：有无预算两次可见结果逐字符相同', shape(sNo) === shape(sCut), shape(sNo) + ' vs ' + shape(sCut));
  check('搜索态：条目顺序即上游顺序（未被本地聚合排序搅乱）', sNo.items.map((i) => i.slug).join(',') === Array.from({ length: 7 }, (_, i) => 's' + i).join(','), sNo.items.map((i) => i.slug).join(','));
  check('四次调用全部真打上游（单源无冷却 ⇒ 面板每次刷新都重新取数）', calls9.full === 4, 'calls=' + calls9.full);
  mode = 'browse';
  const bOv = await searchSkills({ query: '', source: 'full', page: 1, pageSize: 24, handlers: handlers9, cache: cache9, budgetMs: 12000, budgetOverrides: { full: 50 } });
  check('浏览态：某源预算覆盖也不能砍单源（overrides 里 50ms 必须被忽略）', bOv.items.length === 24 && shape(bOv) === shape(bNo), 'items=' + bOv.items.length + ' ' + shape(bOv));
  mode = 'search';
  const sOv = await searchSkills({ query: 'pdf', source: 'full', page: 1, pageSize: 24, handlers: handlers9, cache: cache9, budgetMs: 12000, budgetOverrides: { full: 50 } });
  check('搜索态：同上，覆盖表不得让单源少给条目', sOv.items.length === 7 && shape(sOv) === shape(sNo), 'items=' + sOv.items.length + ' ' + shape(sOv));
}

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
