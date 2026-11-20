#!/usr/bin/env node
// test-mcp-command-guard.mjs — MCP 编辑/安装的 command 闸门契约（0.5.126 反转）。
//
// 历史：0.5.116 在这里锁的是「面板 HTTP 通道永久拒绝 command/args」，理由是「那是任意
// 命令执行面」。**该理由已被实测推翻**：把 command=calc.exe 的定义直接写进定义目录，
// reconcile() 立即挂载执行 —— 任何本地进程或手动编辑磁盘都能绕过全部 UI 确认。
// 机器信任才是边界，HTTP 守卫挡不住攻击者，只挡住误操作。
//
// 因此契约从「永久拒绝」改为「显式二次确认」，与全插件 6 处既有 confirm 闸门一致
// （删除技能、清空回收站、卸载连接器都走同一形态）。用户要完全可编辑，
// 而「可编辑」的正确配套是「改到执行面时问一句」，不是「永远不给改」。
//
// agent 工具 mcp_market_install 不经 HTTP case，能力始终保留（Test 3 锁）。
import fs from 'node:fs';
import path from 'node:path';

const W = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(W, f), 'utf8');
const ix = read('index.js');
const c = read('client.js');
const mj = read('src/mcp.js');

let passed = 0, failed = 0;
const check = (n, cond, d = '') => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 130) + ']' : '')); } };

console.log('');
console.log('Test 1: mcp.update 的字段级 confirm 闸门（取代永久拒绝）');
{
  const caseStart = ix.indexOf('case "mcp.update"');
  const caseBody = ix.slice(caseStart, caseStart + 1400);
  check('mcp.update case 存在', caseStart > 0);
  check('旧的永久拒绝已移除', !/面板通道不接受自定义 command\/args/.test(caseBody));
  check('command/args 触发确认判定', /needsConfirmFor/.test(caseBody));
  check('未确认时拒绝（confirm 闸门）', /confirm !== true/.test(caseBody) || /body\.confirm !== true/.test(caseBody));
  check('拒绝文案是「需二次确认」语义', /需二次确认|需要二次确认/.test(caseBody));
}

console.log('');
console.log('Test 2: needsConfirmFor 的行为（new Function 真跑，不是正则）');
{
  const m = /function needsConfirmFor\(([^)]*)\) \{[\s\S]*?\n\}/.exec(ix);
  check('helper 存在', Boolean(m));
  if (m) {
    const fn = new Function('return (' + m[0] + ')')();
    check('只改 url → 无需确认', JSON.stringify(fn({ url: 'http://x' })) === '[]', JSON.stringify(fn({ url: 'http://x' })));
    check('只改 title/description → 无需确认', JSON.stringify(fn({ title: 'a', description: 'b' })) === '[]');
    check('改 command → 需确认', fn({ command: 'node' }).includes('command'));
    check('改 args → 需确认', fn({ args: ['x'] }).includes('args'));
    check('command:null（清除）也算改动', fn({ command: null }).includes('command'));
    check('空 patch → 无需确认', JSON.stringify(fn({})) === '[]');
    check('非对象 patch → 空（不炸）', JSON.stringify(fn(null)) === '[]' && JSON.stringify(fn(undefined)) === '[]');
  }
}

console.log('');
console.log('Test 3: mcp.install 手动模式同样走确认');
{
  const caseStart = ix.indexOf('case "mcp.install"');
  const caseBody = ix.slice(caseStart, caseStart + 1200);
  check('旧的 command 永久拒绝已移除', !/面板通道不接受自定义 command；/.test(caseBody));
  check('自定义 command 需 confirm', /needsConfirm\b|body\.confirm !== true/.test(caseBody));
  check('manualMcpDefinition 复用（能力已存在）', ix.includes('function manualMcpDefinition'));
}

