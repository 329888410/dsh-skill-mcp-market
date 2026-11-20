#!/usr/bin/env node
// test-mcp-panel-p0.mjs — TDD: 已装 MCP 行必须有「编辑」与「测试连接」入口；probe 走新 op。
//
// 背景（本轮实测）：编辑抽屉已存在（detail drawer，含命令/URL/参数）但只能从**搜索 tab 市场抽屉**打开，
// 已装连接器（管理 tab 的卡片）没有任何入口；「测试连接」只嵌在安装流程里，装完想再验一次没有按钮。
// 参照 Fishquito7/dsh-skill-mcp-panel：probe 语义是「独立实例测试，pending 不是失败」（0.5.103 起我们同语义）。
import fs from 'node:fs';
import path from 'node:path';

const W = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(W, f), 'utf8');
const c = read('client.js');
const ix = read('index.js');

let passed = 0, failed = 0;
const check = (n, cond, d = '') => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 130) + ']' : '')); } };

console.log('');
console.log('Test 1: 已装 MCP 卡片带「编辑」与「测试连接」按钮');
{
  const s = c.indexOf('const installedMcps');
  const seg = c.slice(s, s + 3200);
  check('installedMcps 存在', s > 0);
  check('编辑按钮', /编辑/.test(seg));
  check('测试连接按钮', /测试连接/.test(seg));
  check('编辑打开 openMcpDetail（同一抽屉复用，不另造表单）', /openMcpDetail\(/.test(seg));
  check('测试走新 probe op 而非安装通道', /mcp\.probe/.test(seg));
}

console.log('');
console.log('Test 2: 服务端新增 mcp.probe op（封装已有内部方法）');
{
  check('index.js 有 case "mcp.probe"', ix.includes('case "mcp.probe"'));
  check('调用 mcp.probe 内部方法', /case "mcp\.probe"[\s\S]{0,300}\.probe\(/.test(ix));
}

console.log('');
console.log('Test 3: 白名单三处同步（mcp.probe 加入，防止漂移锁误伤）');
// test-rpc-surface 是动态提取 client op 比对服务端 case，没有硬编码白名单，故只查两处 known Set
for (const f of ['test-manage-panel.mjs', 'test-install-progress.mjs']) {
  const t = read('test/' + f);
  check(f + ' 含 mcp.probe', /mcp\.probe/.test(t));
}

console.log('');
console.log('Test 4: probe 按钮防重复 + 结果文案区分 pending/失败');
{
  const s = c.indexOf('const installedMcps');
  const seg = c.slice(s, s + 4200);
  check('按钮 disabled 绑定 busy:probe', /busy === \`probe:/.test(seg));
  check('pending 文案（服务器还在启动）', /还在启动|启动中/.test(seg));
  check('失败文案', /未连上|失败/.test(seg));
}

console.log('');
console.log('Test 5: 编辑入口行为正确（打开抽屉不重新安装）');
{
  const seg = c.slice(c.indexOf('const installedMcps'), c.indexOf('const installedMcps') + 3200);
  check('编辑 onClick 调 openMcpDetail(item.serverName)', /openMcpDetail\(item\.serverName\)/.test(seg));
  check('编辑不调用 mcp.install', !/mcp\.install/.test(seg));
}

console.log('');
console.log('Test 6: 语法');
{
  const { execSync } = await import('node:child_process');
  for (const f of ['client.js', 'index.js']) {
    let ok = true;
    try { execSync('node --check ' + JSON.stringify(path.join(W, f)), { stdio: 'pipe' }); } catch { ok = false; }
    check(f + ' 语法通过', ok);
  }
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
