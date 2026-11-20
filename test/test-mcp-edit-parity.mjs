#!/usr/bin/env node
// test-mcp-edit-parity.mjs — MCP 添加/编辑字段闭环 + confirm 值语义 + 死代码清理。
//
// 三件由审计确认的真实缺陷：
//  1) confirm 回归（0.5.126 引入）：openMcpDetail 把 draft.command 恒设为字符串（永不为
//     undefined），saveMcpEdit 又用「存在性」写入 patch.command；服务端 needsConfirmFor 用
//     `"command" in patch` 判定 —— 于是**只改 URL 的保存也被要求 confirm 而必然失败**。
//     修法两侧都做：客户端只在值真的变化时写入；服务端按「与当前定义比对」判定，
//     这样即使客户端多发了键，值没变也不会误要求确认（服务端是权威）。
//  2) E-2 缺口：手动添加表单没有 cwd / toolCallTimeoutMs / headers 字段，且 install 分支
//     的 manualMcpDefinition 与 overrideOf 白名单都丢弃它们 —— 添加路径比编辑路径弱。
//  3) 死代码：saveMcpEdit 之后有一个孤立 ';'（空语句）。git blame 定位到 498c144
//     （0.5.54 移除预览功能）删函数时只删了 '};' 留下 ';'；父提交 0 处、本提交 1 处。
import fs from 'node:fs';
import path from 'node:path';

const W = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(W, f), 'utf8');
const ix = read('index.js');
const c = read('client.js');

let passed = 0, failed = 0;
const check = (n, cond, d) => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 140) + ']' : '')); } };

