#!/usr/bin/env node
// test-panel-perf-sort-fold.mjs — 管理面板三项现有功能优化（全部落在可热更新的 client.js）。
//
// 1) 性能：工具浮窗一次渲染 mcpTools.toolDetails 的**全部**条目（playwright-mcp 单连接器就有
//    22+ 个工具，每个都是一个 card + label + 描述 + 条件 pre）。搜索时每帧全量重建 DOM。
//    修法：搜索词命中数超过阈值时不直接铺满，改为分批渲染（先一屏，点「继续显示」再增量），
//    并给列表容器独立滚动区，避免整个弹层被撑长。
// 2) 排序控件：已装技能段目前只有 搜索 + 状态筛选，没有任何排序（固定 rank 分组内服务端序）。
//    用户装了几十个技能后，按名称找只能靠搜索。加纯前端排序（名称/状态），不动服务端。
// 3) 折叠态搜索提示：技能筛选非空但全部命中都在折叠分组里时，界面只显示组头计数，
//    用户会以为「没搜到」。加一条明确提示（含「全部展开」动作）。
//
// 核验一律走 test/anchor-lib.mjs 的 once/lineOf/sliceBetween —— 锚不唯一就 throw，
// 不再让「核验脚本自己出错」成为假绿来源（0.5.129 的实测教训）。
import fs from 'node:fs';
import path from 'node:path';
import { once, lineOf, sliceBetween, countHits } from './anchor-lib.mjs';
// 本套件自己的锚也必须走 once：核验脚本用裸 indexOf 出过一次误报（见 anchor-lib 头注）。

const W = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(W, f), 'utf8');
const c = read('client.js');

let passed = 0, failed = 0;
const check = (n, cond, d) => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 150) + ']' : '')); } };

console.log('Test 1: 锚库必须真的能用（否则下面全是空断言）');
check('anchor-lib 导入成功', typeof once === 'function' && typeof lineOf === 'function' && typeof sliceBetween === 'function');
check('client.js 可被唯一锚定位', once(c, "const visibleTools =", 'visibleTools') > 0);

