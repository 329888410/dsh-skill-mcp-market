#!/usr/bin/env node
// test-mcp-command-guard.mjs — TDD: 面板 HTTP 通道绝不允许通过 mcp.update 改写 command/args。
//
// 缺陷（本轮改前核实发现，非推测）：mcp.install 明确拒绝 body.command 并写明理由
//   「面板 HTTP 通道不接受自定义 command：那是任意命令执行面」（index.js:1545-1550），
// 但同一条边界的另一半 mcp.update 是 `return mcp.update(body.serverName, body.patch || {})`
// 零校验；而 client.js 的 saveMcpEdit 正在把 draft.command / draft.args 发进去。
// 结果：同一个「任意命令执行」能力，安装被挡、编辑放行 —— 守卫形同虚设。
//
// 合法通道不受影响：agent 工具 mcp_market_install 直调内部函数（index.js:963 handler），
// 不经 HTTP case，因此它带 command 的能力必须保留（Test 3 锁）。
import fs from 'node:fs';
import path from 'node:path';

const W = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(W, f), 'utf8');
const ix = read('index.js');
const c = read('client.js');

let passed = 0, failed = 0;
const check = (n, cond, d = '') => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 130) + ']' : '')); } };

console.log('');
console.log('Test 1: HTTP 面 mcp.update 必须拒绝 command/args 改写');
{
  const caseStart = ix.indexOf('case "mcp.update"');
  const caseBody = ix.slice(caseStart, caseStart + 900);
  check('mcp.update case 存在', caseStart > 0);
  check('拒绝 patch.command', /patch[\s\S]{0,260}command[\s\S]{0,120}throw/.test(caseBody) || /if \(patch\.command\)/.test(caseBody), caseBody.split("\n").slice(0, 6).join(" ⏎ ").slice(0, 200));
  check('拒绝 patch.args', /args[\s\S]{0,160}throw/.test(caseBody) || /patch\.args/.test(caseBody));
  check('拒绝理由与 mcp.install 同一条边界（文案含 命令/mcp_market_install）', /mcp_market_install|任意命令/.test(caseBody));
}

console.log('');
console.log('Test 2: 面板端不得再把 command/args 发进 mcp.update');
{
  const s = c.indexOf('const saveMcpEdit');
  const body2 = c.slice(s, s + 900);
  check('saveMcpEdit 存在', s > 0);
  check('patch 不再包含 command', !/command:\s*draft\.command/.test(body2), body2.split("\n").filter(l=>/command/.test(l)).join(" ⏎ ").slice(0,160));
  check('patch 不再包含 args', !/args:\s*String\(draft\.args/.test(body2));
  check('仍可保存 url（url 不是命令执行面）', /url:\s*draft\.url/.test(body2));
}

console.log('');
console.log('Test 3: 合法通道不受影响（agent 工具仍可带 command）');
{
  const t = ix.indexOf('"mcp_market_install"');
  const seg = ix.slice(t, t + 1400);
  check('agent 工具 schema 仍声明 command', /command:\s*\{\s*type:\s*"string"\s*\}/.test(seg));
  check('agent 工具 handler 不经 HTTP case（直调内部函数）', /await mcp\.install\(|handler: async \(args\) =>\s*\n?\s*(await )?mcp\.install/.test(ix));
  check('mcp.install 自身的 command 拒绝仍在（回归保护）', /面板通道不接受自定义 command/.test(ix));
}

console.log('');
console.log('Test 4: 编辑表单里 command/args 必须是只读形态');
{
  const s = c.indexOf("'命令'");
  const seg = c.slice(s - 200, s + 1400);
  check('命令输入框带 readOnly', /readOnly: true/.test(seg), seg.split("\n").filter(l=>/command|readOnly/.test(l)).join(" ⏎ ").slice(0, 180));
  check('参数输入框只读（textarea 用 readOnly 或改 pre）', /readOnly: true/.test(seg) || /h\('pre'/.test(seg));
  check('只读旁有引导文案（告诉用户走工具安装）', /mcp_market_install|工具安装|不可修改/.test(seg));
}

console.log('');
console.log('Test 5: 语法');
{
  const { execSync } = await import('node:child_process');
  for (const f of ['index.js', 'client.js']) {
    let ok = true;
    try { execSync('node --check ' + JSON.stringify(path.join(W, f)), { stdio: 'pipe' }); } catch { ok = false; }
    check(f + ' 语法通过', ok);
  }
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
