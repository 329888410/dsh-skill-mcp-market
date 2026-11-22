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
// ③ clawhub search 取数口径（src/extra-sources.js:195-253）：上游 search 端点不认 page、
//    不报总数、limit 硬上限 100。Test 10 锁住「total 与页码无关」与「撞上限保持未知」。
import fs from 'node:fs';
import { makeCache, searchSkills } from '../src/sources.js';
import { searchClawHub } from '../src/extra-sources.js';
import { safeTempDir } from '../src/home.js';
import { blockEnd } from './anchor-lib.mjs';

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
    const endL = blockEnd(clientSrc, st, 'trustedTotal');
    const body = srcLines.slice(st, endL + 1).join(String.fromCharCode(10));
    const fn = new Function('return (' + body.slice(body.indexOf('('), body.lastIndexOf('}') + 1) + ')')();
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

console.log('');
console.log('Test 8: 卡片不得显示被复制出来的安装数（live 实测两数相等）');
{
  // live 实测（0.5.136 装好后，面板直连仍在跑的旧服务进程）：clawhub 卡片显示
  // 「283,509 次安装 · 283,509 次下载」，而上游同一行是 downloads=283,509、
  // installs=12,282 —— 两数相等正是 0.5.134 在服务端修掉的那个复制缺陷（installs
  // 被写成 downloads）。服务端修复要等模块重载，宿主永不重启，所以客户端必须自己
  // 拦：既然实测真实数据里两个字段不相等，那么相等就只能来自复制 → 宁可不显示
  // 安装数，也不显示一个错数。判据是结构性质（两字段是否同源相等），不是阈值。
  const clientSrc = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const cl = clientSrc.split(String.fromCharCode(10));
  const st = cl.findIndex((l) => l.trimStart().startsWith('const visibleCounts ='));
  check('client 存在 visibleCounts 判据', st >= 0, '未找到');
  if (st >= 0) {
    const endL = blockEnd(clientSrc, st, 'visibleCounts');
    const body = cl.slice(st, endL + 1).join(String.fromCharCode(10));
    const fn = new Function('return (' + body.slice(body.indexOf('('), body.lastIndexOf('}') + 1) + ')')();
    const a1 = fn({ installs: 283509, downloads: 283509 });
    check('两数相等 → 安装数不显示（被复制的假数）', a1.installs === null && a1.downloads === 283509, JSON.stringify(a1));
    const a2 = fn({ installs: 12282, downloads: 283509 });
    check('两数不同 → 各自如实显示', a2.installs === 12282 && a2.downloads === 283509, JSON.stringify(a2));
    const a3 = fn({ installs: 0, downloads: 283509 });
    check('安装数缺失（0）→ 仍不显示（原规则保留）', a3.installs === null && a3.downloads === 283509, JSON.stringify(a3));
    const a4 = fn({ installs: 90 });
    check('只有安装数（无下载字段）→ 照常显示', a4.installs === 90 && a4.downloads === null, JSON.stringify(a4));
    const a5 = fn({ installs: 5, downloads: 0 });
    check('downloads 为 0 时不构成同源证据', a5.installs === 5, JSON.stringify(a5));
    const wired = cl.filter((l) => l.indexOf('visibleCounts(') >= 0).length;
    check('技能卡与详情弹层都接线（至少 2 处调用）', wired >= 2, wired);
  }
}

console.log('');

