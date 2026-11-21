#!/usr/bin/env node
// test-search-fanout-latency.mjs — 市场搜索/排序/分类的等待时间与计数口径。
//
// 实测基线（本机 live RPC，20s 上限）：
//   skills.sh 7136ms | clawhub 2070ms | lobehub 4777ms | trusttools >20000ms（不可达）
//   全部来源聚合 >20000ms（超时，拿不到结果）
// 根因（src/sources.js:520-544）：聚合是 `for (const name of wanted) { await handler(...) }`
// **串行**，总耗时 = 各源之和；一个不可达源就把它自己的 fetchText 默认 20s 全额加到用户
// 的等待上。8 个源串行 → 冷启动必然超过 60s RPC 超时，用户看到「转圈直到失败」。
//
// 优化目标（都是可测性质，不是「感觉变快了」）：
//   P1 并发聚合：总耗时 ≈ 最慢单源，而不是各源之和；
//   P2 每源预算：不可达源在预算内被记为 degraded，不拖死整次搜索；
//   P3 确定性：并发完成后仍按 ALL_SOURCES 顺序折叠（items/degraded/hints 都不因完成先后而变）；
//   P4 计数口径：本地分类过滤掉了条目时，pages/total 必须按过滤后的真实集合重算，
//      不能继续报过滤前的页数（那是与实际不符的计数）。
// 并行化实现为可注入纯函数（fake handler 驱动），不依赖网络，CI 上可重复。
// 动态 import：静态 import 在缺导出时会在模块实例化阶段就抛 SyntaxError，
// 整个套件一条断言都跑不到 —— 那看起来像「加载错误」，实际是 RED 没被读出来。
import { sliceBetween, countHits, absent } from './anchor-lib.mjs';
let fanOutSources = null, searchSkills = null, importError = '';
try {
  const mod = await import('../src/sources.js');
  fanOutSources = mod.fanOutSources || null;
  searchSkills = mod.searchSkills || null;
} catch (e) { importError = String(e.message || e).slice(0, 120); }

let passed = 0, failed = 0;
const check = (n, cond, d) => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 170) + ']' : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('Test 1: fanOutSources 并发（fake handler，无网络）');
if (typeof fanOutSources !== 'function') {
  check('fanOutSources 已导出', false, typeof fanOutSources);
} else {
  const slow = 300;
  const fast = 60;
  const names = ['a', 'b', 'c', 'd'];
  const run = async (name) => { await sleep(name === 'a' ? slow : fast); return { items: [{ slug: name, name }], total: 1 }; };
  // 阈值不靠拍的数字：本机实测并发 303-314ms、串行 490-498ms，可分区间 (314, 490]。
  // 但绝对毫秒数随机器负载漂移，所以主判据用「同一组 fake 下并发必须快于串行」这种
  // 相对测量；绝对上界只用来兜住 fanOutSources 自己引入的额外等待。
  const serialMs = (async () => { const t = Date.now(); for (const n of names) await run(n); return Date.now() - t; })();
  const concMs = (async () => { const t = Date.now(); await fanOutSources({ names, run }); return Date.now() - t; })();
  const sMs = await serialMs, cMs = await concMs;
  check('并发严格快于串行（相对判据，不受机器绝对速度影响）', cMs < sMs, '并发' + cMs + 'ms vs 串行' + sMs + 'ms');
  check('并发接近最慢单源（绝对上界 slow+100）', cMs < slow + 100, cMs + 'ms');
  // 阈值可分辨性锁：串行必须落在那个绝对上界之外，否则上面的断言就是形同虚设
  // （机器突然变慢、或 fake 时长被改小时，这条会先响，而不是让并发断言假绿）。
  check('串行确实超过绝对上界（阈值可分辨）', sMs > slow + 100, '串行' + sMs + 'ms 未超过 ' + (slow + 100) + 'ms');
  check('并发结果数完整', (await fanOutSources({ names, run })).results.length === names.length);
  const out = await fanOutSources({ names, run });
  check('返回顺序与 names 一致', out.results.map((r) => r.name).join(',') === 'a,b,c,d', out.results.map((r) => r.name).join(','));
  check('每项带 ok/结果', out.results.every((r) => typeof r.ok === 'boolean' && r.result), JSON.stringify(out.results[0]).slice(0, 90));
  check('全部成功时 degraded 为空', out.degraded.length === 0, JSON.stringify(out.degraded).slice(0, 90));
}

