#!/usr/bin/env node
// test-fiber-state.mjs — 修 0.5.115 的字段名缺陷：fiber.status 不存在，真实字段是
// fiber.state（数字 0–5，cordis lib/index.js 编译产物实测 this.state = 2 即 ACTIVE）。
//
// 状态映射（cordis src/fiber.ts:147 const enum FiberState，数字枚举无字符串赋值）：
//   0 PENDING → loading   1 LOADING → loading   2 ACTIVE → active
//   3 FAILED  → failed    4 DISPOSED → unloaded 5 UNLOADING → unloaded
// error 记录在私有 _error 上（公开面只有 state），detail 只能来自 state 本身或空。
import fs from 'node:fs';
import path from 'node:path';

const W = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(W, f), 'utf8');
const mj = read('src/mcp.js');

let passed = 0, failed = 0;
const check = (n, cond, d) => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 130) + ']' : '')); } };

console.log('');
console.log('Test 1: normalizePhase 接受数字 state（行为级）');
{
  const body = (function () {
    const start = mj.indexOf('function normalizePhase(raw) {');
    let depth = 0, quote = 0, end = -1;
    for (let i = start; i < mj.length; i++) {
      const ch = mj.charCodeAt(i);
      if (quote) { if (ch === 92) i++; else if (ch === quote) quote = 0; continue; }
      if (ch === 39 || ch === 34 || ch === 96) { quote = ch; continue; }
      if (ch === 123) depth++;
      else if (ch === 125) { depth--; if (depth === 0) { end = i; break; } }
    }
    return mj.slice(start, end + 1);
  })();
  check('normalizePhase 函数体完整抽出', body.length > 100);
  const fn = new Function('return (' + body + ')')();
  check('0 (PENDING) → loading', fn(0) === 'loading', fn(0));
  check('1 (LOADING) → loading', fn(1) === 'loading', fn(1));
  check('2 (ACTIVE) → active', fn(2) === 'active', fn(2));
  check('3 (FAILED) → failed', fn(3) === 'failed', fn(3));
  check('4 (DISPOSED) → unloaded', fn(4) === 'unloaded', fn(4));
  check('5 (UNLOADING) → unloaded', fn(5) === 'unloaded', fn(5));
  check('字符串仍兼容（旧路径）', fn('active') === 'active' && fn('failed') === 'failed');
  check('空值回空（不猜）', fn('') === '' && fn(null) === '' && fn(undefined) === '');
}

console.log('');
console.log('Test 2: 主路读 fiber.state 而不是 fiber.status');
{
  check('主路读 fiber.state', /normalizePhase\(fiber && fiber\.state\)/.test(mj));
  const codeOnly = mj.split('\n').filter(function (l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); }).join('\n');
  check('代码不再读 fiber.status（缺陷字段）', !/fiber\.status/.test(codeOnly), (codeOnly.match(/.{0,40}fiber\.status.{0,20}/g) || []).join(' ⏎ '));
  // 注释里提到 fiber.status 是必要的缺陷说明（0.5.115 读错字段），不该被这条断言误伤。
  check('映射表在位（数字语义可查）', /PENDING|0 → loading|FiberState/.test(mj));
}

console.log('');
console.log('Test 3: list/status 的 phase 不再恒 unknown（行为级）');
{
  // 假 ctx：plugin() 返回带 state:2 的真 fiber 形态
  const mod = await import('../src/mcp.js');
  const { safeTempDir } = await import('../src/home.js');
  const dir = fs.mkdtempSync(path.join(safeTempDir(), 'fstate-'));
  fs.writeFileSync(path.join(dir, 'demo.json'), JSON.stringify({ serverName: 'demo', transport: 'stdio', command: 'node', args: [] }), 'utf8');
  let fiber = null;
  const ctx = {
    tools: { definitions: function () { return []; } },
    plugin: function (p, cfg) { fiber = { state: 2, dispose: function () {} }; return fiber; },
    loader: { entries: function () { return []; } },
  };
  const mgr = mod.createMcpManager({ ctx, dirs: [dir], shippedRoot: 'X', log: function () {} });
  // mount 需要 importShipped 成功——退而验证 status 路径（不 mount，直接造 mounted map 不可行，
  // 所以走 loader 主路的替代：无 mounted、无 loader 命中 → unloaded，而不是 unknown）
  const st = await mgr.status();
  check('未挂载的连接器 phase=unloaded（非 unknown）', Array.isArray(st.items) && st.items[0].phase === 'unloaded', JSON.stringify(st.items[0] || {}));
  check('mounted=false 与 phase 一致', st.items[0].mounted === false && st.items[0].phase === 'unloaded');
  mgr.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('');
console.log('Test 4: 既有契约不破');
{
  check('list 仍返回数组', /return \[\.\.\.defs\.values\(\)\]\.map/.test(mj));
  check('broken 仍导出', /\bbroken\b/.test(mj.slice(mj.indexOf('return { init, dispose'))));
  check('toolDetailsFor 仍在', /function toolDetailsFor\(/.test(mj));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
