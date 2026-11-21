#!/usr/bin/env node
// test-clawhub-quality.mjs — TDD: clawhub 无界流在聚合层触发的两处口径缺陷。
//
// 两处根因都用真实代码 + 真实上游坐实（本轮实测，不是推断）：
//
// ① 聚合层的 total 反推兜底（src/sources.js:626）。clawhub browse 是 cursor 无界流，
//    handler 明确把 total/totalPages 置为 undefined 来表示「未知」
//    （extra-sources.js:253-260 的注释就写着：谎报一个下界会让用户以为目录就这么大）。
//    聚合层却把 undefined 当成「没报总数」，兜底成 p*size+1。实测：
//      page=1 total=13 / page=2 total=25 / page=3 total=37 / page=60 total=721
//    总数随用户翻页线性增长 —— 一个几千条的目录被显示成「共约 13 个」。
//    既有契约（test-search-fanout-latency Test 13）已经锁住另一半：items=0 不得造数、
//    handler 报 total=0 且有货时仍要反推下界。所以本文件不另立判据，只做对齐：
//    区分点是 handler 有没有**显式声明未知**（total 为 undefined），不是魔法阈值。
//
// ② 聚合层的二次重排（src/sources.js:599-604）。extra-sources.js:223 的既有契约写着
//    「单源排序责任在 handler，dispatcher 只对多源聚合排序」，但这段代码无条件执行，
//    而且用的是原始 sort 而不是 effectiveSort：上游 sort=name 是码位序，dispatcher 再
//    localeCompare 一遍，实测结果与上游顺序完全不一致（码位升序=false、
//    localeCompare 升序=true）；supportsSort 为假时 effectiveSort 为空（注释说要
//    「降级为不排序，保持上游顺序」），这段却照排不误。
import fs from 'node:fs';
import { makeCache, searchSkills } from '../src/sources.js';
import { safeTempDir } from '../src/home.js';

let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  ' + String(d).slice(0, 160) : '')); } };
const cache = makeCache(safeTempDir());
const mk = (n, p) => Array.from({ length: n }, (unused, i) => ({ slug: 's' + p + '-' + i, name: 's' + p + '-' + i }));

console.log('');
console.log('Test 1: handler 显式声明未知总数时，聚合层必须保持未知');
{
  const unknown = { u: async (o) => ({ items: mk(12, o.page), total: undefined, totalPages: undefined, hasMore: true }) };
  const rows = [];
  for (const page of [1, 2, 3, 60]) {
    const r = await searchSkills({ query: '', source: 'u', page, pageSize: 12, cache, handlers: unknown, budgetMs: 5000 });
    rows.push({ page: page, total: r.total, pages: r.pages, items: r.items.length, hasMore: r.hasMore });
  }
  console.log('   实测: ' + JSON.stringify(rows));
  check('显式未知的 total 不随页码增长', rows.every((x) => x.total === undefined), rows.map((x) => String(x.total)).join(','));
  check('显式未知的 pages 保持未知', rows.every((x) => x.pages === undefined), rows.map((x) => String(x.pages)).join(','));
  check('条目仍正常返回（未知不等于失败）', rows.every((x) => x.items === 12));
  check('hasMore 保留（分页器据此走窗口式）', rows.every((x) => x.hasMore === true));
}

console.log('');
console.log('Test 2: 复述既有 Test 13 契约（不得因 Test 1 的修复而回归）');
{
  const zero = { z: async (o) => ({ items: mk(12, o.page), total: 0, hasMore: true }) };
  const r = await searchSkills({ query: '', source: 'z', page: 2, pageSize: 12, cache, handlers: zero, budgetMs: 5000 });
  check('未声明未知（total=0）时保留计数下界', r.total >= 24, 'total=' + r.total);
  const dead = { d: async () => ({ items: [], total: 0 }) };
  const totals = [];
  for (const page of [1, 2, 3]) {
    const rr = await searchSkills({ query: '', source: 'd', page, pageSize: 12, cache, handlers: dead, budgetMs: 5000 });
    totals.push(rr.total);
  }
  check('空结果 total 恒为 0（Test 13 原样）', totals.every((x) => x === 0), totals.join(','));
}