console.log('');
console.log('Test 2: 每源预算与失败隔离');
if (typeof fanOutSources !== 'function') { check('（依赖 Test 1）', false); } else {
  const run = async (name) => {
    if (name === 'dead') await sleep(5000);
    else if (name === 'boom') throw new Error('上游 503');
    return { items: [{ slug: name, name }], total: 1 };
  };
  const t0 = Date.now();
  const out = await fanOutSources({ names: ['dead', 'ok1', 'boom'], run, budgetMs: 400 });
  const ms = Date.now() - t0;
  check('不可达源在预算内被切断', ms < 1200, ms + 'ms');
  check('超时源记为 degraded 且写明超时', out.degraded.some((d) => d.source === 'dead' && /超时|timeout/i.test(d.error)), JSON.stringify(out.degraded).slice(0, 140));
  check('抛错源记为 degraded 并保留原错误', out.degraded.some((d) => d.source === 'boom' && /503/.test(d.error)), JSON.stringify(out.degraded).slice(0, 140));
  check('健康源结果不受影响', out.results.find((r) => r.name === 'ok1').ok === true);
  check('degraded 顺序也按 names', out.degraded.map((d) => d.source).join(',') === 'dead,boom', out.degraded.map((d) => d.source).join(','));
}

console.log('');
console.log('Test 3: searchSkills 走并发且不改变折叠语义');
{
  const handlers = {
    s1: async () => { await sleep(200); return { items: [{ slug: 'x', name: 'x', source: 's1' }], total: 1, totalPages: 1 }; },
    s2: async () => ({ items: [{ slug: 'y', name: 'y', source: 's2' }], total: 1, totalPages: 1 }),
    s3: async () => { throw new Error('不可达'); },
  };
  if (typeof searchSkills !== 'function') { check('searchSkills 可注入 handlers', false); } else {
    const t0 = Date.now();
    const r = await searchSkills({ query: '', source: 'all', page: 1, pageSize: 24, handlers });
    const ms = Date.now() - t0;
    check('searchSkills 接受 handlers 注入', Array.isArray(r.items), typeof r.items);
    check('并发后总耗时 < 各源之和', ms < 320, ms + 'ms（串行需 ≥200ms 且 s3 失败仍要等）');
    check('items 按 names 顺序折叠（s1 先于 s2）', r.items.map((i) => i.slug).join(',') === 'x,y', r.items.map((i) => i.slug).join(','));
    check('失败源进 degraded 且不影响其它源', r.degraded.some((d) => /不可达/.test(d.error)) && r.items.length === 2, JSON.stringify(r.degraded).slice(0, 120));
    check('total 累加健康源', r.total >= 2, r.total);
  }
}

console.log('');
console.log('Test 4: 本地分类过滤后计数口径重算（P4）');
{
  const handlers = {
    a: async () => ({ items: [
      { slug: 'a1', name: 'a1', category: 'dev' },
      { slug: 'a2', name: 'a2', category: 'doc' },
      { slug: 'a3', name: 'a3', category: 'dev' },
    ], total: 3, totalPages: 1 }),
  };
  if (typeof searchSkills !== 'function') { check('（依赖 Test 3）', false); } else {
    const r = await searchSkills({ query: '', source: 'a', page: 1, pageSize: 24, category: 'dev', handlers });
    const visible = r.items.length;
    check('过滤确实生效', visible === 2, visible);
    // 本地分类过滤只作用于当前页：继续报过滤前的 total/pages 就是与实际不符的计数。
    // 诚实口径 = 不虚报总数（total 不得大于上游值，且必须反映本页可见数），
    // 页数按可见集合重算，并且明确告诉用户这个过滤是本地兜底。
    check('过滤掉的数量如实暴露', Number(r.filteredOut) === 1, JSON.stringify(r.filteredOut));
    check('total 不高于上游声明值', r.total <= 3, 'total=' + r.total);
    check('total 反映本页可见数（本地过滤后不再虚高）', r.total === visible, 'total=' + r.total + ' visible=' + visible);
    check('pages 按过滤后可见集合重算', r.pages === Math.max(1, Math.ceil(visible / 24)), 'pages=' + r.pages);
    check('本地过滤留了说明', /本地|当前页/.test(r.categoryNote || ''), JSON.stringify(r.categoryNote));
  }
}

