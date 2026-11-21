#!/usr/bin/env node
// test-popover-stale-sort-honesty.mjs — 两项现有功能的诚实性优化（纯 client.js，可热更新）。
//
// ① 陈旧搜索词跨连接器泄漏：openMcpTools 只重置了 mcpToolOpen，没有重置 toolQuery /
//    toolBatch。于是在连接器 A 里搜过 click 后关掉、再打开连接器 B，B 的清单会被这个
//    跟 B 无关的词过滤掉，而标题写着「匹配 x/y」——用户读到的是「B 只有这些工具」，
//    实际是上一条搜索的残留。这是假陈述，不是小不便。
// ② 排序控件无可见变化时不吭声：排序是「先排再分组」，所以每组只剩一项时（本机实测
//    2 个技能正好分属 用户目录 / 插件提供 两组）切到「按名称」界面上毫无变化，用户
//    只能猜是不是坏了。上一轮我自己把这个缺口说成「设计的正确表现」就交付了 ——
//    正确但不诚实：设计对用户不可见时，得由界面说出来。
import fs from 'node:fs';
import path from 'node:path';
import { once, sliceBetween, countHits } from './anchor-lib.mjs';

const W = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(W, f), 'utf8');
const c = read('client.js');

let passed = 0, failed = 0;
const check = (n, cond, d) => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 150) + ']' : '')); } };

console.log('Test 1: 打开工具浮窗必须清掉上一条搜索的陈旧状态');
{
  // 尾锚是 saveSkillEdit：saveToolDeny 在 openMcpTools 之前（900 vs 914），
  // 拿它当尾锚会被 sliceBetween 的顺序校验拒绝 —— 那正是这条守卫该做的事。
  const body = sliceBetween(c, 'const openMcpTools = async (serverName) => {', 'const saveSkillEdit = async () => {', 'openMcpTools');

  check('函数体可截取', body.length > 200, body.length);
  check('重置 toolQuery', /setToolQuery\(''\)/.test(body), body.match(/setToolQuery[^;]*/) ? body.match(/setToolQuery[^;]*/)[0] : '无');
  check('重置 toolBatch', /setToolBatch\(1\)/.test(body), body.match(/setToolBatch[^;]*/) ? body.match(/setToolBatch[^;]*/)[0] : '无');
  check('两个重置都在 setMcpTools 之前（先清状态再放数据，避免一帧用旧词过滤新数据）',
    body.indexOf('setToolQuery') > 0 && body.indexOf('setToolQuery') < body.indexOf('setMcpTools({'),
    'q@' + body.indexOf('setToolQuery') + ' mcpTools@' + body.indexOf('setMcpTools({'));
}

console.log('');
console.log('Test 2: 排序无可见变化时必须说出来');
{
  check('提示文案存在', /排序没有改变|无可见变化|每组仅|顺序未变/.test(c));
  // 判据定义（1742 行附近）与提示渲染（2494 行附近）相距 750 行，不能靠「提示前 N
  // 字符」这种窗口假设把它们当相邻代码 —— 窗口里根本没有判据，断言就会空转。
  // 分开锁：① 判据定义本身的可验证性；② 渲染确实读这个判据。
  const defSeg = sliceBetween(c, 'const sortOrderUnchanged =', 'const installedGrouped', '判据定义');
  check('判据比较排序前后逐项序列（可验证事实，非猜分组大小）', /sortedInstalled\.every\(\(x, i\) => x === filteredInstalled\[i\]\)/.test(defSeg), defSeg.replace(/\s+/g, ' ').slice(0, 120));
  check('判据仅在非 default 时可能为真', /manageSkillSort !== 'default'/.test(defSeg));
  check('判据要求非空列表（空列表谈不上顺序变化）', /filteredInstalled\.length > 0/.test(defSeg));
  const ti = c.search(/排序没有改变可见顺序/);
  check('提示唯一可定位', ti > 0, ti);
  const renderSeg = ti > 0 ? c.slice(c.lastIndexOf('\n', ti) + 1, c.indexOf('\n', ti)) : '';
  check('渲染确实读判据', /sortOrderUnchanged \? h\('span'/.test(renderSeg), renderSeg.trim().slice(0, 90));
}

console.log('');
console.log('Test 3: 既有行为不破');
{
  check('toolQuery 变化仍重置游标', /useEffect\(\(\) => \{ setToolBatch\(1\); \}, \[toolQuery\]\)/.test(c));
  check('TOOL_BATCH 与分批渲染仍在', /const TOOL_BATCH = /.test(c) && /const renderedTools = mcpTools && visibleTools\.length > TOOL_BATCH \* toolBatch/.test(c));
  check('继续显示入口仍在', /继续显示/.test(c));
  check('折叠命中提示仍在', /命中项都在折叠分组里/.test(c));
  check('三口径仍统一于 expandedVisible', /const selectedVisible = expandedVisible\.filter/.test(c));
  check('mcpToolOpen 仍被重置', /setMcpToolOpen\(''\)/.test(c));
  check('deniedTools 缺失仍按旧服务端处理', /Array\.isArray\(data\.deniedTools\)/.test(c));
}

console.log('');
console.log('Test 4: 锚唯一性（本套件自己的锚也要守规矩）');
{
  check('openMcpTools 锚唯一', countHits(c, 'const openMcpTools = async (serverName) => {') === 1);
  check('saveSkillEdit 尾锚唯一', countHits(c, 'const saveSkillEdit = async () => {') === 1);
  check('once 能定位排序 state', once(c, 'const [manageSkillSort, setManageSkillSort] = useState(() => {', 'sortState') > 0);
}

console.log('');
console.log('Test 5: 语法');
{
  const { execSync } = await import('node:child_process');
  let ok = true;
  try { execSync('node --check ' + JSON.stringify(path.join(W, 'client.js')), { stdio: 'pipe' }); } catch { ok = false; }
  check('client.js 语法通过', ok);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
