#!/usr/bin/env node
// test-manage-panel.mjs — TDD: 「已安装」更名「管理」并拆 SKILL/MCP 双子页签。
//
// 设计事实（参照 Fishquito7/dsh-skill-mcp-panel src/client.ts:5680-5909）：
//   子页签状态持久化 localStorage 键 dsh-market:manage-tab，读失败静默退化为技能页；
//   容器带 data-manage-tab、页签行 role=tablist、按钮 aria-selected（兼作本测试锚点）；
//   过滤词按子页签拆开（旧 installedFilter 一个词同时过滤技能与 MCP，互相污染）；
//   回收站与上传区只属于技能侧（Q2 已拍板：SKILL 子页签底部）。
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const W = path.resolve(import.meta.dirname, '..');
const c = fs.readFileSync(path.join(W, 'client.js'), 'utf8');

let passed = 0, failed = 0;
const check = (n, cond, d = '') => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + d.slice(0, 80) + ']' : '')); } };

console.log('');
console.log('Test 1: 主 tab 更名「管理」且选中态修复');
{
  check("tab 按钮文案为 '管理'", /setTab\('manage'\)\s*\},\s*'管理'/.test(c));
  check("旧 '已安装' tab 按钮消失", !/setTab\('installed'\)/.test(c));
  check('选中态接线 S.tab(tab === \'manage\')', c.includes("S.tab(tab === 'manage')"));
  check('内部值统一为 manage（无 installed tab 残留）', !/tab === 'installed'/.test(c));
}

