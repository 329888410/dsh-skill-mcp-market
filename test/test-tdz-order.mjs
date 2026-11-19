#!/usr/bin/env node
// test-tdz-order.mjs — 通用 TDZ 静态锁：useEffect/useCallback 的依赖数组在渲染时求值，
// 引用其后才声明的 const/let 会抛 ReferenceError，并把整个面板 slot 打成白屏。
//
// 这条规则被违反过两次，第二次是「加了同类测试却漏了新增代码」：
//   0.5.102：回收站 effect 放在 loadTrash 之前 → 白屏（当时只给技能侧加了顺序断言）
//   0.5.104：MCP 回收站 effect 放在 loadMcpTrash 之前 → 同样的白屏，逐条点名的测试没覆盖新增的那个
// 所以这里扫描全文件所有依赖数组，不再逐条点名。
import fs from 'node:fs';
import path from 'node:path';

const W = path.resolve(import.meta.dirname, '..');
const src = fs.readFileSync(path.join(W, 'client.js'), 'utf8');
const L = src.split(/\r?\n/);

// Earliest declaration line per identifier. Same-name locals inside unrelated helper
// functions (e.g. `size` inside MarketIcon) must not shadow the component-body useState
// declaration, so we keep the MINIMUM line, not the last match.
const firstDecl = new Map();
function note(name, line) {
  if (!name || name === 'undefined') return;
  if (!firstDecl.has(name) || line < firstDecl.get(name)) firstDecl.set(name, line);
}
L.forEach(function (line, i) {
  const n = i + 1;
  let m = /^\s{4,8}(?:const|let) ([A-Za-z_$][\w$]*)\s*=/.exec(line);
  if (m) note(m[1], n);
  m = /^\s{4,8}(?:const|let)\s*\[([^\]]*)\]\s*=/.exec(line);
  if (m) m[1].split(',').forEach(function (x) { note(x.trim(), n); });
  m = /^\s{4,8}(?:const|let)\s*\{([^\}]*)\}\s*=/.exec(line);
  if (m) m[1].split(',').forEach(function (x) { note(x.trim().split(':').pop().trim(), n); });
  m = /^\s{4,8}(?:async )?function ([A-Za-z_$][\w$]*)/.exec(line);
  if (m) note(m[1], n);
});

let passed = 0, failed = 0;
const check = function (name, cond, detail) {
  if (cond) { passed++; console.log('  OK ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '  [' + String(detail).slice(0, 90) + ']' : '')); }
};

console.log('');
console.log('Test 1: 所有依赖数组只引用在其之前声明的局部变量');
{
  const violations = [];
  L.forEach(function (line, i) {
    const m = /\}, \[([^\]]*)\]\);/.exec(line);
    if (!m) return;
    m[1].split(',').map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (d) {
      if (!/^[A-Za-z_$][\w$]*$/.test(d)) return;
      const at = firstDecl.get(d);
      if (at === undefined) return; // import, prop, or state setter — not TDZ-prone here
      if (at > i + 1) violations.push(d + ': declared ' + at + ', deps at ' + (i + 1));
    });
  });
  check('no TDZ-order violations', violations.length === 0, violations.join(' | '));
}

console.log('');
console.log('Test 2: 两个回收站 effect 都排在自己的 loader 之后（回归锚点）');
{
  const pairs = [
    ['const loadTrash = async', '}, [tab, manageTab, trashList, trashBusy, loadTrash]);'],
    ['const loadMcpTrash = async', '}, [tab, manageTab, mcpTrashList, mcpTrashBusy, loadMcpTrash]);'],
  ];
  for (const pair of pairs) {
    const a = src.indexOf(pair[0]);
    const b = src.indexOf(pair[1]);
    check(pair[1].slice(3, 40) + ' after definition', a >= 0 && b > a, 'def=' + a + ' deps=' + b);
  }
}

console.log('');
console.log('Test 3: 白屏防护——面板根节点不得因引用错误崩溃（语法 + 关键标识符齐备）');
{
  const { execSync } = await import('node:child_process');
  let ok = true;
  try { execSync('node --check client.js', { cwd: W, timeout: 20000, stdio: 'pipe' }); } catch { ok = false; }
  check('client.js 语法通过', ok);
  check('loadMcpTrash 已声明', /const loadMcpTrash = async/.test(src));
  check('mcpTrashList state 已声明', /const \[mcpTrashList, setMcpTrashList\] = useState/.test(src));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);