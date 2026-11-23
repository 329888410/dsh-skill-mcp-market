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
  check('只有 picked 多于一个源才传冷却时长', /cooldownMs: picked\.length > 1 \? AGGREGATE_COOLDOWN_MS : 0/.test(code), '');
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
console.log('Test 7: 面板单源路径永不进入冷却（用户 2026-11-23 决策：all 聚合只存在于工具，不能影响 UI 面板）');
{
  const calls = { lone: 0, slow: 0 };
  const handlers = {
    lone: async () => { calls.lone++; await sleep(400); return { items: [{ slug: 'l', name: 'l', source: 'lone' }], total: 1, totalPages: 1 }; },
    slow: async () => { calls.slow++; await sleep(5000); return { items: [{ slug: 's', name: 's', source: 'slow' }], total: 1, totalPages: 1 }; },
  };
  const cache = freshCache();
  // ① 面板形态：source 指定单源且该源注定超时 —— 同词连搜四次都必须真打上游
  const ps = { query: 'q', source: 'slow', page: 1, pageSize: 24, handlers, cache, budgetMs: 300 };
  const t1 = Date.now(); const r1 = await searchSkills(ps); const ms1 = Date.now() - t1;
  check('面板单源首次：预算内切断并如实 degraded', ms1 < 1500 && /slow/.test(dgOf(r1)), ms1 + 'ms ' + dgOf(r1));
  const t2 = Date.now(); const r2 = await searchSkills(ps); const ms2 = Date.now() - t2;
  check('面板单源第二次：仍真重试（calls.slow=2，没有被冷却短路）', calls.slow === 2, 'calls.slow=' + calls.slow);
  check('面板单源第二次：文案不再出现「冷却/不再重试/稍后」', !/冷却|不再重试|稍后/.test(dgOf(r2)), dgOf(r2));
  check('面板单源第二次：等待与首次同量级（不是被跳过后的瞬时）', ms2 >= ms1 / 3, '首次' + ms1 + 'ms 第二次' + ms2 + 'ms');
  await searchSkills(ps); await searchSkills(ps);
  check('面板单源第四次同词：累计四次全部打到上游', calls.slow === 4, 'calls.slow=' + calls.slow);
  // ② 对照组：同一个坏源走聚合路径（两个 handler ⇒ wanted>1），第二次仍要短路
  const agg = { query: 'q', source: 'all', page: 1, pageSize: 24, handlers, cache, budgetMs: 300 };
  calls.slow = 0;
  await searchSkills(agg);
  check('聚合首次：坏源真打上游', calls.slow === 1, 'calls.slow=' + calls.slow);
  const ta = Date.now(); const ra = await searchSkills(agg); const msa = Date.now() - ta;
  check('聚合第二次：冷却仍生效（不再打上游）', calls.slow === 1, 'calls.slow=' + calls.slow);
  check('聚合第二次：不再重付整段预算', msa < 150, msa + 'ms');
  check('聚合第二次：坏源仍如实进 degraded（冷却≠静默丢源）', (ra.degraded || []).some((d) => d.source === 'slow'), dgOf(ra));
  // ③ 直调 fanOutSources：不传 cooldownMs = 默认不冷却；显式传仍可启用
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
  check('合并键的预算段走 budgetKey（空表时逐字符等于旧的 String(budgetMs)）', /budgetKey\(picked, budgetMs, budgetOverrides\)/.test(code6) && /return same \? String\(budgetMs\)/.test(code6), '');
}

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