console.log('');
console.log('Test 9: clawhub 的分类载体是 categories 数组（2026-11-22 复测：search 50/50、browse 49/49 行带非空 categories；topics 仅 browse 侧存在 27/49，category 键两侧均为 0）');
{
  // 取证修订（2026-11-22 实测，推翻 0.5.138 的三行样本结论）：search 行 50/50 带
  // categories（["knowledge"] 等）且 topics/category 键均为 0；browse 行 49/49 带
  // categories、topics 仅 27/49 非空、category 键 0。旧结论「上游无 category 键、
  // search 行也无 topics」来自当年的三行样本，措辞与今日实测不符；载体顺序相应修订为
  // 用动态 import：函数尚不存在时 ESM 静态 import 会让整个套件在链接期崩掉
  // （NO-SUMMARY），拿不到「具体哪条判据失败」的原文。
  let mod = null;
  let err = '';
  try { mod = await import('../src/extra-sources.js'); } catch (e) { err = String(e && e.message || e); }
  const fn = mod && mod.clawhubCategoryOf;
  check('extra-sources 导出 clawhubCategoryOf', typeof fn === 'function', err || '未导出');
  if (typeof fn === 'function') {
    check('topics 首项作为分类（小写）', fn({ topics: ['Self-Improvement', 'context'] }) === 'self-improvement', JSON.stringify(fn({ topics: ['Self-Improvement', 'context'] })));
    check('上游真给了 category 时优先用它', fn({ category: 'Dev', topics: ['x'] }) === 'Dev', JSON.stringify(fn({ category: 'Dev', topics: ['x'] })));
    check('topics 空数组 → 空（不编造分类）', fn({ topics: [] }) === '', JSON.stringify(fn({ topics: [] })));
    check('topics 非数组（tags 那种对象）→ 空', fn({ topics: { latest: '4.0.5' } }) === '', JSON.stringify(fn({ topics: { latest: '4.0.5' } })));
    check('search 行（两者皆无）→ 空', fn({ displayName: 'Pdf', downloads: 1 }) === '', '');
    check('空入参不抛', fn(null) === '' && fn(undefined) === '');
    check('首个空 topic 被跳过', fn({ topics: ['', ' GitHub '] }) === 'github', JSON.stringify(fn({ topics: ['', ' GitHub '] })));
    check('categories 首项作为分类（小写）', fn({ categories: ['Research', 'creative'] }) === 'research', JSON.stringify(fn({ categories: ['Research', 'creative'] })));
    check('categories 空数组 → 落到 topics（真实行上两者并存）', fn({ categories: [], topics: ['Context'] }) === 'context', JSON.stringify(fn({ categories: [], topics: ['Context'] })));
    check('categories 非数组 → 落到 topics', fn({ categories: 'knowledge', topics: ['Context'] }) === 'context', JSON.stringify(fn({ categories: 'knowledge', topics: ['Context'] })));
    check('categories 与 topics 都非空时优先取 categories（browse 行实测 27/49 如此）', fn({ categories: ['Research'], topics: ['Context'] }) === 'research', JSON.stringify(fn({ categories: ['Research'], topics: ['Context'] })));
  }
  // 接线：mapClawHubRows 必须调用它，而不是留着 raw.category 那个上游没有的键
  const esSrc = fs.readFileSync(new URL('../src/extra-sources.js', import.meta.url), 'utf8');
  check('mapClawHubRows 已接线', esSrc.indexOf('category: clawhubCategoryOf(raw)') >= 0, '');
  // 判据范围锁在 mapClawHubRows 体内：lobehub/trusttools 的上游行**真有** category
  // 字段（extra-sources.js:553 等处保留 raw.category 是对的），全文件一刀切禁止会把
  // 别的源的合法映射一起判死。
  const esLines = esSrc.split(String.fromCharCode(10));
  const mStart = esLines.findIndex((l) => l.trimStart().startsWith('function mapClawHubRows('));
  if (mStart < 0) throw new Error('mapClawHubRows 起点未找到');
  const mEnd = blockEnd(esSrc, mStart, 'mapClawHubRows');
  const mBody = esLines.slice(mStart, mEnd + 1).join(String.fromCharCode(10));
  check('mapClawHubRows 体内不再读上游不存在的 raw.category', mBody.indexOf('raw.category') < 0, '');
  check('mapClawHubRows 体内确实用 clawhubCategoryOf', mBody.indexOf('category: clawhubCategoryOf(raw)') >= 0, '');
}

console.log('');

