// 0.5.164（监测方 m15355 ③）：browse→search 形态切换不复位 sort ⇒ 请求带着该形态不支持的键。
//
// 机制（全部读实 client.js）：
//   :884  const reqSort = options && options.sort !== undefined ? options.sort : sort;
//         不带 options.sort 的调用点（:1479 安装后刷新、:1661 卸载后刷新、:2250 回车、
//         :2261 搜索按钮、:2715 改每页条数、:2250/:2348 分类 chip）全部回落到**残留的 sort state**；
//   :2283-2287 的 keep 判定只挂在**切源** onClick 上，形态（有无查询词）翻转时没人复位；
//   :2327 下拉选项走 capsFor(caps, hasQuery) ⇒ UI 已经不给 trending 了，请求里却还带着它。
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
const runKeep = (sort, caps, hasQuery) => {
  const b = bodyOf('keepSortForForm');
  if (!b) return null;
  const f = new Function('NL', b + NL + '    return keepSortForForm;')(NL);
  return f(sort, caps, hasQuery);
};

console.log('Test 1: 形态翻转时残留键必须复位（真函数）');
{
  const caps = { browse: ['downloadCount', 'stars', 'newest', 'updated', 'trending', 'name'], search: ['downloadCount', 'stars', 'newest', 'updated', 'name'] };
  check('keepSortForForm 存在（纯函数，可独立跑）', bodyOf('keepSortForForm') !== null, 'client.js 内未找到该函数');
  if (bodyOf('keepSortForForm') !== null) {
    check('browse→search：trending 不在 search 能力表 ⇒ 回落 default', runKeep('trending', caps, true) === 'default', 'got=' + runKeep('trending', caps, true));
    check('search→browse：trending 在 browse 能力表 ⇒ 保留用户选择', runKeep('trending', caps, false) === 'trending', 'got=' + runKeep('trending', caps, false));
    check('default 永远保留（它映射 installCount，不依赖形态）', runKeep('default', caps, true) === 'default', 'got=' + runKeep('default', caps, true));
    check('installCount 当 search 分支支持时保留', runKeep('installCount', caps, true) === 'installCount', 'got=' + runKeep('installCount', caps, true));
    check('能力表未到达（null）时不猜键：非 default 一律回落', runKeep('trending', null, true) === 'default', 'got=' + runKeep('trending', null, true));
    check('name 两态都支持 ⇒ 保留（面板自己能算的键）', runKeep('name', caps, false) === 'name' && runKeep('name', caps, true) === 'name', '');
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
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
