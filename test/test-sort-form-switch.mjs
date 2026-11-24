// 0.5.164（监测方 m15355 ③）：browse→search 形态切换不复位 sort ⇒ 请求带着该形态不支持的键。
//
// 机制（全部读实 client.js）：
//   改前  const reqSort = options && options.sort !== undefined ? options.sort : sort;
//         不带 options.sort 的调用点（:1479 安装后刷新、:1661 卸载后刷新、:2250 回车、
//         :2261 搜索按钮、:2715 改每页条数、:2250/:2348 分类 chip）全部回落到**残留的 sort state**；
//   切源 onClick 的 keep 判定只覆盖「换源」，形态（有无查询词）翻转时没人复位；
//   下拉选项走 capsFor(caps, hasQuery) ⇒ UI 已经不给 trending 了，请求里却还带着它。
// live 指纹（真 RPC，宿主进程内 0.5.162）：
//   clawhub browse  sort=trending head=sonoscli,gog,github,weather,openai-whisper
//   clawhub browse  sort=默认    head=go-perplexity,clawrent,smyx-infant-sleep-monitoring-analysis,...
//   ⇒ browse 态 trending 真排；
//   clawhub search  q=pdf sort=trending 与 sort=默认 head 逐位相同（pdf,pdf,pdf,...）
//   ⇒ 服务端在 search 分支根本不认 trending（能力表 search 里也没有 trending）。
// 后果：用户在 clawhub 浏览时选了「热门」，再输入关键词，请求仍带 trending，UI 下拉里
// 却已经没有这个选项了 —— 排序静默失效且不可见，正是 0.5.101 起反复判死的「选了没反应」。
import fs from 'node:fs';
import path from 'node:path';
const NL = String.fromCharCode(10);

const W = path.resolve(import.meta.dirname, '..');
const c = fs.readFileSync(path.join(W, 'client.js'), 'utf8');
const lines = c.split(/\r?\n/);

