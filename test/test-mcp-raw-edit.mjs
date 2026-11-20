#!/usr/bin/env node
// test-mcp-raw-edit.mjs — MCP 定义原文编辑（差距清单：MCP 原文编辑兜底）。
//
// 参照面板（2.3.16）对每条连接器提供「原文」编辑，理由是「面板表单还没覆盖的字段」。
// 我们同样有：toolCallTimeoutMs、reconnect、cwd、用户手写任意键 —— 表单只覆盖
// url/title/description/enabled，其余只能去文件系统改。
//
// 三个必须由测试锁死的设计决策：
//  1) **diff 而非 presence**：原文必然含 command（它是定义的一部分）。照搬 mcp.update
//     的「command !== undefined 就拒」，只改 title 的编辑也会被拒。判据必须是
//     「与当前定义相比 command/args 是否真的变了」。
//  2) **保字节**：参照承诺「文件其余字节不动」。走 save() 会被 JSON.stringify 规范化
//     并补 installedAt，那是另一种语义。原文编辑就写回原文。
//  3) **明文泄露**：detail 把 env 的 ${VAR} 掩成「***（来自环境变量）」，原文视图必然
//     暴露真实值。raw.get 要报 hasSecrets，UI 要警告且默认不自动加载。
import fs from 'node:fs';
import path from 'node:path';
import { safeTempDir } from '../src/home.js';

const W = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(W, f), 'utf8');
const mj = read('src/mcp.js');
const ix = read('index.js');
const c = read('client.js');

let passed = 0, failed = 0;
const check = (n, cond, d) => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 140) + ']' : '')); } };

const mkCtx = function () {
  const box = { mountCount: 0 };
  const ctx = {
    tools: { definitions: function () { return []; } },
    plugin: function () { box.mountCount++; return { state: 2, dispose: function () {} }; },
    loader: { entries: function () { return []; } },
  };
  return { ctx, box };
};