console.log('');
console.log('Test 2: 双子页签状态机 + 持久化（参照模式）');
{
  check('manageTab state 存在', /const \[manageTab, setManageTab\] = useState\(/.test(c));
  check('localStorage 键 dsh-market:manage-tab', c.includes("dsh-market:manage-tab"));
  check('localStorage 读写包 try/catch', /try \{[^\n]*localStorage\.getItem\(MANAGE_TAB_KEY\)[\s\S]{0,120}\} catch/.test(c) && /try \{[^\n]*localStorage\.setItem\(MANAGE_TAB_KEY/.test(c));
  check('容器 data-manage-tab 锚点', c.includes("'data-manage-tab'"));
  check('页签行 role=tablist', c.includes("role: 'tablist'"));
  check('页签按钮 aria-selected', c.includes('aria-selected'));
}

console.log('');
console.log('Test 3: 过滤词拆分（旧缺陷：一个词过滤两侧）');
{
  check('installedFilter 全部移除', !/installedFilter/.test(c), (c.match(/installedFilter/g) || []).length + ' refs left');
  check('manageSkillFilter 使用 ≥2 处', (c.match(/manageSkillFilter/g) || []).length >= 2);
  check('manageMcpFilter 使用 ≥2 处', (c.match(/manageMcpFilter/g) || []).length >= 2);
}

console.log('');
console.log('Test 4: 结构归属——回收站/上传区在技能子页签，MCP 子页签纯净');
{
  const skillBranch = c.indexOf("manageTab === 'skill' ? h('div'");
  const mcpBranch = c.indexOf("manageTab === 'mcp' ? h('div'");
  check('两个子页签分支都存在', skillBranch >= 0 && mcpBranch >= 0);
  if (skillBranch >= 0 && mcpBranch >= 0) {
    const seg = (a, b) => c.slice(a, b < 0 ? c.length : b);
    // 技能段 = manageTab==='skill' 条件起点到下一个兄弟条件；MCP 段同理到块尾
    const skillSeg = c.slice(skillBranch);
    const cut = skillSeg.indexOf("manageTab === 'mcp' ? h('div'");
    const skillOnly = skillSeg.slice(0, cut > 0 ? cut : 4000);
    const mcpOnly = skillSeg.slice(cut > 0 ? cut : 4000);
    check('回收站在技能段内', skillOnly.includes('回收站（'), 'skillOnly 未见回收站');
    check('上传区在技能段内', skillOnly.includes('浏览文件夹'));
    // 0.5.104：MCP 子页签现在有自己的「MCP 回收站」。旧断言的意图是「技能回收站不泄漏到 MCP 段」，
    // 因此按具体标记判定：技能回收站用 trashList，MCP 回收站用 mcpTrashList。
    check('MCP 段不含技能回收站', !mcpOnly.slice(0, 4000).includes('回收站（${trashList'));
    check('MCP 段含自己的 MCP 回收站', mcpOnly.includes('MCP 回收站（'));
    check('技能段不含 MCP 回收站', !skillOnly.includes('MCP 回收站（'));
    check('MCP 段不含上传区', !mcpOnly.slice(0, 3000).includes('浏览文件夹'));
    check('已装 MCP 卡片在 MCP 段', mcpOnly.includes('installedMcps') || mcpOnly.includes('filteredMounted'));
  }
}

console.log('');
console.log('Test 5: 无谓市场查询回归锁（进 manage/settings 不再 searchMcps）');
{
  const eff = c.indexOf('}, [tab, loadSettings, loadInstalled');
  check('tab effect 存在', eff >= 0);
  if (eff >= 0) {
    const block = c.slice(Math.max(0, eff - 900), eff);
    check('searchMcps 仅在 tab===mcp 分支', !/else\s+searchMcps/.test(block));
    check('存在 tab === \'mcp\' 守卫的 searchMcps', /tab === 'mcp'[\s\S]{0,120}searchMcps/.test(block));
  }
}

console.log('');
console.log('Test 6: 语法与零新增 op');
{
  let ok = true;
  try { execSync('node --check client.js', { cwd: W, timeout: 20000, stdio: 'pipe' }); } catch { ok = false; }
  check('client.js 语法通过', ok);
  const ops = [...c.matchAll(/call\('([\w.]+)'/g)].map((m) => m[1]);
  // 0.5.104 起新增 MCP 回收站三 op（Test 5 的「零新增 op」承诺随之更新为「只增已登记的 op」）
  const known = new Set(['skills.list','mcp.list','settings.get','skills.search','mcp.search','skills.detail','mcp.detail','skills.update','mcp.update','skills.install','mcp.install','skills.toggle','mcp.toggle','skills.uninstall','settings.set','skills.trash','skills.restore','skills.trashEmpty','mcp.trash','mcp.restore','mcp.trashEmpty','sessions.scan','sessions.repair','market.openDir','mcp.uninstall','skills.upload','skills.importZip']);
  const unknown = [...new Set(ops)].filter((o) => !known.has(o));
  check('未引入未登记 op', unknown.length === 0, unknown.join(','));
}

console.log('');
console.log('Test 7: 首次进入技能子页签自动拉取回收站（旧行为要手点「读取回收站」）');
{
  check('effect 条件含 manageTab skill + trashList null', /manageTab === 'skill'[\s\S]{0,80}trashList === null/.test(c));
  check('effect 调 loadTrash', /trashList === null[\s\S]{0,140}loadTrash\(\)/.test(c));
  // TDZ 回归锁：依赖数组在渲染时求值，effect 必须排在 const loadTrash 定义之后
  check('effect 位于 loadTrash 定义之后（TDZ 回归锁）', c.indexOf('const loadTrash = async') < c.indexOf("if (tab === 'manage' && manageTab === 'skill' && trashList === null"));
}

console.log('');
console.log('Test 8: 回收站操作的结果提示不得被列表刷新覆盖（实测 notice 被吞）');
{
  // 症状：handler 先 setNotice(已恢复…) 再 await loadTrash()/loadMcpTrash()，
  // 而这两个 loader 内部也 setNotice(回收站共 N 项) → 用户最终只看到刷新提示。
  // 锁法：handler 体内最后一次 setNotice 必须排在 loader await 之后。
  const cases = [
    ['restoreTrashEntry', 'await loadTrash();'],
    ['restoreMcpTrashEntry', 'await loadMcpTrash();'],
    ['emptyMcpTrash', 'await loadMcpTrash();'],
  ];
  for (const item of cases) {
    const name = item[0], loader = item[1];
    const start = c.indexOf('const ' + name + ' = async');
    if (start < 0) { check(name + ' 存在', false, '未找到'); continue; }
    const cut = c.indexOf('\n      };', start);
    const body = c.slice(start, cut > start ? cut : start + 1200);
    const loaderAt = body.indexOf(loader);
    const noticeAt = body.lastIndexOf('setNotice(');
    check(name + ' 结果提示排在刷新之后', loaderAt < 0 || noticeAt > loaderAt, 'loader@' + loaderAt + ' lastNotice@' + noticeAt);
  }
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);