console.log('');
console.log('Test 5: 既有契约不破');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const W = path.resolve(import.meta.dirname, '..');
  const src = fs.readFileSync(path.join(W, 'src/sources.js'), 'utf8');
  const c = fs.readFileSync(path.join(W, 'client.js'), 'utf8');
  // 必须剥掉注释再判：fanOutSources 的文档注释里原样写着
  // 「原来是 for (const name of wanted) { await handler(...) } —— 串行」，
  // 直接对全文跑正则会被自己的解释文字骗过（假阳性与假阴性都可能）。
  const stripComments = (text) => text
    .split(String.fromCharCode(10))
    .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*') && !line.trimStart().startsWith('/*'))
    .join(String.fromCharCode(10));
  const code = stripComments(src);
  check('串行 for-await 聚合已消失（剥注释后判定）', !/for \(const name of wanted\)/.test(code) && !/await handler\(/.test(code), '');
  // 回归锁：注释里确实留着同样字样，剥注释后必须不再命中 —— 证明判定看的是代码不是文字。
  check('注释含同样字样时不误报（剥注释有效）',
    /for \(const name of wanted\) \{ await handler\(/.test(src) && !/for \(const name of wanted\)/.test(code),
    'src含=' + /for \(const name of wanted\) \{ await handler\(/.test(src) + ' code含=' + /for \(const name of wanted\)/.test(code));
  check('本地排序兜底仍在', /if \(sort === .installCount.\) \{/.test(src) && /items\.sort\(\(a, b\) => \(Number\(b\.installs\)/.test(src));
  check('enrich 兜底仍在', /await enrichSkillsShFast\(missing, cache, 10\)/.test(src));
  check('sourceErrors 空结果解释仍在', /sourceErrors/.test(src) && /不可达/.test(src));
  check('warmMarketCache 未被改动破坏', /export async function warmMarketCache/.test(src));
  // 已装列表排序必须走内存，不得触发任何 RPC（「排序不触发全量重扫」）
  const si = c.indexOf('const sortedInstalled = sortInstalled(filteredInstalled');
  check('已装排序是纯内存派生', si > 0 && c.slice(si, si + 700).indexOf('call(') < 0, si);
}

console.log('');
console.log('Test 6: 分页窗口数学（从 client.js 抽取真跑）');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const W = path.resolve(import.meta.dirname, '..');
  const c = fs.readFileSync(path.join(W, 'client.js'), 'utf8');
  const s = c.indexOf('const pageWindow = (page, n, span) =>');
  check('pageWindow 已抽出为纯函数', s > 0, s);
  if (s > 0) {
    let depth = 0, q = 0, end = -1;
    for (let i = s; i < c.length; i++) {
      const ch = c.charCodeAt(i);
      if (q) { if (ch === 92) i++; else if (ch === q) q = 0; continue; }
      if (ch === 39 || ch === 34 || ch === 96) { q = ch; continue; }
      if (ch === 123) depth++;
      else if (ch === 125) { depth--; if (depth === 0) { end = i; break; } }
    }
    // 声明语句不能当表达式包（new Function('return (const f = ...)') 直接 SyntaxError）。
    // 正确形态：把整段当函数体执行，再 return 那个名字。
    const fn = new Function(c.slice(s, end + 1) + String.fromCharCode(10) + ' return pageWindow;')();
    check('首页窗口含 1 与末页', fn(1, 25, 5).includes(1) && fn(1, 25, 5).includes(25), JSON.stringify(fn(1, 25, 5)));
    check('末页窗口含 N', fn(25, 25, 5).includes(25), JSON.stringify(fn(25, 25, 5)));
    check('中间页不越界（无 0 页、无 N+1）', fn(10, 25, 5).every((v) => v === '…' || (v >= 1 && v <= 25)), JSON.stringify(fn(10, 25, 5)));
    check('单页时只有 1', JSON.stringify(fn(1, 1, 5)) === '[1]', JSON.stringify(fn(1, 1, 5)));
    check('未知总页数(n=0)走窗口式且不含 0', fn(3, 0, 5).every((v) => typeof v === 'number' ? v >= 1 : true) && fn(3, 0, 5).length > 0, JSON.stringify(fn(3, 0, 5)));
    check('省略号只在真有跨度时出现', !fn(1, 3, 5).includes('…'), JSON.stringify(fn(1, 3, 5)));
  }
}

console.log('');
console.log('Test 7: 缓存键维度（同一条件不重复发请求的前提）');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const W = path.resolve(import.meta.dirname, '..');
  const c = fs.readFileSync(path.join(W, 'client.js'), 'utf8');
  const grabFn = (decl, name) => {
    const s = c.indexOf(decl);
    if (s < 0) return null;
    let depth = 0, q = 0, end = -1;
    for (let i = s; i < c.length; i++) {
      const ch = c.charCodeAt(i);
      if (q) { if (ch === 92) i++; else if (ch === q) q = 0; continue; }
      if (ch === 39 || ch === 34 || ch === 96) { q = ch; continue; }
      if (ch === 123) depth++;
      else if (ch === 125) { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) return null;
    try { return new Function(c.slice(s, end + 1) + String.fromCharCode(10) + ' return ' + name + ';')(); } catch { return null; }
  };
  const sk = grabFn('const skillCacheKey = (o) => {', 'skillCacheKey');
  const mc = grabFn('const mcpCacheKey = (o) => {', 'mcpCacheKey');
  check('skillCacheKey 已抽为纯函数', sk !== null);
  check('mcpCacheKey 已抽为纯函数', mc !== null);
  if (sk && mc) {
    const base = { source: 'skills.sh', query: 'pdf', category: 'all', page: 1, size: 24, sort: 'installCount' };
    check('同条件两次得到同一键', sk(base) === sk(Object.assign({}, base)), sk(base));
    check('键非空', sk(base).length > 0);
    check('size 变化必须换键（改每页条数不得命中旧缓存）', sk(Object.assign({}, base, { size: 48 })) !== sk(base), sk(Object.assign({}, base, { size: 48 })));
    check('sort 变化必须换键', sk(Object.assign({}, base, { sort: 'stars' })) !== sk(base));
    check('page 变化必须换键', sk(Object.assign({}, base, { page: 2 })) !== sk(base));
    check('query 变化必须换键', sk(Object.assign({}, base, { query: 'docx' })) !== sk(base));
    check('source 变化必须换键', sk(Object.assign({}, base, { source: 'clawhub' })) !== sk(base));
    check('append（加载更多）不进缓存', sk(Object.assign({}, base, { append: true })) === '');
    check('MCP 键含 size', mc({ source: 'lobehub', query: 'a', category: 'all', sort: 'default', page: 1, size: 24 }) !== mc({ source: 'lobehub', query: 'a', category: 'all', sort: 'default', page: 1, size: 48 }));
    check('MCP append 不进缓存', mc({ source: 'lobehub', query: '', category: 'all', sort: 'default', page: 1, size: 24, append: true }) === '');
    // 'all'/'' 与 'default'/'' 必须归一：否则同一视图的两种写法会算成两个缓存项（重复请求）
    check('category all 与空串归一', mc({ source: 'lobehub', query: '', category: 'all', sort: 'default', page: 1, size: 24 }) === mc({ source: 'lobehub', query: '', category: '', sort: 'default', page: 1, size: 24 }));
    check('sort default 与空串归一', mc({ source: 'lobehub', query: '', category: 'all', sort: 'default', page: 1, size: 24 }) === mc({ source: 'lobehub', query: '', category: 'all', sort: '', page: 1, size: 24 }));
    check('技能键同样归一 category', sk({ source: 'a', query: '', category: 'all', page: 1, size: 24, sort: 'x' }) === sk({ source: 'a', query: '', category: '', page: 1, size: 24, sort: 'x' }));
  }
}


console.log('');
console.log('Test 8: 三个条件/边界缺陷（取证确认，非猜测）');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const W = path.resolve(import.meta.dirname, '..');
  const c = fs.readFileSync(path.join(W, 'client.js'), 'utf8');
  const strip = (text) => text.split(String.fromCharCode(10))
    .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*') && !l.trimStart().startsWith('/*'))
    .join(String.fromCharCode(10));

  // D2 排序切换丢查询词：effect 里显式传 ''（不是「没传」——没传还能靠 liveRef 回落，
  // 显式传 '' 就是清空）。用户搜了 pdf 再改排序 → 列表退回全量，而搜索框里 pdf 还在。
  const eff = strip(sliceBetween(c, 'const prevSortRef = useRef(sort);', 'const openSkillDetail', '排序 effect'));
  check('排序不再显式传空查询词', !/searchSkills\(''/.test(eff), eff.replace(/\s+/g, ' ').slice(0, 130));
  check('排序保留当前查询词', /searchSkills\(query,/.test(eff));
  // 下发形式两种都合法（shorthand 与 sort: sort），文件里其它调用点用的是 shorthand；
  // 断言锁「调用行的第二个参数里含 sort 键」，不锁具体写法（锁写法会误报）。
  const sortCall = strip(eff).split(String.fromCharCode(10)).find((l) => l.includes('searchSkills(query,'));
  check('排序把新排序键下发（shorthand 或冒号都算）',
    Boolean(sortCall) && /[,{]\s*sort\s*[,}:]/.test(sortCall), JSON.stringify((sortCall || '').trim().slice(0, 112)));

  // D3 技能分类 chip 是死控件：只 setCategory，没有任何 effect 依赖 category →
  // chip 高亮变了、列表没变。用户以为筛过了，其实没有。
  const chipLine = c.split(String.fromCharCode(10)).find((l) => l.includes('setCategory(cat)') && l.includes('scrollTo'));
  check('分类 chip 有唯一可定位行', Boolean(chipLine), JSON.stringify((chipLine || '').trim().slice(0, 80)));
  check('分类 chip 触发重新搜索（不再是死控件）',
    Boolean(chipLine) && /searchSkills\(query,/.test(chipLine) && /category: cat/.test(chipLine),
    JSON.stringify((chipLine || '').trim().slice(0, 130)));
  check('分类切换回到第 1 页（旧分类的第 N 页在新分类下无意义）', Boolean(chipLine) && /page: 1/.test(chipLine));

  // D5 跳页边界：Enter 拒绝越界、失焦却放行 → 同一个数字两种提交方式两种结果。
  const pj = c.indexOf('const pageJumpTarget = (raw, current, n, unknown) =>');
  check('pageJumpTarget 已抽为纯函数', pj > 0, pj);
  if (pj > 0) {
    let depth = 0, q = 0, end = -1;
    for (let i = pj; i < c.length; i++) {
      const ch = c.charCodeAt(i);
      if (q) { if (ch === 92) i++; else if (ch === q) q = 0; continue; }
      if (ch === 39 || ch === 34 || ch === 96) { q = ch; continue; }
      if (ch === 123) depth++;
      else if (ch === 125) { depth--; if (depth === 0) { end = i; break; } }
    }
    const fn = new Function(c.slice(pj, end + 1) + String.fromCharCode(10) + ' return pageJumpTarget;')();
    check('范围内正常返回', fn('7', 1, 25, false) === 7, fn('7', 1, 25, false));
    check('越界返回 0（不跳转）', fn('99', 1, 25, false) === 0, fn('99', 1, 25, false));
    check('0/负数返回 0', fn('0', 1, 25, false) === 0 && fn('-3', 1, 25, false) === 0);
    check('空/非数字返回 0', fn('', 1, 25, false) === 0 && fn('abc', 1, 25, false) === 0);
    check('未知总页数不做上界限制', fn('99', 1, 0, true) === 99, fn('99', 1, 0, true));
    check('小数向下取整', fn('4.9', 1, 25, false) === 4, fn('4.9', 1, 25, false));
    const pagerSeg = strip(sliceBetween(c, 'const pager = (page, totalPages', 'const loadInstalled = useCallback', 'pager 区'));
    check('Enter 与失焦共用同一判定', (pagerSeg.match(/pageJumpTarget\(/g) || []).length >= 2, (pagerSeg.match(/pageJumpTarget\(/g) || []).length);
    check('旧的裸 clamp 已消失', !/Math\.trunc\(Number\(jumpState\)/.test(pagerSeg), '');
  }
}

console.log('');

console.log('');
console.log('Test 9: 缓存与分页元数据口径（取证确认的缺陷；零正则，全部 includes）');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const W = path.resolve(import.meta.dirname, '..');
  const c = fs.readFileSync(path.join(W, 'client.js'), 'utf8');
  const NL = String.fromCharCode(10);
  const strip = (text) => text.split(NL).filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*')).join(NL);
  // 判定一律用 includes/indexOf：正则转义在跨层写文件时极易多写一层反斜杠，
  // 那会让断言永远匹配不到（本套件就踩过：pageWindow\( 被写成字面反斜杠+分组）。
  const skBody = strip(sliceBetween(c, 'const searchSkills = useCallback', 'const searchMcps = useCallback', 'searchSkills'));
  const mcBody = strip(sliceBetween(c, 'const searchMcps = useCallback', 'const openMcpDetail', 'searchMcps'));

  // 缺陷1：cacheKey 用闭包 size，请求却用 (options.size || size) —— 键与请求不同源。
  // 命名必须是 pageSize：写成 const size = resolvePageSize(options, size) 会在同一块作用域
  // 遮蔽外层 size 状态，右侧自引用直接 TDZ 崩溃（白屏）。性质不变：键与请求用同一个数。
  check('size 由单一 resolvePageSize 得出', skBody.includes('const pageSize = resolvePageSize(options'), '');
  check('请求参数直接用该值', skBody.includes('pageSize,'), '');
  check('旧的分裂写法已消失', !skBody.includes('(options && options.size) || size'), '');
  check('cacheKey 也传同一个值', skBody.slice(skBody.indexOf('skillCacheKey('), skBody.indexOf('skillCacheKey(') + 200).includes('size: pageSize'), '');

  // 缺陷2：缓存命中把页码硬置 1；翻页（append=false 且 page>1）也走缓存，
  // 于是数据是第 3 页、分页器显示「第 1 页」。
  check('缓存命中不再硬置第 1 页', !skBody.includes('setSkillsPage(1)'), '');
  check('缓存命中恢复本次请求页码', skBody.includes('setSkillsPage(pageNo)'), '');

  // 缺陷3：mcp 缓存只存 items+categories，命中时不恢复 page/totalPages/total ——
  // 切源再切回来，卡片立刻出现但分页器仍显示上一个源的页数。
  const storeAt = mcBody.indexOf('resultCacheRef.current[cacheKey] = {');
  check('mcp 缓存写入含 totalPages', storeAt > 0 && mcBody.slice(storeAt, storeAt + 260).includes('totalPages'), storeAt < 0 ? '未找到写入点' : mcBody.slice(storeAt, storeAt + 120));
  check('mcp 缓存写入含 total', storeAt > 0 && mcBody.slice(storeAt, storeAt + 260).includes('total'), '');
  check('mcp 缓存写入含 page', storeAt > 0 && mcBody.slice(storeAt, storeAt + 260).includes('page'), '');
  const hitAt = mcBody.indexOf('if (cached) {');
  check('mcp 缓存命中恢复元数据', hitAt > 0 && mcBody.slice(hitAt, hitAt + 460).includes('setMcpTotalPages(cached'), hitAt < 0 ? '未找到命中分支' : mcBody.slice(hitAt, hitAt + 160));
  check('mcp 缓存命中恢复页码', hitAt > 0 && mcBody.slice(hitAt, hitAt + 460).includes('setMcpPage(cached'), '');
}

console.log('');
console.log('Test 10: 分页器死代码清理（含锚唯一性锁）');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const W = path.resolve(import.meta.dirname, '..');
  const c = fs.readFileSync(path.join(W, 'client.js'), 'utf8');
  const NL = String.fromCharCode(10);
  // 锚唯一性：区间两端各命中 1 次，否则 sliceBetween 会 throw（不会静默切空）
  check('pager 起锚唯一', countHits(c, 'const pager = (page, totalPages') === 1, countHits(c, 'const pager = (page, totalPages'));
  check('pager 尾锚唯一', countHits(c, 'const loadInstalled = useCallback') === 1, countHits(c, 'const loadInstalled = useCallback'));
  const seg = c.slice(c.indexOf('const pager = (page, totalPages'), c.indexOf('const loadInstalled = useCallback'));
  check('区间非空且长度合理', seg.length > 1200 && seg.length < 6000, seg.length);
  const code = seg.split(NL).filter((l) => !l.trimStart().startsWith('//')).join(NL);
  const firstLine = code.split(NL)[0];
  // 本应成立的结构完整性（防被当噪声）：pageWindow 接线与前后翻页都在
  check('pager 接线完整（pageWindow + 前后翻页）',
    code.includes('const pageItems = pageWindow(page, n, 5)') && code.includes('gotoPage(page - 1)') && code.includes('gotoPage(page + 1)'), '');
  // 死代码：shown 只声明从不使用；windowed 参数在 pageWindow 抽出后已无人读取
  check('死变量 shown 已清除', !code.includes('const shown = '), (code.match(/const shown[^\r\n]*/) || [''])[0].slice(0, 70));
  check('死参数 windowed 已从签名移除', absent(firstLine, 'windowed'), firstLine.trim().slice(0, 100));
  check('调用点不再传 windowed 实参', !c.includes(', tab === ' + String.fromCharCode(39) + 'skills' + String.fromCharCode(39) + ' ? false : true)'), '');
}
console.log('');