let passed = 0, failed = 0;
const check = (n, cond, d = '') => { if (cond) { passed++; console.log('  PASS ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 140) + ']' : '')); } };

// 真跑被抽出来的纯函数（照 test-clawhub-category-vocab.mjs Test 8 的 new Function 姿势）
const bodyOf = (name) => {
  const i = lines.findIndex((l) => new RegExp('function ' + name + '\\(').test(l));
  if (i < 0) return null;
  const out = [];
  for (let k = i; k < lines.length; k += 1) {
    out.push(lines[k]);
    if (k > i && lines[k].trim() === '}' && (lines[k].length === 1 || lines[k].startsWith('    '))) break;
  }
  return out.join(NL);
};
const runKeep = (sort, entry, hasQuery) => {
  const b = bodyOf('keepSortForForm');
  if (!b) return null;
  const cb = bodyOf("capsFor");
  if (cb === null) return null;
  // keepSortForForm 内部复用 capsFor（Test 3 要的单一口径），所以把真 capsFor 一起注入执行；
  // entry 传能力对象（browse/search 两套），与生产调用点同形状，判据吃的东西与线上一致。
  const f = new Function('NL', cb + NL + b + NL + '    return keepSortForForm;')(NL);
  return f(sort, entry, hasQuery);
};

console.log('Test 1: 形态翻转时残留键必须复位（真函数）');
{
  // 夹具 = 生产真表形：src/sort-capability.js 的 CAPABILITIES + index.js:1223-1233 下发的
  // {browse, search} 两套。clawhub 键名是 downloadCount（实测 installs 字段跨页不单调、稀疏，
  // 0.5.137 判死过「名称与字段不符」），所以 installCount 用 skills.sh 的真表形单独验。
  const clawhub = { browse: ['downloadCount', 'stars', 'newest', 'updated', 'trending', 'name'], search: ['downloadCount', 'stars', 'newest', 'updated', 'name'] };
  // skills.sh：browse 走 sitemap（无 installs 字段）⇒ installCount 只属于 search 分支。
  const skillsSh = { browse: ['name'], search: ['installCount', 'name'] };
  check('keepSortForForm 存在（纯函数，可独立跑）', bodyOf('keepSortForForm') !== null, 'client.js 内未找到该函数');
  if (bodyOf('keepSortForForm') !== null) {
    check('browse→search：trending 不在 search 能力表 ⇒ 回落 default', runKeep('trending', clawhub, true) === 'default', 'got=' + runKeep('trending', clawhub, true));
    check('search→browse：trending 在 browse 能力表 ⇒ 保留用户选择', runKeep('trending', clawhub, false) === 'trending', 'got=' + runKeep('trending', clawhub, false));
    check('default 永远保留（它映射 installCount，不依赖形态）', runKeep('default', clawhub, true) === 'default', 'got=' + runKeep('default', clawhub, true));
    check('installCount 在当前形态能力表内 ⇒ 保留（skills.sh 搜索态）', runKeep('installCount', skillsSh, true) === 'installCount', 'got=' + runKeep('installCount', skillsSh, true));
    check('反向：installCount 在 skills.sh 浏览态不支持 ⇒ 回落（sitemap 无 installs）', runKeep('installCount', skillsSh, false) === 'default', 'got=' + runKeep('installCount', skillsSh, false));
    check('两态都在表里的键（clawhub downloadCount）任何形态都保留', runKeep('downloadCount', clawhub, true) === 'downloadCount' && runKeep('downloadCount', clawhub, false) === 'downloadCount', '');
    check('能力表未到达（null）时不猜键：非 default 一律回落', runKeep('trending', null, true) === 'default', 'got=' + runKeep('trending', null, true));
    check('name 两态都支持 ⇒ 保留（面板自己能算的键）', runKeep('name', clawhub, false) === 'name' && runKeep('name', clawhub, true) === 'name', '');
  }
}

console.log('');
console.log('Test 2: 请求下发处必须经过复位（源码锁）');
{
  const req = lines.find((l) => /const reqSort =/.test(l)) || '';
  check('reqSort 不再直接吃残留 sort state', /keepSortForForm/.test(req), req.trim());
  check('reqSort 仍尊重显式 options.sort（切源时传入新键）', /options\.sort !== undefined/.test(req), req.trim());
  const eff = lines.find((l) => /const effSort =/.test(l)) || '';
  check('effSort 的 default→installCount 映射不变（既有契约）', /reqSort === 'default' \? 'installCount' : reqSort/.test(eff), eff.trim());
}

console.log('');
console.log('Test 3: 下拉选项与实发请求同源（不许 UI 一套、请求另一套）');
{
  const opts = lines.find((l) => /sortOptions\(capsFor\(sortCaps && sortCaps\.skills/.test(l)) || '';
  check('下拉仍走 capsFor(caps, hasQuery)', /capsFor\(sortCaps && sortCaps\.skills/.test(opts), opts.trim());
  check('复位用的也是同一个 capsFor（单一口径）', /keepSortForForm[\s\S]{0,400}capsFor/.test(bodyOf('keepSortForForm') || ''), '未复用 capsFor');
}

console.log('');
console.log('Test 4: 真 searchSkills 体端到端（UI 与实发请求必须同一形态口径）');
{
  // 不是源码正则：把 client.js 里线上那份 searchSkills 真跑起来，看它到底往 RPC 发什么 sort。
  // 0.5.165 的教训（CAT_OTHER 漏绑 ReferenceError 被 catch 吞掉）：自由量清单缺一个，
  // 这条判据就会假装通过，所以这里任何缺失都会让 run 抛出并被断言抓到。
  const startNeedle = 'const searchSkills = useCallback(async (text, options) => {';
  const endNeedle = '}, [sort, liveRef, source, size]);';
  const si = lines.findIndex((l) => l.includes(startNeedle));
  const ei = lines.findIndex((l, k) => k > si && l.trim() === endNeedle);
  check('searchSkills 函数体可定位', si > 0 && ei > si, si + '/' + ei);
  if (si > 0 && ei > si) {
    const body = lines.slice(si + 1, ei).join(NL);
    const mk = new Function('deps', 'extra', 'return async (text, options) => {' + NL +
      '  const { liveRef, resultCacheRef, reqSeqRef, size, sort, call, setSkills, setSkillsPage,' +
      '    setSkillsTotalPages, setSkillsTotal, setSkillsHasMore, setServerFacet, setNotice, setError, setBusy,' +
      '    skillCacheKey, resolvePageSize, inflightRef, shouldSkipInflight, trustedTotal, totalBaseRef, CAT_OTHER } = deps;' +
      '  const { keepSortForForm } = extra;' + NL + body + NL + '};');
    const capsForBody = bodyOf('capsFor');
    const keepBody = bodyOf('keepSortForForm');
    const keep = new Function(capsForBody + NL + keepBody + NL + 'return keepSortForForm;')();
    const mkEnv = (sortState, src) => {
      const payload = { items: [{ id: 'x', slug: 'x' }], pages: 1, total: 1, hasMore: false, hints: [], degraded: [], sourceErrors: [] };
      const sent = {};
      const keys = [];
      const env = {
        liveRef: { current: { source: src, category: 'all', sortCaps: { skills: { clawhub: {
          browse: ['downloadCount', 'stars', 'newest', 'updated', 'trending', 'name'],
          search: ['downloadCount', 'stars', 'newest', 'updated', 'name'],
        } } } } },
        resultCacheRef: { current: {} },
        reqSeqRef: { current: 0 },
        totalBaseRef: { current: {} },
        size: 24,
        sort: sortState,
        skillCacheKey: (o) => { keys.push(o.sort); return 'k'; },
        inflightRef: { current: new Set() },
        shouldSkipInflight: () => false,
        resolvePageSize: (o, s) => (o && o.size) || s,
        trustedTotal: (v) => v,
        CAT_OTHER: '__cat_other',
        setSkills: () => {}, setSkillsPage: () => {}, setSkillsTotalPages: () => {}, setSkillsTotal: () => {},
        setSkillsHasMore: () => {}, setServerFacet: () => {}, setNotice: () => {}, setError: () => {}, setBusy: () => {},
        call: async (op, p) => { sent.op = op; Object.assign(sent, p); return payload; },
      };
      return { run: mk(env, { keepSortForForm: keep }), sent, keys };
    };
    // 用户在 clawhub 浏览态选了「热门」（trending），随后输入关键词：能力表 search 分支没有 trending。
    const a = mkEnv('trending', 'clawhub');
    await a.run('pdf', {});
    check('搜索态残留 trending 不再下发（实发 default→installCount）', a.sent.sort === 'installCount', 'sort=' + a.sent.sort);
    check('缓存键也用 effective 后的 sort（不与实发脱节）', a.keys.length > 0 && a.keys[0] === 'installCount', JSON.stringify(a.keys));
    // 同一个残留 trending，在浏览态（空查询）里是合法能力 ⇒ 必须原样保留，不许一律复位。
    const b = mkEnv('trending', 'clawhub');
    await b.run('', {});
    check('浏览态 trending 仍原样下发（不过度复位）', b.sent.sort === 'trending', 'sort=' + b.sent.sort);
    // 切源 onClick 传的是那一刻算好的键：显式 options.sort 必须透传，不被兜底改写。
    const d = mkEnv('trending', 'clawhub');
    await d.run('pdf', { sort: 'stars' });
    check('显式 options.sort 原样透传（切源传入的新键）', d.sent.sort === 'stars', 'sort=' + d.sent.sort);
    // 能力表未到达（settings.get 前）：非 default 一律回落，不许凭猜下发。
    const e = mkEnv('stars', 'trusttools');
    await e.run('pdf', {});
    check('该源能力表未到达 ⇒ 回落 installCount（不猜键）', e.sent.sort === 'installCount', 'sort=' + e.sent.sort);
  }
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