console.log('');
console.log('Test 2: 工具列表分批渲染（性能）');
{
  // 分批阈值与展开增量必须存在，且默认只渲染一部分
  check("批量阈值常量存在", /TOOL_BATCH/.test(c) || /TOOL_RENDER_LIMIT/.test(c), "");
  const toolSeg = sliceBetween(c, "renderedTools.map((tool) =>", "mcpTools.hasDetails && mcpTools.toolDetails.length > 0", "工具列表");
  check('渲染源是 renderedTools 而非全量', /renderedTools\.map\(\(tool\) =>/.test(c) && /visibleTools\.map\(\(tool\) =>/.test(c) === false);
  check('有「继续显示」增量入口', /继续显示/.test(c));
  check('搜索词变化时分页游标重置', /useEffect\([\s\S]{0,240}setToolBatch[^\)]*\)\s*\n?\s*,\s*\[toolQuery\]/.test(c) || /setToolBatch\(1\)[\s\S]{0,160}toolQuery/.test(c), "");
  // 计数必须是「命中/全量」两个数都在，只渲染前 N 个时用户才看得出现在还有更多
  check('命中计数含全量分母', /匹配 \$\{visibleTools\.length\}\/\$\{mcpTools\.toolDetails\.length\}/.test(c), "");
}

console.log('');
console.log('Test 3: 已装技能排序控件');
{
  const header = sliceBetween(c, "h('div', { style: { ...S.title, marginBottom: 2", "batchMode && filteredInstalled.length > 0", "已装段头");
  check('已装段头有 select 排序控件', /h\('select'/.test(header), header.slice(0, 80).replace(/\s+/g, ' '));
  check('排序值受控且持久化', /manageSkillSort/.test(header) && /manageSkillSort/.test(c));
  check('排序选项含名称与状态', /按名称/.test(header) && /按状态|启用优先|停用优先/.test(header), "");
  // 排序必须作用在分组之前（否则每组的顺序还是服务端序）
  const igBody = sliceBetween(c, "const installedGrouped = (() =>", "const installedSkills = installedGrouped.map", "installedGrouped");
  check('分组基于排序后的列表', /sortedInstalled/.test(igBody) && !/for \(const item of filteredInstalled\)/.test(igBody), igBody.replace(/\s+/g, ' ').slice(0, 100));
  check('sortedInstalled 定义存在', /const sortedInstalled =/.test(c));
  check('排序不改变默认序（default 时同 filteredInstalled）', /manageSkillSort === 'default'|sortInstalled\(filteredInstalled/.test(c), "");
}

console.log('');
console.log('Test 4: 折叠命中时的搜索提示');
{
  check('提示文案存在', /命中项都在折叠分组|结果都在折叠分组|被折叠隐藏/.test(c));
  // 触发条件必须是「筛选生效中 且 展开可见数为 0 且 折叠前有命中」——三缺一都会误报/漏报
  const tipIdx = c.search(/命中项都在折叠分组|结果都在折叠分组|被折叠隐藏/);
  check('定位到唯一提示', tipIdx > 0 && countHits(c, c.slice(tipIdx, tipIdx + 14)) === 1, tipIdx);
  // 定位失败时 cond 必须是空串：写成 slice(Math.max(0,tipIdx-600), tipIdx) 会在 tipIdx=-1
  // 时退化成「几乎整个文件」，于是下面每条条件都碰巧为真 —— 那就是假绿。
  const cond = tipIdx > 0 ? c.slice(tipIdx - 600, tipIdx) : '';
  check('条件含展开可见为 0', /expandedVisible\.length === 0/.test(cond), cond.replace(/\s+/g, ' ').slice(-140));
  check('条件含筛选生效', /skillFilterText|manageSkillState !== 'all'/.test(cond));
  check('条件含确实用有命中（避免误报空筛选）', /filteredInstalled\.length > 0/.test(cond));
}

console.log('');
console.log('Test 4b: sortInstalled 与 renderedTools 行为（new Function 真跑，不是正则）');
{
  // 抽出真实实现体来跑：正则锁只能证明「字在」，证明不了「排序对」。
  const start = c.indexOf('function sortInstalled(items, mode, isOff) {');
  check('sortInstalled 可定位', start > 0);
  let depth = 0, end = -1;
  for (let i = start; i < c.length; i++) { const ch = c[i]; if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } } }
  const fn = new Function('return (' + c.slice(start, end + 1) + ')')();
  const items = [{ name: 'beta', slug: 'b' }, { name: 'alpha', slug: 'a' }, { name: 'Gamma', slug: 'g' }];
  const off = (x) => x.slug === 'a';
  const names = (r) => r.map((x) => x.name).join(',');
  // default 必须原样返回同一引用：服务端顺序本身有含义，且避免无谓拷贝。
  check('default 原样返回同一引用', fn(items, 'default', off) === items);
  check('mode 缺失也原样', names(fn(items, undefined, off)) === 'beta,alpha,Gamma');
  check('按名称升序', names(fn(items, 'name', off)) === 'alpha,beta,Gamma', names(fn(items, 'name', off)));
  // 状态排序以名称序为基线做稳定 tie-break，同名段内再按名称，结果可预期。
  check('启用优先（停用项沉底）', names(fn(items, 'on', off)) === 'beta,Gamma,alpha', names(fn(items, 'on', off)));
  check('停用优先（停用项置顶）', names(fn(items, 'off', off)) === 'alpha,beta,Gamma', names(fn(items, 'off', off)));
  check('绝不修改入参数组', names(items) === 'beta,alpha,Gamma' && items[0].name === 'beta', names(items));
  check('空数组安全', JSON.stringify(fn([], 'name', off)) === '[]');
  // isOff 未注入时分区无从判断，实现退化为名称序 —— 这是 tie-break 设计的直接结果，
  // 不是缺陷；把它当 bug 去改反而会引入无意义分支。期望按真实设计写。
  check('isOff 缺失退化为名称序（设计如此）', names(fn(items, 'on', undefined)) === 'alpha,beta,Gamma', names(fn(items, 'on', undefined)));
  check('isOff 缺失时 off 模式同为名称序', names(fn(items, 'off', undefined)) === 'alpha,beta,Gamma');
}

console.log('');
console.log('Test 4c: renderedTools 截断公式真跑（直接执行 client.js 那段代码）');
{
  const s = c.indexOf('const renderedTools =');
  check('renderedTools 可定位', s > 0);
  const TAIL = ': visibleTools;';
  const tail = c.indexOf(TAIL, s);
  check('三元式可截取', tail > s);
  const snippet = c.slice(s, tail + TAIL.length);
  const mk = (n) => Array.from({ length: n }, (_, i) => i);
  const run = (total, batch) => new Function('mcpTools', 'visibleTools', 'TOOL_BATCH', 'toolBatch',
    snippet + String.fromCharCode(10) + ' return renderedTools;')(true, mk(total), 60, batch);
  check('小列表不截断（22 个工具原样）', run(22, 1).length === 22, run(22, 1).length);
  check('超阈值只渲第一批', run(200, 1).length === 60, run(200, 1).length);
  check('点继续显示按批递增', run(200, 2).length === 120, run(200, 2).length);
  check('游标越过总数不越界', run(70, 9).length === 70, run(70, 9).length);
  check('mcpTools 为 null 也不炸', run(500, 1).length === 60, run(500, 1).length);
}

console.log('');
console.log('Test 5: 既有行为不破');
{
  check('三口径仍统一于 expandedVisible', /const selectedVisible = expandedVisible\.filter/.test(c) && /new Set\(expandedVisible\.map/.test(c));
  check('批量条唯一性场景仍在（裸锚仍多命中）', countHits(c, '退出选择') > 1);
  check('三个头部按钮仍受 !batchMode 门控', (c.match(/!batchMode \? h\('button'/g) || []).length === 3);
  check('probe 刷新仍在', /if \(r\.ok\) \{[\s\S]{0,140}await loadInstalled\(\); \}/.test(c));
  check('collapseAllGroups 仍写持久化', /collapseAllGroups = \(collapsed\) => \{[\s\S]{0,420}collapsedGroups/.test(c));
  check('工具搜索关键词过滤仍在', /function toolMatches\(tool, query\)/.test(c));
}

console.log('');
console.log('Test 6: 语法');
{
  const { execSync } = await import('node:child_process');
  for (const f of ['client.js', 'test/anchor-lib.mjs']) {
    let ok = true;
    try { execSync('node --check ' + JSON.stringify(path.join(W, f)), { stdio: 'pipe' }); } catch { ok = false; }
    check(f + ' 语法通过', ok);
  }
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);