console.log('');
console.log('Test 1: raw.get 返回原文（不规范化）并检测明文');
{
  check('rawGet 函数存在', mj.includes('async function rawGet('));
  check('rawSet 函数存在', mj.includes('async function rawSet('));
  check('两者已导出', /rawGet, rawSet/.test(mj));
  const mod = await import('../src/mcp.js');
  if (typeof mod.createMcpManager({ ctx: mkCtx().ctx, dirs: [], shippedRoot: 'X', log: function () {} }).rawGet !== 'function') {
    for (let k = 0; k < 8; k++) check('rawGet 行为可跑', false, '函数不存在');
  } else {
    const dir = fs.mkdtempSync(path.join(safeTempDir(), 'mraw-'));
    try {
      const rawText = ['{', '  "description": "d",', '  "serverName": "alpha",', '  "command": "node",', '  "args": ["-e", "0"],', '  "transport": "stdio",', '  "toolCallTimeoutMs": 45000,', '  "customKey": {"keep": true}', '}'].join('\n');
      fs.writeFileSync(path.join(dir, 'alpha.json'), rawText, 'utf8');
      const m = mkCtx();
      const mgr = mod.createMcpManager({ ctx: m.ctx, dirs: [dir], shippedRoot: 'X', log: function () {} });
      const g = await mgr.rawGet('alpha');
      check('rawGet 逐字节一致', g.text === rawText, JSON.stringify((g.text || '').slice(0, 50)));
      check('未被规范化（键序保留）', (g.text || '').indexOf('"description"') < (g.text || '').indexOf('"serverName"'));
      check('未知字段保留', /customKey/.test(g.text));
      check('报 filePath', typeof g.filePath === 'string' && g.filePath.endsWith('alpha.json'));
      check('无 env 时 hasSecrets=false', g.hasSecrets === false, JSON.stringify(g.hasSecrets));
      const secretText = JSON.stringify({ serverName: 'beta', command: 'node', args: [], env: { TOKEN: 'sk-live-abc123', REF: '${MY_VAR}' } }, null, 2);
      fs.writeFileSync(path.join(dir, 'beta.json'), secretText, 'utf8');
      const g2 = await mgr.rawGet('beta');
      check('明文 env 值识别为 hasSecrets', g2.hasSecrets === true, JSON.stringify(g2.hasSecrets));
      let miss = '';
      try { await mgr.rawGet('nope'); } catch (e) { miss = String(e.message); }
      check('不存在的连接器报错', /没有|不存在|not found/i.test(miss), miss.slice(0, 60));
      mgr.dispose();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

console.log('');
console.log('Test 2: rawSet 的 command/args 判据是 diff 而非 presence');
{
  check('rawSet 比较 command 与现定义', /String\(def\.command \|\| ''\)/.test(mj) || /sameCommand/.test(mj));
  check('rawSet 比较 args 与现定义', /sameArgs/.test(mj) || /JSON\.stringify\(\(def\.args \|\| \[\]\)/.test(mj));
  check('真变化时报面板通道错误', mj.includes('面板通道不接受自定义 command/args'));
}

console.log('');
console.log('Test 3: rawSet 行为级验证（真落盘真拒绝）');
{
  const mod = await import('../src/mcp.js');
  if (typeof mod.createMcpManager({ ctx: mkCtx().ctx, dirs: [], shippedRoot: 'X', log: function () {} }).rawSet !== 'function') {
    for (let k = 0; k < 11; k++) check('rawSet 行为可跑', false, '函数不存在');
  } else {
    const dir = fs.mkdtempSync(path.join(safeTempDir(), 'mraw3-'));
    try {
      const base = { serverName: 'gamma', transport: 'stdio', command: 'node', args: ['-e', '0'], title: '旧标题', env: {} };
      fs.writeFileSync(path.join(dir, 'gamma.json'), JSON.stringify(base, null, 2), 'utf8');
      const m = mkCtx();
      const mgr = mod.createMcpManager({ ctx: m.ctx, dirs: [dir], shippedRoot: 'X', log: function () {} });
      const t1 = JSON.stringify({ serverName: 'gamma', transport: 'stdio', command: 'node', args: ['-e', '0'], title: '新标题', env: {}, toolCallTimeoutMs: 90000 }, null, 2);
      const r1 = await mgr.rawSet('gamma', t1);
      check('只改 title 通过（diff 判据）', r1 && r1.ok === true && r1.saved === true, JSON.stringify(r1 && r1.connectError));
      check('新标题已落盘', fs.readFileSync(path.join(dir, 'gamma.json'), 'utf8').includes('新标题'));
      check('表单覆盖不到的字段写入', fs.readFileSync(path.join(dir, 'gamma.json'), 'utf8').includes('90000'));
      check('重连失败不回滚文件（3a 已落盘即成立）', fs.readFileSync(path.join(dir, 'gamma.json'), 'utf8').includes('新标题'));
      let e2 = '';
      try { await mgr.rawSet('gamma', JSON.stringify({ serverName: 'gamma', command: 'calc.exe', args: [] }, null, 2)); } catch (e) { e2 = String(e.message); }
      check('改 command 被拒', /面板通道不接受/.test(e2), e2.slice(0, 70));
      check('被拒后文件未变', fs.readFileSync(path.join(dir, 'gamma.json'), 'utf8').includes('新标题'));
      let e3 = '';
      try { await mgr.rawSet('gamma', JSON.stringify({ serverName: 'gamma', command: 'node', args: ['evil.js'] }, null, 2)); } catch (e) { e3 = String(e.message); }
      check('改 args 被拒', /面板通道不接受/.test(e3), e3.slice(0, 70));
      let e4 = '';
      try { await mgr.rawSet('gamma', JSON.stringify({ serverName: 'delta', command: 'node', args: ['-e', '0'] }, null, 2)); } catch (e) { e4 = String(e.message); }
      check('改 serverName 被拒', /serverName/.test(e4), e4.slice(0, 70));
      fs.writeFileSync(path.join(dir, 'gamma.json'), JSON.stringify(base, null, 2), 'utf8');
      let e5 = '';
      try { await mgr.rawSet('gamma', '{ "title": broken, }'); } catch (e) { e5 = String(e.message); }
      check('坏 JSON 被拒', /JSON/.test(e5), e5.slice(0, 70));
      check('坏 JSON 后文件完好', fs.readFileSync(path.join(dir, 'gamma.json'), 'utf8').includes('旧标题'));
      let e6 = '';
      try { await mgr.rawSet('gamma', '[1,2,3]'); } catch (e) { e6 = String(e.message); }
      check('非对象原文被拒', e6.length > 0, e6.slice(0, 60));
      // 重连尽力而为：CI（Linux）没有宿主 asar，importShipped 必然失败——那属于
      // 「已保存但连接失败」，必须如实报告而不是抛错或回滚。所以只锁 mount 被尝试过。
      // 重连尽力而为：CI（Linux）没有宿主 asar，importShipped 在 ctx.plugin 之前就抛，
      // mountCount 恒为 0 —— 拿它当判据会在 CI 上必红。改为两锁：结构锁（rawSet 体内
      // 确实尝试 unmount+mount）+ 行为锁（失败降级为 connectError，且不回滚文件）。
      const rawSetBody = mj.slice(mj.indexOf('async function rawSet('), mj.indexOf('async function status('));
      check('rawSet 尝试重连（结构锁）', /unmount\(name\);[\s\S]{0,80}await mount\(saved\);/.test(rawSetBody));
      check('保存与连接分开报告', typeof r1.connected === 'boolean' && typeof r1.connectError === 'string', JSON.stringify(r1));
      check('保存与连接分开报告', typeof r1.connected === 'boolean' && typeof r1.connectError === 'string');
      mgr.dispose();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

console.log('');
console.log('Test 4: op 注册与白名单');
{
  check('case "mcp.raw.get"', ix.includes('case "mcp.raw.get"'));
  check('case "mcp.raw.set"', ix.includes('case "mcp.raw.set"'));
  for (const f of ['test-manage-panel.mjs', 'test-install-progress.mjs']) {
    const t = read('test/' + f);
    check(f + ' 含 mcp.raw.get', t.includes('mcp.raw.get'));
    check(f + ' 含 mcp.raw.set', t.includes('mcp.raw.set'));
  }
  const rg = read('src/rpc-guard.js');
  check('raw.set 需 confirm（改定义属破坏性）', /"mcp\.raw\.set"/.test(rg));
}

console.log('');
console.log('Test 5: 面板 UI（默认不加载 + 明文警告）');
{
  check('mcpRaw state 存在', /const \[mcpRaw, setMcpRaw\] = useState\(null\)/.test(c));
  check('原文入口按钮', /'原文'/.test(c));
  check('明文警告文案', /明文/.test(c) && /环境变量/.test(c));
  check('hasSecrets 驱动警告', /mcpRaw\.hasSecrets/.test(c));
  check('保存走 mcp.raw.set', c.includes("call('mcp.raw.set'"));
  check('保存带 confirm', /'mcp\.raw\.set'[\s\S]{0,220}confirm: true/.test(c));
  check('command/args 只读提示沿用', /mcp_market_install/.test(c));
  check('textarea 编辑原文', /value: mcpRaw\.text/.test(c));
}

console.log('');
console.log('Test 6: 既有行为不破');
{
  check('mcp.update 的 presence 守卫仍在', /patch\.command !== undefined \|\| patch\.args !== undefined/.test(ix));
  check('detail 的 env 掩码仍在', /\*\*\*（来自环境变量）/.test(mj));
  check('list 契约不变', /return \[\.\.\.defs\.values\(\)\]\.map/.test(mj));
  check('窄屏判据未被误伤', /NARROW_PANEL_WIDTH = 560/.test(c));
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