console.log('');
console.log('Test 3: 单源路径聚合层不得改变条目顺序（handler 负责排序）');
{
  // 码位序样本：大写 Z 开头的名称按码位排在小写 a 之前，localeCompare 会把它挪到后面。
  const CODEPOINT = ['Zeta', 'alpha', 'beta', 'iota', 'omega'];
  const single = { c: async () => ({ items: CODEPOINT.map((x) => ({ slug: x.toLowerCase(), name: x })), total: CODEPOINT.length, hasMore: false }) };
  const r = await searchSkills({ query: '', source: 'c', page: 1, pageSize: 12, cache, handlers: single, sort: 'name', budgetMs: 5000 });
  const got = r.items.map((x) => x.name).join(',');
  check('单源 name 排序保持上游（码位）顺序', got === CODEPOINT.join(','), 'got ' + got);
  check('未被 localeCompare 改写：Zeta 仍在首位', r.items[0].name === 'Zeta', 'first=' + r.items[0].name);
  const byIns = { i: async () => ({ items: [
    { slug: 'x', name: 'x', installs: 90 },
    { slug: 'y', name: 'y', installs: 80 },
    { slug: 'w', name: 'w', installs: 100 },
  ], total: 3, hasMore: false }) };
  const r3 = await searchSkills({ query: '', source: 'i', page: 1, pageSize: 12, cache, handlers: byIns, sort: 'installCount', budgetMs: 5000 });
  check('单源 installCount 不再二次重排', r3.items.map((x) => x.slug).join(',') === 'x,y,w', r3.items.map((x) => x.slug).join(','));
}

console.log('');
console.log('Test 4: 该源不支持该排序键时必须真的不排（effectiveSort 降级）');
{
  // skillsmp 只支持 name：按 downloadCount 请求时 effectiveSort 为空，handler 保持上游序，
  // 聚合层若仍用原始 sort 判定就会把列表打乱 —— 与 557 行注释相反。
  const upstream = ['u1', 'u2', 'u3'].map((x) => ({ slug: x, name: x, installs: 5 }));
  const sm = { skillsmp: async () => ({ items: upstream.slice(), total: 3, hasMore: false }) };
  const r = await searchSkills({ query: '', source: 'skillsmp', page: 1, pageSize: 12, cache, handlers: sm, sort: 'downloadCount', budgetMs: 5000 });
  check('不支持的键不改顺序', r.items.map((x) => x.slug).join(',') === 'u1,u2,u3', r.items.map((x) => x.slug).join(','));
}

console.log('');
console.log('Test 5: 多源聚合仍须本地排（不得把另一半契约一起删掉）');
{
  const multi = {
    ma: async () => ({ items: [{ slug: 'a1', name: 'a1', installs: 5 }], total: 1, hasMore: false }),
    mb: async () => ({ items: [{ slug: 'b1', name: 'b1', installs: 90 }], total: 1, hasMore: false }),
    mc: async () => ({ items: [{ slug: 'c1', name: 'c1', installs: 40 }], total: 1, hasMore: false }),
  };
  const r = await searchSkills({ query: '', source: 'all', page: 1, pageSize: 12, cache, handlers: multi, sort: 'installCount', budgetMs: 5000 });
  check('聚合结果按安装数降序', r.items.map((x) => x.slug).join(',') === 'b1,c1,a1', r.items.map((x) => x.slug).join(','));
}

console.log('');