console.log('');
console.log('Test 10: 分类过滤保留的「无分类信息条目」必须如实告知');
{
  // 实测：clawhub 选分类 douyin → 返回 18 条，其中 17 条 category 不是 douyin。
  // 因为本地过滤是 items.filter((i) => !i.category || i.category === needle)：
  // 没有分类信息的条目被**保留**（聚合 all 场景下这是必要的 —— 严格过滤会让
  // 不提供分类的源整源消失，那是数据丢失而不是过滤）。问题在于界面没说这件事，
  // 用户以为自己看到的是「douyin 的 18 条」。修法不是改过滤语义，而是把保留量
  // 写进 categoryNote，让计数与用户看到的东西对得上。
  const rows = [
    { slug: 'a', category: 'douyin' },
    { slug: 'b', category: '' },
    { slug: 'c', category: '' },
    { slug: 'd', category: 'tiktok' },
  ];
  const h = { cf: async () => ({ items: rows.slice(), total: rows.length, hasMore: false }) };
  const r = await searchSkills({ query: '', source: 'cf', page: 1, pageSize: 24, cache, handlers: h, category: 'douyin', budgetMs: 5000 });
  check('无分类条目仍保留（不整源丢失）', r.items.length === 3, r.items.map((x) => x.slug).join(','));
  check('真正匹配的条目在其中', r.items.some((x) => x.slug === 'a'));
  check('note 写明保留数量与原因（另有 2 项未标注分类）', /另有 2 项/.test(r.categoryNote || '') && /未标注分类/.test(r.categoryNote || ''), JSON.stringify(r.categoryNote));
  check('note 同时说明过滤掉的数量', /过滤掉 1/.test(r.categoryNote || ''), JSON.stringify(r.categoryNote));
  // 全都有分类且严格匹配时，不该出现「无分类信息」字样（避免噪声）
  const h2 = { cf2: async () => ({ items: [{ slug: 'x', category: 'a' }, { slug: 'y', category: 'b' }], total: 2, hasMore: false }) };
  const r2 = await searchSkills({ query: '', source: 'cf2', page: 1, pageSize: 24, cache, handlers: h2, category: 'a', budgetMs: 5000 });
  check('无保留项时不写无关说明', r2.categoryNote.indexOf('无分类信息') < 0, JSON.stringify(r2.categoryNote));
  check('该场景仍如实报过滤掉 1 条', /过滤掉 1/.test(r2.categoryNote || ''), JSON.stringify(r2.categoryNote));
  // 边界：本页条目全无分类信息时 filteredOut=0，旧写法一条说明都不给 ——
  // 用户选 douyin 却看到 0 条 douyin，同样是对不上的计数。
  const h3 = { cf3: async () => ({ items: [{ slug: 'p', category: 'x' }, { slug: 'q', category: '' }], total: 2, hasMore: false }) };
  const r3 = await searchSkills({ query: '', source: 'cf3', page: 1, pageSize: 24, cache, handlers: h3, category: 'nope', budgetMs: 5000 });
  check('无一匹配时保留量也如实告知', r3.items.length === 1 && /另有 1 项/.test(r3.categoryNote || ''), r3.items.length + ' / ' + JSON.stringify(r3.categoryNote));
}