console.log('');
console.log('Test 11: 分页摘要必须把数量接到真实数据（悬空标签缺陷）');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const W = path.resolve(import.meta.dirname, '..');
  const c = fs.readFileSync(path.join(W, 'client.js'), 'utf8');
  const NL = String.fromCharCode(10);
  // live 实测到的缺陷：分页器显示「共约 第 1 / 1 页」—— 标签后面没有数字。
  // 根因是 skillsTotal 只被 setSkillsTotal 写入、从未被读取渲染（useState 只写不读审计
  // 全仓唯一一处），而 pager 的 label 参数是硬编码的 '共约'。标签与数据源断链。
  const ps = c.indexOf('const pagerSummary = (o) => {');
  check('pagerSummary 已抽为纯函数', ps > 0, ps);
  if (ps > 0) {
    let depth = 0, q = 0, end = -1;
    for (let i = ps; i < c.length; i++) {
      const ch = c.charCodeAt(i);
      if (q) { if (ch === 92) i++; else if (ch === q) q = 0; continue; }
      if (ch === 39 || ch === 34 || ch === 96) { q = ch; continue; }
      if (ch === 123) depth++;
      else if (ch === 125) { depth--; if (depth === 0) { end = i; break; } }
    }
    const fn = new Function(c.slice(ps, end + 1) + NL + ' return pagerSummary;')();
    // 场景1：正常聚合结果 —— 数字必须来自 total，不是硬编码
    const s1 = fn({ label: '共约', total: 129, page: 2, n: 6, unknown: false, hasMore: true });
    check('摘要含真实数量', s1.includes('共约 129 个'), JSON.stringify(s1));
    check('摘要含页码与总页数', s1.includes('第 2 / 6 页'), JSON.stringify(s1));
    // 场景2：0 命中 —— 绝不出现「共约 第 1 / 1 页」这种悬空标签
    const s0 = fn({ label: '共约', total: 0, page: 1, n: 1, unknown: false, hasMore: false });
    check('0 命中不渲染悬空标签', !s0.includes('共约'), JSON.stringify(s0));
    check('0 命中仍说明页码', s0.includes('第 1 / 1 页'), JSON.stringify(s0));
    // 场景3：过滤后（total 已被 P4 重算为可见集合）—— 摘要跟着变，不沿用上游数
    const sf = fn({ label: '共约', total: 2, page: 1, n: 1, unknown: false, hasMore: false });
    check('过滤后摘要用重算的数', sf.includes('共约 2 个'), JSON.stringify(sf));
    // 场景4：cursor 型源（unknown）—— 不许编造总页数，但数量若已知仍要显示
    const su = fn({ label: '共约', total: 500, page: 3, n: 0, unknown: true, hasMore: true });
    check('unknown 不显示假总页数', !su.includes('/ 0 页'), JSON.stringify(su));
    check('unknown 显示可继续加载', su.includes('可继续加载'), JSON.stringify(su));
    check('unknown 仍带真实数量', su.includes('共约 500 个'), JSON.stringify(su));
    // 无 label（MCP 侧另有专行）时不得凭空造词
    const sn = fn({ label: '', total: 500, page: 1, n: 25, unknown: false, hasMore: true });
    check('空 label 不渲染数量子句', !sn.includes('共约') && !sn.includes('500'), JSON.stringify(sn));
  }
  // 接线：pager 必须收到 total，且技能侧传的是 skillsTotal（不是硬编码字符串）
  const pagerSig = c.split(NL).find(function (l) { return l.includes('const pager = (page, totalPages'); });
  check('pager 签名含 total 形参', Boolean(pagerSig) && pagerSig.includes('total'), JSON.stringify((pagerSig || '').trim().slice(0, 110)));
  check('pager 显示调用 pagerSummary', c.includes('pagerSummary({'), '');
  const callSite = c.slice(c.indexOf('pager('), c.indexOf('pager(') + 900);
  // 必须锁完整表达式：裸 includes('skillsTotal') 会被上一行实参里的 skillsTotalPages
  // 子串冒充而恒真（证伪②正是这样漏网：实参换成 0 之后断言仍然通过）。
  check('技能侧传 skillsTotal（非 Pages 子串冒充）',
    /\bskillsTotal\s*:/.test(callSite) && callSite.includes('skillsTotal : mcpTotal'),
    callSite.replace(/\s+/g, ' ').slice(0, 150));
  // MCP 侧 label 必须留空：数量已由上方专行（LobeHub · 共 N 个连接器）负责，
  // 两处都显示就是同一个数字出现两次。
  check('MCP 侧 label 留空（不与专行重复计数）', callSite.includes("tab === 'skills' ? '共约' : '',"), callSite.replace(/\s+/g, ' ').slice(0, 150));
  // 同类缺陷防回归：全仓不得再有「只写不读」的 useState
  // 计数前剥注释：整行注释与行尾注释都不算读取。②c 证明只剥整行会留下
  // 「? 0 : 0, // skillsTotal」这种盲区——变量名出现在行尾注释里仍被当成读取。
  const codeOnly = c.split(NL).map(function (l) {
    const t = l.trimStart();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return '';
    const cut = l.indexOf('//');
    return cut >= 0 ? l.slice(0, cut) : l;
  }).join(NL);
  const re = /const \[(\w+), (set\w+)\] = useState/g;
  const writeOnly = [];
  let mm;
  while ((mm = re.exec(c))) {
    const uses = (codeOnly.match(new RegExp('\\b' + mm[1] + '\\b', 'g')) || []).length;
    if (uses <= 1) writeOnly.push(mm[1]);
  }
  check('无只写不读的状态（悬空标签根因）', writeOnly.length === 0, writeOnly.join(','));
}

