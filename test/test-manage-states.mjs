#!/usr/bin/env node
// test-manage-states.mjs — 管理面板的加载态 / 空态 / 工具浮窗检索 / 坏定义可见性。
//
// 实测差距（2026-11-20，对照 Fishquito7/dsh-skill-mcp-panel 2.3.16）：
//  1) installed/mounted 初值都是 []，与「RPC 返回空数组」不可区分 → 首帧渲染成
//     「SKILL 技能 (0)」，把用户已有的东西说成没有（假陈述）。
//  2) MCP 子面板没有任何空态：筛空时纯空白，与技能段的处理不一致。
//  3) 工具浮窗只有全量清单：几十个工具的连接器（REA 255 个）没有搜索框与无匹配提示。
//  4) 定义文件 JSON 解析失败时被 readDefs 静默跳过（实测：尾逗号、非 JSON 都不出现），
//     用户手改坏一个文件后会以为连接器被删了。原计划的「未命名服务器」兜底经核实
//     不可达（serverName 有空文件名回落，永不为空），属死代码，已撤回。
import fs from 'node:fs';
import path from 'node:path';

const W = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(W, f), 'utf8');
const c = read('client.js');
const mj = read('src/mcp.js');

let passed = 0, failed = 0;
const check = (n, cond, d) => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 120) + ']' : '')); } };

console.log('');
console.log('Test 1: 未加载 ≠ 空（首帧不得谎报 0 个）');
check('installed 初值为 null', /const \[installed, setInstalled\] = useState\(null\)/.test(c));
check('mounted 初值为 null', /const \[mounted, setMounted\] = useState\(null\)/.test(c));
check('未加载时计数位显示读取中', /读取中/.test(c));

console.log('');
console.log('Test 2: 两个子面板都有筛选空态与无数据空态');
const si = c.indexOf("manageTab === 'skill' ? h('div'");
const sseg = c.slice(si, si + 16000);
check('技能段无数据空态', /还没有已安装技能/.test(sseg));
check('技能段筛选空态', /没有符合筛选条件/.test(sseg));
const mi = c.indexOf("manageTab === 'mcp' ? h('div'");
const mseg = c.slice(mi, mi + 9000);
check('MCP 段无数据空态', /还没有已安装 MCP|还没有 MCP 连接器/.test(mseg));
check('MCP 段筛选空态', /没有匹配的连接|没有符合筛选/.test(mseg));

console.log('');
console.log('Test 3: 工具浮窗可检索');
check('浮窗有工具搜索框', /placeholder: '搜索工具名或描述'/.test(c));
check('搜索时标题给匹配计数', /匹配/.test(c));
check('无匹配时明确提示', /没有匹配的工具/.test(c));

console.log('');
console.log('Test 4: 无法解析的定义文件必须可见');
check('readDefs 收集解析失败项', /brokenDefs\.push\(/.test(mj));
check('broken 访问器存在且导出（list 契约不变）', /function broken\(\) \{/.test(mj) && /\bbroken\b/.test(mj.slice(mj.indexOf('return { init, dispose'))));
check('RPC 组装 broken 清单', /broken: mcp\.broken\(\)/.test(read('index.js')));
check('面板显示坏定义并给文件名', /无法解析|无法读取/.test(c) && /mcpBroken/.test(c));

console.log('');
console.log('Test 5: 既有行为不破');
check('list() 仍返回数组（test-mcp-trash 契约）', /return \[\.\.\.defs\.values\(\)\]\.map/.test(mj));
check('技能段仍在 MCP 段之前', si > 0 && si < mi);
check('浮窗渲染仍在（visibleTools 单一数据源）', /visibleTools\.map\(/.test(c) && /const visibleTools = mcpTools \? mcpTools\.toolDetails\.filter/.test(c));
check('回收站折叠锁仍在', c.includes('回收站（'));
check('上传门控锁仍在', /uploadOpen \? h\('div'/.test(c));

console.log('');
console.log('Test 6: 语法');
const { execSync } = await import('node:child_process');
for (const f of ['client.js', 'src/mcp.js']) {
  let ok = true;
  try { execSync('node --check ' + JSON.stringify(path.join(W, f)), { stdio: 'pipe' }); } catch { ok = false; }
  check(f + ' 语法通过', ok);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