console.log('');
console.log('Test 11: clawhub search 的 total/hasMore 不得随页码变化（上游无总数、page 被忽略）');
{
  // 实测上游 /api/v1/search：顶层只有 results（无 total/count）；page 参数被忽略
  // （page=1 与 page=2 首两条是同一批）；limit 生效但 100 是硬上限（limit=150..1000
  // 恒回 100 条），且 limit=10 的返回正好是 limit=100 的同序前缀。旧实现按 page 并发
  // 打 1–6 个假分页请求再拼窗口，实测 total 在页码之间跳（page1=11、page2=10）。
  const rows = (n, tag) => Array.from({ length: n }, (unused, i) => ({ id: tag + "-" + i, slug: tag + "-" + i, displayName: tag + "-" + i, ownerHandle: "o", installs: 5, downloads: 9 }));
  const mkHandler = (window) => async (url) => {
    const limit = Number(new URL(url).searchParams.get("limit"));
    return { results: window.slice(0, limit) };
  };
  const probe = async (window, ps) => {
    const out = [];
    for (const p of ps) {
      const r = await searchClawHub({ query: "pdf", page: p, pageSize: 10, cache: null, fetchJson: mkHandler(window) });
      out.push({ p: p, items: r.items.length, total: r.total, hasMore: r.hasMore, pages: r.totalPages, hint: r.hint });
    }
    return out;
  };
  const small = await probe(rows(37, "s"), [1, 2, 3, 4]);
  console.log('   实测(窗口 37): ' + JSON.stringify(small));
  const totals = new Set(small.map((x) => x.total));
  check('未撞上限时 total 与页码无关', totals.size === 1, [...totals].join(','));
  check('未撞上限时 total 就是窗口长度（该 query 的完整集合）', small[0].total === 37, String(small[0].total));
  check('第 4 页仍返回该页条目（不再翻到空页）', small[3].items === 7, String(small[3].items));
  check('不再谎报 wanted+1 这种下界', small.every((x) => x.total !== 11 && x.total !== 21 && x.total !== 31), small.map((x) => x.total).join(','));
  const big = await probe(rows(100, "b"), [1, 5, 10, 11]);
  console.log('   实测(撞 100 上限): ' + JSON.stringify(big));
  check('撞上限时 total 保持未知（既不报 100 也不报 101）', big.every((x) => x.total === undefined), big.map((x) => String(x.total)).join(','));
  check('撞上限时 pages 保持未知', big.every((x) => x.pages === undefined), big.map((x) => String(x.pages)).join(','));
  check('上限内仍可翻页（第 10 页有货）', big[2].items === 10, String(big[2].items));
  check('越过 100 条上限后不再承诺还有更多', big[3].items === 0 && big[3].hasMore === false, JSON.stringify(big[3]));
  check('撞上限时给出说明（用户知道为何没有总数）', typeof big[0].hint === 'string' && String(big[0].hint).includes('100'), String(big[0].hint));
  const urls = [];
  await searchClawHub({ query: "pdf", page: 3, pageSize: 24, cache: null, fetchJson: async (u) => { urls.push(u); return { results: rows(100, "u") }; } });
  check('单次请求取代多页并发（等待时间随之下降）', urls.length === 1, JSON.stringify(urls));
  check('请求带上 limit=100（窗口上限）', urls.length === 1 && Number(new URL(urls[0]).searchParams.get("limit")) === 100, urls[0]);
}
console.log('');
console.log('');
console.log('Test 12: clawhub 条目身份是 ownerHandle/slug 对，不是上游 raw.id 也不是安装路由');
{
  // 取证样本：100 条真实 search 行 + 119 条 browse 行（2026-11-22 直取 clawhub.ai，原文见
  // C:\Users\Public\dsh-scratch\clw-audit\raw-capture.json / raw-browse2.json）。
  //  · search 行 raw.id：57/100 自带 "clawhub:" 前缀（如 clawhub:kd75kdbc9phg92p12av465mbf1820dqb），
  //    另 43/100 是跨源形态 skills-sh:google/skills/<slug> —— 两种都不是 clawhub 自己的身份；
  //  · browse 行 raw.id：0/119 存在，身份只有 ownerHandle + slug（219/219 行两者齐全）；
  //  · 旧 id 公式 `clawhub:${raw.id || reference || raw.slug}` 于是同时产出
  //    clawhub:clawhub:<opaque> 与 clawhub:skills-sh:… 两种形态，而 item.id 正是翻页去重键
  //    （client.js:822 new Set(prev.map(x => x.id))）→ 同一技能跨 search/browse 被算成两条。
  //  · install.reference 是安装路由（跨源行是 skills-sh:<owner>/<repo>/<path>，不可改写），只能
  //    留在 installRef；实测 search 行 reference 末段 100/100 == raw.slug，故身份取自
  //    ownerHandle/slug 与安装路由同源可信。旧公式还把 reference 切段当卡片 slug/owner：
  //    40/100 行卡片 slug ≠ raw.slug、43/100 行卡片 owner 被切成 "skills-sh:google" 这类错值
  //    （卡片直接显示它，client.js:1727），100 行里 12 张卡共用 slug「superpowers」、10 张共用
  //    「skills」——安装名与「✓ 已安装」判定（client.js:1748 x.slug === item.slug）和 busy 键
  //    （client.js:1754 install:${item.slug}）因此串到别的卡片上。
  const mkRow = (o) => ({
    id: o.id,
    slug: o.slug,
    ownerHandle: o.owner,
    displayName: o.slug,
    summary: '一行简介',
    install: o.reference ? { reference: o.reference } : undefined,
    canonicalUrl: o.canonicalUrl,
    stats: { downloads: 10, installs: 2 },
  });
  const rows = [
    mkRow({ id: 'clawhub:kd75kdbc9phg92p12av465mbf1820dqb', owner: 'bestrocky', slug: 'proactive-agent-lite' }),
    mkRow({ id: 'skills-sh:google/skills/agent-platform-alert-configuration', owner: 'google-labs', slug: 'agent-platform-alert-configuration', reference: 'skills-sh:google/skills/agent-platform-alert-configuration', canonicalUrl: '/skills-sh/google/skills/agent-platform-alert-configuration' }),
    mkRow({ owner: 'why20261', slug: 'douyin-real-hot-rise' }),
  ];
  const r = await searchClawHub({ query: 'pdf', page: 1, pageSize: 24, cache: null, fetchJson: async () => ({ results: rows }) });
  const ids = r.items.map((x) => x.id);
  check('id 形态统一为 clawhub:<ownerHandle>/<slug>', ids.join('|') === 'clawhub:bestrocky/proactive-agent-lite|clawhub:google-labs/agent-platform-alert-configuration|clawhub:why20261/douyin-real-hot-rise', ids.join('|'));
  check('不再出现 clawhub:clawhub: 双前缀', ids.every((x) => !x.startsWith('clawhub:clawhub:')), ids.join('|'));
  check('id 不再直接采用上游跨源 raw.id', ids.every((x) => !x.includes('skills-sh:')), ids.join('|'));
  check('卡片 owner 用 raw.ownerHandle（不再被切成 skills-sh:google）', r.items.map((x) => x.owner).join('|') === 'bestrocky|google-labs|why20261', r.items.map((x) => x.owner).join('|'));
  check('卡片 slug 用 raw.slug（不再是安装路由第二段）', r.items.map((x) => x.slug).join('|') === 'proactive-agent-lite|agent-platform-alert-configuration|douyin-real-hot-rise', r.items.map((x) => x.slug).join('|'));
  check('installRef 保持上游安装路由原样', r.items[1].installRef === 'skills-sh:google/skills/agent-platform-alert-configuration', JSON.stringify(r.items[1].installRef));
  check('browse 形态 homepage 仍是 /<ownerHandle>/<slug>', r.items[2].homepage === 'https://clawhub.ai/why20261/douyin-real-hot-rise', r.items[2].homepage);
  // 同 slug 不同作者是两个技能：clawhub 落盘布局就是 @<owner>/<slug>（src/cli-install.js:136、:148，
  // src/skills.js:798 与 :874 以两层布局判卸载/恢复）。100 条真实 search 行里 distinct raw.slug
  // 只有 84（distinct 身份对 100），去重键退回裸 slug 就会在合并/目录流里静默丢 16 条。
  const twin = [mkRow({ owner: 'alice', slug: 'pdf-tools' }), mkRow({ owner: 'bob', slug: 'pdf-tools' })];
  const t = await searchClawHub({ query: 'twin', page: 1, pageSize: 24, cache: null, fetchJson: async () => ({ results: twin }) });
  check('同 slug 不同作者是两条（去重键含作者）', t.items.length === 2, JSON.stringify(t.items.map((x) => x.id)));
  // 用动态 import：函数尚不存在时静态 import 会让整个套件在链接期崩掉（NO-SUMMARY），
  // 拿不到「具体哪条判据失败」的原文（同 Test 9 的写法）。
  let mod = null;
  let mErr = '';
  try { mod = await import('../src/extra-sources.js'); } catch (e) { mErr = String((e && e.message) || e); }
  const idOf = mod && mod.clawhubIdOf;
  check('extra-sources 导出 clawhubIdOf', typeof idOf === 'function', mErr || '未导出');
  if (typeof idOf === 'function') {
    // CLI 降级行只有字符串 owner（extra-sources.js:226 造 {name,owner,displayName,slug}，既无
    // ownerHandle 也无 install.reference）。本机未装 clawhub CLI（spawnSync clawhub ENOENT），
    // 该路径不能 live 测，因此直接判定纯函数，不许产出 clawhub:undefined/…
    check('CLI 降级行回落字符串 owner', idOf({ owner: 'octo', slug: 'x' }) === 'octo/x', idOf({ owner: 'octo', slug: 'x' }));
    check('身份缺任一段时不造假 id', idOf({ slug: 'x' }) === '' && idOf({ ownerHandle: 'o' }) === '', JSON.stringify([idOf({ slug: 'x' }), idOf({ ownerHandle: 'o' })]));
    check('ownerHandle 优先于 owner 对象（search 行 57/100 带 {handle,…}）', idOf({ ownerHandle: 'o', owner: { handle: 'h' }, slug: 's' }) === 'o/s', idOf({ ownerHandle: 'o', owner: { handle: 'h' }, slug: 's' }));
    // owner 对象没有 ownerHandle 时也必须取 .handle：String(对象) 会产出 "[object Object]"，
    // 那会拼出 id "clawhub:[object Object]/x" 并让「✓ 已安装」判定（client.js:1748）永远不命中。
    check('owner 对象取 .handle（不写 [object Object]）', idOf({ owner: { handle: 'h' }, slug: 's' }) === 'h/s', idOf({ owner: { handle: 'h' }, slug: 's' }));
    check('owner 对象无 handle 时不造假 id', idOf({ owner: {}, slug: 's' }) === '', idOf({ owner: {}, slug: 's' }));
  }
  const esSrc = fs.readFileSync(new URL('../src/extra-sources.js', import.meta.url), 'utf8');
  const esLines = esSrc.split(String.fromCharCode(10));
  const mStart = esLines.findIndex((l) => l.trimStart().startsWith('function mapClawHubRows('));
  check('mapClawHubRows 起点存在', mStart >= 0, String(mStart));
  const mBody = esLines.slice(mStart, blockEnd(esSrc, mStart, 'mapClawHubRows') + 1).join(String.fromCharCode(10));
  check('mapClawHubRows 体内不再把 raw.id 当身份', mBody.indexOf('raw.id ||') < 0, '');
  check('mapClawHubRows 体内改用 clawhubIdOf', mBody.indexOf('clawhubIdOf(raw)') >= 0, '');
  // browse 目录累加器不吃 fetchJson（:181/:346 直调 getJsonClawHub），无法注入，只能上文本锁。
  // 取函数体不能用 anchor-lib 的 blockEnd：warmClawHubCatalog(cache, options = {}) 与
  // searchClawHub({ query = "", ... }) 的签名里带内层花括号，深度在签名行就归零，blockEnd
  // 会把起点自身当成结尾（实测 end==start），取到的体只有一行、判据恒假。这里改成「扫到下
  // 一个 0 列 } 行」；esLines 按 \n 切开后每行结尾仍带 \r，裸比较 '}' 永远不等，必须先剥。
  const esClean = esSrc.split(String.fromCharCode(10)).map((l) => l.replace(/\r$/, ''));
  const bodyOf = (fn) => {
    const s = esClean.findIndex((l) => l.trimStart().startsWith('async function ' + fn + '(') || l.trimStart().startsWith('export async function ' + fn + '('));
    check(fn + ' 起点存在', s >= 0, String(s));
    let e = s + 1;
    while (e < esClean.length && esClean[e] !== '}') e++;
    return esClean.slice(s, e + 1).join(String.fromCharCode(10));
  };
  for (const fn of ['extendClawHubCatalog', 'warmClawHubCatalog', 'searchClawHub']) {
    const body = bodyOf(fn);
    check(fn + ' 去重键改用 clawhubIdOf（不再 raw.id/raw.slug）', body.indexOf('clawhubIdOf(raw)') >= 0 && body.indexOf('raw.id ?? raw.slug') < 0, '');
  }
}
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);