console.log('');
console.log('Test 12: 交付文件行尾必须统一（平台中立不变量）');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const W = path.resolve(import.meta.dirname, '..');
  // 这里曾经是「必须 CRLF」——那是错的：core.autocrlf 在 Windows 是 true、在 Linux CI
  // 是 false，同一份 blob checkout 出来一边全 CRLF、一边全 LF，断言在任何 Linux 上必红。
  // 平台中立的不变量是**不许混用**：一个文件里同时存在 CRLF 与孤立 LF，说明有脚本只改了
  // 部分行就用 LF join 回去（本轮 splice 脚本真就这么把 client.js 写坏过一次）。
  // 至于「整体从 CRLF 变成 LF」，CI 上无法与正常 checkout 区分，它由写入脚本自己的 EOL
  // 自检负责（每个脚本写完读回统计，不符即 throw）—— 职责不同，不要在这里假装能查。
  const deliverables = ['client.js', 'index.js', 'src/sources.js', 'src/mcp.js', 'src/tool-filter.js'];
  const mixed = [];
  for (const rel of deliverables) {
    let buf;
    try { buf = fs.readFileSync(path.join(W, rel)); } catch { continue; }
    let cr = 0, lf = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 13 && buf[i + 1] === 10) cr++;
      else if (buf[i] === 10 && (i === 0 || buf[i - 1] !== 13)) lf++;
    }
    if (cr > 0 && lf > 0) mixed.push(rel + ' CRLF=' + cr + ' loneLF=' + lf);
  }
  check('交付 js 无混合行尾', mixed.length === 0, mixed.join(' / '));
  // 自检本身要能识别混合（构造一个混合串验证计数器没写错）
  const probe = Buffer.from('a' + String.fromCharCode(13, 10) + 'b' + String.fromCharCode(10) + 'c');
  let pc = 0, pl = 0;
  for (let i = 0; i < probe.length; i++) {
    if (probe[i] === 13 && probe[i + 1] === 10) pc++;
    else if (probe[i] === 10 && (i === 0 || probe[i - 1] !== 13)) pl++;
  }
  check('计数器能识别混合行尾', pc === 1 && pl === 1, 'CRLF=' + pc + ' loneLF=' + pl);
}