function extractFn(source, header) {
  const start = source.indexOf(header);
  if (start < 0) return null;
  let depth = 0, quote = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source.charCodeAt(i);
    if (quote) { if (ch === 92) i++; else if (ch === quote) quote = 0; continue; }
    if (ch === 39 || ch === 34 || ch === 96) { quote = ch; continue; }
    if (ch === 47 && source.charCodeAt(i + 1) === 47) { const nl = source.indexOf('\n', i); i = nl < 0 ? source.length : nl; continue; }
    if (ch === 123) depth++;
    else if (ch === 125) { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  return null;
}

console.log('');
console.log('Test 1: needsConfirmFor 按值比对（服务端权威）');
{
  const body = extractFn(ix, 'function needsConfirmFor(');
  check('helper 可抽出', Boolean(body));
  if (body) {
    check('签名接受当前定义（第二参数）', /needsConfirmFor\(patch, current\)|needsConfirmFor\(patch,\s*current\)/.test(body) || /function needsConfirmFor\(patch, current\)/.test(body), body.split('\n')[0]);
    const fn = new Function('return (' + body + ')')();
    // 关键回归用例：键存在但值与当前相同 → 不需要确认
    check('command 键存在但值相同 → 无需确认', JSON.stringify(fn({ command: 'node' }, { command: 'node', args: ['-e', '0'] })) === '[]', JSON.stringify(fn({ command: 'node' }, { command: 'node', args: ['-e', '0'] })));
    check('args 键存在但值相同 → 无需确认', JSON.stringify(fn({ args: ['-e', '0'] }, { command: 'node', args: ['-e', '0'] })) === '[]', JSON.stringify(fn({ args: ['-e', '0'] }, { command: 'node', args: ['-e', '0'] })));
    // 值真的变了才要求确认
    check('command 值改变 → 需确认', fn({ command: 'calc' }, { command: 'node', args: [] }).includes('command'));
    check('args 值改变 → 需确认', fn({ args: ['evil'] }, { command: 'node', args: ['-e', '0'] }).includes('args'));
    // 无当前定义可比（新建/读不到）→ 保守：键存在即算改动
    check('无 current 时保守判定', fn({ command: 'node' }).includes('command') && fn({ args: ['x'] }).includes('args'));
    // 与执行面无关的字段永不触发
    check('url/title/env 等不触发', JSON.stringify(fn({ url: 'x', title: 't', env: { A: 'b' } }, { command: 'node' })) === '[]');
    check('非对象 patch/current 不炸', JSON.stringify(fn(null, null)) === '[]' && JSON.stringify(fn([1], 'x')) === '[]');
  }
}

console.log('');
console.log('Test 2: mcp.update 用当前定义比对');
{
  const caseStart = ix.indexOf('case "mcp.update"');
  const caseBody = ix.slice(caseStart, caseStart + 1400);
  check('case 读当前定义', /readDefs\(\)/.test(caseBody) || /mcp\.detail\(/.test(caseBody), caseBody.split('\n').slice(0, 3).join(' ⏎ ').slice(0, 120));
  check('needsConfirmFor 传入 current', /needsConfirmFor\(patch,\s*\w+\)/.test(caseBody));
}

console.log('');
console.log('Test 3: 客户端 patch 只含变化字段');
{
  const si = c.indexOf('const saveMcpEdit');
  const seg = c.slice(si, si + 3200);
  check('command 按变化写入（非存在性）', /if \(commandChanged\) patch\.command = draft\.command;/.test(seg) && !/if \(draft\.command !== undefined\) patch\.command/.test(seg));
  check('args 按变化写入', /if \(argsChanged\) patch\.args = argsList;/.test(seg) && !/if \(draft\.args !== undefined\) patch\.args/.test(seg));
  // commandChanged 直接比对 mcpDraftOrig；argsChanged 比对 origArgs，而 origArgs 源自 mcpDraftOrig。
  // 断言锁这条链（不是要求 mcpDraftOrig 紧邻 argsChanged）。
  check('commandChanged 直接比对原始快照', /commandChanged = [^\n]*mcpDraftOrig\?\.command/.test(seg));
  check('origArgs 源自原始快照', /origArgs = [^\n]*mcpDraftOrig\?\.args/.test(seg));
  check('argsChanged 比对 origArgs', /argsChanged = [^\n]*origArgs/.test(seg));
}

console.log('');
console.log('Test 4: E-2 添加路径字段闭环（服务端）');
{
  const mmd = extractFn(ix, 'function manualMcpDefinition(');
  check('manualMcpDefinition 存在', Boolean(mmd));
  check('含 cwd', Boolean(mmd) && /cwd:/.test(mmd));
  check('含 toolCallTimeoutMs', Boolean(mmd) && /toolCallTimeoutMs:/.test(mmd));
  check('含 headers', Boolean(mmd) && /headers:/.test(mmd));
  const ov = /const overrideOf = \[([^\]]*)\]/.exec(ix);
  check('overrideOf 含 cwd', Boolean(ov) && ov[1].includes('"cwd"'), ov && ov[1]);
  check('overrideOf 含 toolCallTimeoutMs', Boolean(ov) && ov[1].includes('"toolCallTimeoutMs"'));
}

console.log('');
console.log('Test 5: E-2 添加路径字段闭环（面板）');
{
  const ai = c.indexOf('const submitMcpAdd');
  const seg = c.slice(ai, ai + 1500);
  check('submit 发 cwd', /cwd:/.test(seg));
  check('submit 发 toolCallTimeoutMs', /toolCallTimeoutMs:/.test(seg));
  check('submit 发 headers（简写形式）', /\bheaders,/.test(seg));
  const pi = c.indexOf('手动添加 MCP 连接器');
  const pop = c.slice(pi, pi + 6500);
  check('浮层渲染 工作目录 字段', /'工作目录'/.test(pop));
  check('浮层渲染 超时 字段', /超时/.test(pop));
  check('浮层渲染 请求头 字段', /请求头/.test(pop));
}

console.log('');
console.log('Test 5b: 两步确认必须可见（不是静默 return）');
{
  // 审计发现：按钮恒显示「保存并重连」，第一次点击静默武装并 return，
  // 用户看不出任何区别——那是「假的两步确认」。旧断言匹配到注释文字，是弱锁。
  // 真正的两步确认必须让按钮文案随 mcpConfirmArmed 变化。
  const bi = c.indexOf('onClick: saveMcpEdit');
  const btnLine = c.slice(c.lastIndexOf('\n', bi) + 1, c.indexOf('\n', bi));
  check('保存按钮文案随武装态变化', /mcpConfirmArmed \?/.test(btnLine), btnLine.trim().slice(0, 120));
  check('武装态文案含确认语义', /确认保存|确认修改|确认执行/.test(btnLine), btnLine.trim().slice(0, 120));
  check('按钮区分 skill/mcp 两分支', /detail\.kind === 'skill'/.test(c.slice(bi - 400, bi)));
}
console.log('');
console.log('Test 6: 孤立空语句清理（死代码标准）');
{
  const strays = c.split('\n').filter(function (l) { return l.trim() === ';'; });
  check('client.js 无孤立 ;（0.5.54 splice 残留）', strays.length === 0, '残留 ' + strays.length + ' 处');
  // 回归断言：saveMcpEdit 的收尾必须是 }; 且其后不接孤立空语句
  const si = c.indexOf('const saveMcpEdit');
  const seg = c.slice(si, si + 4200);   // 真实函数收尾距起点 ~4000（patch 构造 + pending 分支）
  check('saveMcpEdit 正常收尾（}; 后无空语句）', /\};\s*\n\s*\n\s*\/\//.test(seg) && !/\};\s*\n\s*;\s*\n/.test(seg));
}

console.log('');
console.log('Test 7: 既有契约不破');
{
  check('needsConfirmFor 仍被 update case 使用', /needsConfirmFor\(patch/.test(ix));
  check('install 自定义 command 仍需 confirm', ix.includes('手动指定启动命令会在本机执行'));
  check('env 合并语义仍在', /patch\.envUnset/.test(read('src/mcp.js')));
  check('掩码防线仍在', /assertNoMaskLiteral\(patch\)/.test(read('src/mcp.js')));
}

console.log('');
console.log('Test 8: 语法');
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