console.log('');
console.log('Test 6: 客户端不得把未知总数冒充成本页条数');
{
  // 服务端保持 undefined 之后，client 的 setSkillsTotal(Number(d.total) || rows.length)
  // 会把「未知」变成本页 12 条并显示「共约 12 个」—— 与谎报下界同一种不诚实。
  // 判据是完整表达式（不是裸变量名，避免 skillsTotal/skillsTotalPages 子串冒充）。
  const clientPath = new URL('../client.js', import.meta.url);
  const client = fs.readFileSync(clientPath, 'utf8');
  const fabricate = [
    'setSkillsTotal(Number(d.total) || rows.length)',
    'setSkillsTotal(cached.total || (cached.items || []).length)',
    'setMcpTotal(d.total || rows.length)',
    'setMcpTotal(cached.total || (cached.items || []).length)',
  ];
  const still = fabricate.filter((s) => client.indexOf(s) >= 0);
  check('四处未知冒充本页条数都已消失', still.length === 0, still.join(' | '));
  check('技能侧写入前先过不信任校验', client.indexOf('setSkillsTotal(Number(trustedTotal(d.total,') >= 0);
  check('MCP 侧同口径（不只修一侧）', client.indexOf('setMcpTotal(Number(trustedTotal(d.total,') >= 0 && client.indexOf('setMcpTotal(Number(trustedTotal(cached.total,') >= 0);
  // pagerSummary 语义未被改坏：total 0 + unknown 不渲染数量子句（既有纯函数判据复用）
  const fanout = fs.readFileSync(new URL('./test-search-fanout-latency.mjs', import.meta.url), 'utf8');
  // pagerSummary 的「total<=0 不渲染数量子句」规则留在 client.js 注释里（既有纯函数判据
  // 由 test-search-fanout-latency Test 10 持有），这里只确认那条规则没被本次改动删掉。
  check('pagerSummary 的未知不渲染数量子句规则仍在', client.indexOf('不渲染数量子句') >= 0, '');
}


console.log('');
console.log('Test 7: client 侧对服务端 total 做不信任校验（宿主不重启也能诚实）');
{
  // 服务端修复要等模块重载才生效，而宿主永不重启：live 实测装完 0.5.135 后
  // 翻 clawhub 仍显示「共约 25 个 → 共约 49 个」（旧进程里 p*size+1 的兜底）。
  // 客户端因此必须自己能识别这类数：真实总数与页码无关，同一视图里各页报告的
  // 总数一旦不同，那个数就是按页码算出来的 → 宁可不显示数量，也不显示假数。
  // 判据是结构性质（是否随页变化），不是「大于某值就算假」这种魔法阈值。
  const clientSrc = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const srcLines = clientSrc.split(String.fromCharCode(10));
  const st = srcLines.findIndex((l) => l.trimStart().startsWith('const trustedTotal ='));
  check('client 存在 trustedTotal 判据', st >= 0, '未找到');
  if (st >= 0) {
    const tail = srcLines.slice(st, st + 10).join(String.fromCharCode(10));
    const from = tail.indexOf('(');
    const upto = tail.indexOf('};', from);
    const fn = new Function('return (' + tail.slice(from, upto + 1) + ')')();
    check('首页透传报告值', fn(25, 25, 1) === 25, String(fn(25, 25, 1)));
    check('后续页与基准一致则可信', fn(25, 25, 3) === 25, String(fn(25, 25, 3)));
    check('随页增长的数不可信', fn(25, 49, 2) === undefined, String(fn(25, 49, 2)));
    check('随页变化的数一律不可信（含变小）', fn(500, 480, 2) === undefined, String(fn(500, 480, 2)));
    check('基准未知时不猜', fn(undefined, 13, 2) === undefined, String(fn(undefined, 13, 2)));
    check('页码非法按首页处理', fn(13, 13, 0) === 13, String(fn(13, 13, 0)));
    const wired = srcLines.filter((l) => l.indexOf('trustedTotal(') >= 0).length;
    check('技能与 MCP 两侧都接线（至少 2 处调用）', wired >= 2, wired);
  }
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);

