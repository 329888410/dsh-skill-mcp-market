#!/usr/bin/env node
// test-mcp-status-p1.mjs — TDD: 已装 MCP 的连接状态必须是生命周期，而不是布尔。
//
// 现状：mcp.list 只给 mounted（布尔）+ tools 数。用户看到的是「已连接/未连接」，
// 但真实形态至少有 5 种：未挂载、启动中、已就绪、失败、已停用。把「启动中」显示成
// 「未连接」会让用户以为坏了（0.5.103 的假阴性就是同一类误读）；把「失败」显示成
// 「未连接」则丢掉了原因。
//
// 实现约束（重要）：宿主 loader 在 app.asar 内不可静态审计，因此状态探测必须
// 多路宽松匹配 + 诚实回退：匹配不到就回落到 mounted 布尔，绝不猜一个假 phase。
import fs from 'node:fs';
import path from 'node:path';

const W = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(W, f), 'utf8');
const mcp = read('src/mcp.js');
const ix = read('index.js');
const c = read('client.js');

let passed = 0, failed = 0;
const check = (n, cond, d = '') => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 130) + ']' : '')); } };

console.log('');
console.log('Test 1: 重连参数从硬编码变为可配置（默认值与参照实现一致）');
{
  // 实现是 spread 合并（{ ...DEFAULT_RECONNECT, ...def.reconnect }），不含 enabled: 字面量，
  // 因此断言 spread 形态 + def.reconnect 读取，而非旧的内联对象。
  check('reconnect 读 def.reconnect', /reconnect:\s*\{\s*\.\.\.DEFAULT_RECONNECT[^\n]*def\.reconnect/.test(mcp));
  check('默认 initialDelayMs 500', /initialDelayMs[^\d]*500/.test(mcp));
  check('默认 maxDelayMs 30000', /maxDelayMs[^\d]*30000/.test(mcp));
  check('默认 maxAttempts 10', /maxAttempts[^\d]*10/.test(mcp));
  // 覆盖方向：DEFAULT 在前、def.reconnect 在后 → 用户键胜出（运行时实测已证 maxAttempts:3 覆盖 10）
  check('用户值覆盖默认值（spread 顺序正确）', mcp.indexOf('...DEFAULT_RECONNECT, ...(def.reconnect') >= 0);
}

console.log('');
console.log('Test 2: 新增 status 探测（多路匹配 + 诚实回退）');
{
  check('src/mcp.js 导出 status', /return \{[^}]*status[^}]*\}/.test(mcp) || /status,/.test(mcp.split('return { init, dispose').pop() || ''));
  check('内部有 status 函数', /async function status\(|function status\(/.test(mcp));
  check('读 fiber.status（自己的对象，不依赖宿主内部）', /entry\.fiber\?\.status|fiber\.status/.test(mcp));
  check('探测 loader 作为补充路', /ctx\.loader[\s\S]{0,240}entries/.test(mcp));
  check('匹配不到时回退布尔语义', /mounted\s*\?\s*['"]active|fallback|回退|回落/.test(mcp));
  check('index.js 有 case "mcp.status"', ix.includes('case "mcp.status"'));
}

console.log('');
console.log('Test 3: 面板显示生命周期而非布尔');
{
  const s = c.indexOf('const installedMcps');
  const seg = c.slice(s, s + 3600);
  check('不再只有 已连接/未连接 两态', /启动中|loading|pending/.test(seg));
  check('状态文案来自 phase 映射表', /PHASE_LABEL|phaseLabel|phaseOf/.test(seg));
  check('失败态显示原因', /error|原因/.test(seg));
}

console.log('');
console.log('Test 4: op 登记一致（status 进两处白名单）');
for (const f of ['test-manage-panel.mjs', 'test-install-progress.mjs']) {
  check(f + ' 含 mcp.status', /mcp\.status/.test(read('test/' + f)));
}

console.log('');
console.log('Test 5: status 是只读 op（不得进 DESTRUCTIVE_OPS）');
{
  const rg = read('src/rpc-guard.js');
  check('mcp.status 不在 DESTRUCTIVE_OPS', !/DESTRUCTIVE_OPS[\s\S]{0,400}"mcp\.status"/.test(rg));
}

console.log('');
console.log('Test 6: 语法');
{
  const { execSync } = await import('node:child_process');
  for (const f of ['client.js', 'index.js', 'src/mcp.js']) {
    let ok = true;
    try { execSync('node --check ' + JSON.stringify(path.join(W, f)), { stdio: 'pipe' }); } catch { ok = false; }
    check(f + ' 语法通过', ok);
  }
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