console.log('');
console.log('Test 4: agent 工具通道不受影响（能力保留）');
{
  check('mcp_market_install 仍注册', ix.includes('mcp_market_install'));
  check('agent handler 直调内部函数（不经 HTTP case）', /await mcp\.install\(/.test(ix));
}

console.log('');
console.log('Test 5: 掩码字面量绝不写回定义（数据损坏防线）');
{
  // 防漂移：detail 生成端与校验端必须是同一个串。
  const ml = /export const MASK_LITERAL = "([^"]*)"/.exec(mj);
  check('MASK_LITERAL 常量存在', Boolean(ml), ml && ml[1]);
  check('detail 用 MASK_LITERAL（非硬编码串）', /\? MASK_LITERAL : String\(value\)/.test(mj));
  const defArg = /function assertNoMaskLiteral\(patch, maskLiteral = "([^"]*)"\)/.exec(mj);
  check('校验默认值与 MASK_LITERAL 一致', Boolean(ml && defArg && ml[1] === defArg[1]), (ml && ml[1]) + ' vs ' + (defArg && defArg[1]));
  // detail() 把 env/headers 的值掩成「***（来自环境变量）」；表单若把掩码原样回传，
  // 真实密钥就被字面量覆盖 —— 这是会静默发生的数据损坏，必须在服务端拦下。
  // 校验必须是纯函数且在写盘之前：既能在无 shippedRoot 的环境测（CI），
  // 也保证拒绝路径不产生任何副作用。
  const m = /function assertNoMaskLiteral\(([^)]*)\) \{[\s\S]*?\n  \}/.exec(mj);
  check('assertNoMaskLiteral 存在', Boolean(m));
  if (m) {
    const fn = new Function('return (' + m[0] + ')')();
    let e1 = '';
    try { fn({ env: { TOKEN: '***（来自环境变量）' } }); } catch (e) { e1 = String(e.message); }
    check('env 掩码值被拒', /掩码/.test(e1), e1.slice(0, 80));
    let e2 = '';
    try { fn({ headers: { Authorization: '***（来自环境变量）' } }); } catch (e) { e2 = String(e.message); }
    check('headers 掩码值被拒', /掩码/.test(e2), e2.slice(0, 80));
    let ok1 = true;
    try { fn({ env: { TOKEN: 'new-real-secret' } }); } catch (e) { ok1 = false; }
    check('真实新值放行', ok1);
    let ok2 = true;
    try { fn({ env: { REF: '${MY_VAR}' } }); } catch (e) { ok2 = false; }
    check('${VAR} 占位放行（那是合法写法）', ok2);
    let ok3 = true;
    try { fn({ title: 'x', url: 'y' }); } catch (e) { ok3 = false; }
    check('无 env/headers 的 patch 放行', ok3);
    let ok4 = true;
    try { fn(null); fn(undefined); fn({}); } catch (e) { ok4 = false; }
    check('空/非对象不炸', ok4);
  }
  // 接线锁：update 与 rawSet 都必须在 save/写盘之前调用它
  const updStart = mj.indexOf('async function update(');
  const updBody = mj.slice(updStart, mj.indexOf('async function', updStart + 10));
  check('update 调用掩码校验', updBody.includes('assertNoMaskLiteral('));
  check('校验早于写盘（save）', updBody.indexOf('assertNoMaskLiteral(') < updBody.indexOf('await save('), updBody.indexOf('assertNoMaskLiteral(') + '<' + updBody.indexOf('await save('));
  const rsStart = mj.indexOf('async function rawSet(');
  const rsBody = mj.slice(rsStart, mj.indexOf('async function', rsStart + 10));
  check('rawSet 调用掩码校验', rsBody.includes('assertNoMaskLiteral('));
  check('rawSet 校验早于写文件', rsBody.indexOf('assertNoMaskLiteral(') < rsBody.indexOf('await writeFile('));
}

console.log('Test 6: 面板表单——command/args 可编辑 + 改命令两步确认');
{
  check('命令输入框可编辑（无 readOnly）', !/value: draft\.command,[^}]*readOnly: true/.test(c));
  check('命令 onChange 接线', /value: draft\.command \|\| '',[\s\S]{0,320}onChange/.test(c));
  check('参数 textarea 可编辑', !/value: draft\.args \|\| '',\s*\n\s*readOnly: true/.test(c));
  check('参数 onChange 接线', /value: draft\.args \|\| '',[\s\S]{0,220}onChange/.test(c));
  check('旧的「面板不开放改写」文案已撤', !/面板不开放改写/.test(c));
  check('改命令时两步确认', /confirmMcpCommand|需要二次确认/.test(c));
  check('保存把 confirm 传给服务端', /'mcp\.update'[\s\S]{0,400}confirm/.test(c));
}

console.log('');
console.log('Test 7: 语法');
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