console.log('');
console.log('Test 13: 不可达源的 total 不得随页码虚高（计数与真实集合一致）');
{
  // 实测：trusttools 每次都 degraded（超时、items=0），但 total 报 0→12→24 随页增长。
  // 根因是 src/sources.js 的反推兜底「total 缺失或小于本页条数时补 (p-1)*size+items」——
  // 它的前提是本页有货只是上游没报总数；items=0 时补出正数就是凭空造数。
  if (typeof searchSkills !== 'function') { check('（依赖注入）', false); } else {
    const handlers = { dead: async () => ({ items: [], total: 0 }) };
    const rows = [];
    for (const page of [1, 2, 3]) {
      const r = await searchSkills({ query: '', source: 'dead', page, pageSize: 12, handlers, budgetMs: 5000 });
      rows.push({ page, total: r.total, items: r.items.length, pages: r.pages });
    }
    console.log('   实测: ' + JSON.stringify(rows));
    check('空结果 total 恒为 0（不随页码增长）', rows.every((x) => x.total === 0), rows.map((x) => x.total).join(','));
    check('空结果 pages 不超过 1', rows.every((x) => !x.pages || x.pages <= 1), rows.map((x) => x.pages).join(','));
    // 有货时反推兜底必须仍然有效（上游不给 total 的源不能因此丢计数下界）
    const h2 = { live: async (o) => ({ items: Array.from({ length: 12 }, (x, i) => ({ slug: 's' + o.page + '-' + i })), total: 0 }) };
    const r2 = await searchSkills({ query: '', source: 'live', page: 2, pageSize: 12, handlers: h2, budgetMs: 5000 });
    check('有货时仍按本页条数反推下界', r2.total >= 24, r2.total);
    // 过滤后口径（P4）：total 必须等于过滤后的可见集合，不沿用上游虚数
    const h3 = { f: async () => ({ items: [
      { slug: 'a', category: 'dev' }, { slug: 'b', category: 'doc' }, { slug: 'c', category: 'dev' },
    ], total: 999 }) };
    const r3 = await searchSkills({ query: '', source: 'f', page: 1, pageSize: 24, category: 'dev', handlers: h3, budgetMs: 5000 });
    check('过滤后 total 等于可见集合', r3.total === r3.items.length, 'total=' + r3.total + ' items=' + r3.items.length);
    check('过滤掉的条数如实暴露', r3.filteredOut === 1, r3.filteredOut);
  }
}
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);





