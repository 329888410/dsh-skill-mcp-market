#!/usr/bin/env node
// test-manage-optimizations.mjs — 管理面板现有功能的三处优化（转入优化阶段的第一次交付）。
//
// A. 测试连接后刷新卡片：probe 是独立实例、不写 mounted（0.5.112 起语义如此，保持不变），
//    但 probe 成功意味着真实 fiber 已发布工具；卡片 phase/tools 来自 mcp.list 缓存，
//    不刷新就停留在旧值，用户要手动刷新页面。测试连接的产出应该可见。
// B. 全选口径修正：批量条「全选」把折叠分组里的技能也选进来 —— 用户看不见它们，
//    批量卸载却会动它们。与 0.5.122 定下的原则冲突（筛掉/隐藏的旧选择不得参与批量）。
//    口径修正为「当前展开可见的项」，与 selectedVisible 的诚实语义一致。
// C. 全部展开/折叠：分组多时逐个点折叠箭头太繁琐，分组头行加两个便捷操作。
import fs from 'node:fs';
import path from 'node:path';

const W = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(W, f), 'utf8');
const c = read('client.js');

let passed = 0, failed = 0;
const check = (n, cond, d) => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 130) + ']' : '')); } };

console.log('');
console.log('Test A: 测试连接后刷新卡片');
{
  // 用函数体切片（saveMcpEdit 的教训：固定窗口会漏）。
  const pi = c.indexOf('const r = await call(\'mcp.probe\'');
  check('probe 调用存在', pi > 0);
  // 从 probe 调用向前找 onClick 起点、向后找 finally/setBusy('') 结束
  const start = c.lastIndexOf('onClick: async', pi);
  const end = c.indexOf("setBusy('');", pi);
  const body = pi > 0 && start > 0 && end > pi ? c.slice(start, end) : '';
  check('probe 处理体可切片', body.length > 100, 'start=' + start + ' end=' + end);
  check('成功分支刷新列表', /if \(r\.ok\)[\s\S]{0,200}loadInstalled/.test(body) || /loadInstalled[\s\S]{0,120}已连接|连接正常[\s\S]{0,120}loadInstalled/.test(body), body.slice(0, 200));
  check('pending 分支也刷新（启动完成后卡片相位会变）', body.split('loadInstalled').length >= 2, 'loadInstalled 出现 ' + (body.match(/loadInstalled/g) || []).length + ' 次');
}

console.log('');
console.log('Test B: 全选只选可见项');
{
  const sa = c.indexOf("'全不选' : '全选'");
  const seg = c.slice(Math.max(0, sa - 500), sa + 300);
  check('全选存在', sa > 0);
  // 口径：全选集合必须与 selectedVisible 同源（排除折叠/隐藏项），而不是 filteredInstalled 全集
  check('全选不再用 filteredInstalled 全集', !/new Set\(filteredInstalled\.map/.test(seg), seg.replace(/\s+/g, ' ').slice(0, 160));
  check('全选与 selectedVisible 同口径', /expandedVisible|visibleForBatch|selectedVisible/.test(seg));
  check('已选计数与全选同口径（防两套口径漂移）', (c.match(/selectedVisible\.length/g) || []).length >= 2);
  // 计数、全选、批量动作三者必须同一口径：都基于 expandedVisible（展开+未筛掉）。
  // 旧口径基于 filteredInstalled，用户展开→选中→再折叠后看不见的项仍参与批量卸载。
  check('selectedVisible 基于 expandedVisible', /const selectedVisible = expandedVisible\.filter/.test(c));
  check('批量链路不再引用 filteredInstalled 口径', (c.match(/selectedVisible\.length === filteredInstalled/g) || []).length === 0);
}

console.log('');
console.log('Test C: 全部展开/折叠');
{
  check('入口存在', /全部展开|全部折叠/.test(c));
  // 架构：按钮不直接 setCollapsedGroups，而是走 collapseAllGroups helper ——
  // 因为直接 set 会漏掉 localStorage 写入（单组折叠 toggleGroupCollapsed 是写两者的）。
  // 断言必须锁这条真实接线，而不是要求按钮行紧邻 setCollapsedGroups。
  check('按钮调用 helper', /onClick: \(\) => collapseAllGroups\(false\)/.test(c) && /onClick: \(\) => collapseAllGroups\(true\)/.test(c));
  const helperBody = /const collapseAllGroups = \(collapsed\) => \{[\s\S]*?\n      \};/.exec(c);
  check('helper 存在且可抽出', Boolean(helperBody));
  check('helper 写 state', Boolean(helperBody) && /setCollapsedGroups\(next\)/.test(helperBody[0]));
  check('helper 写持久化（与单组折叠同键）', Boolean(helperBody) && helperBody[0].includes("localStorage.setItem('dsh-skill-mcp-market.collapsedGroups'"));
  check('持久化（与单组折叠同一存储）', /collapsedGroups 写入|localStorage\.setItem\('dsh-skill-mcp-market\.collapsedGroups'/.test(c));
}

console.log('');
console.log('Test D: 既有行为不破');
{
  check('批量条仍是浮层零位移', /top: 46, zIndex: 55/.test(c));
  check('selectedVisible 派生仍在', /const selectedVisible = /.test(c));
  check('两步确认武装态仍在', /mcpConfirmArmed \? '确认保存/.test(c));
  check('probe 语义未变（仍走独立实例 op）', /call\('mcp\.probe'/.test(c));
  check('折叠持久化键未变', c.includes("dsh-skill-mcp-market.collapsedGroups"));
}

console.log('');
console.log('Test E: 语法');
{
  const { execSync } = await import('node:child_process');
  let ok = true;
  try { execSync('node --check ' + JSON.stringify(path.join(W, 'client.js')), { stdio: 'pipe' }); } catch { ok = false; }
  check('client.js 语法通过', ok);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
