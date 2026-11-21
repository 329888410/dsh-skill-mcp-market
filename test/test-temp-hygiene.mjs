#!/usr/bin/env node
// test-temp-hygiene.mjs — TDD: 测试套件不得直接用 os.tmpdir() 造临时目录。
//
// 实测事故（2026-11-19）：agent 工具进程的环境变量为空，os.tmpdir() 返回相对串
// 'undefined\\temp'，path.join 后按 cwd 解析 → 在用户工作区里造出垃圾目录。
// 生产代码 src/home.js 的 safeTempDir() 早已过滤含 'undefined'/'null' 的值并兜底
// 到 ~/.dsh/tmp，但测试自己没用它 —— 事发时 13 个套件受影响，已全部迁移。
import fs from 'node:fs';
import path from 'node:path';

const W = path.resolve(import.meta.dirname, '..');
const testDir = path.join(W, 'test');
// 本文件自身含被扫描的字面量（它就是 lint），必须排除，否则永远自匹配
const SELF = 'test-temp-hygiene.mjs';
const files = fs.readdirSync(testDir).filter(function (f) { return f.endsWith('.mjs') && f !== SELF; });

let passed = 0, failed = 0;
const check = function (n, c, d) {
  if (c) { passed++; console.log('  OK ' + n); }
  else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 100) + ']' : '')); }
};

console.log('');
console.log('Test 1: 除 test-safe-temp.mjs 外，测试文件不得调用 tmpdir()（os.homedir 合法，用于定位 profile）');
{
  const offenders = [];
  for (const f of files) {
    if (f === 'test-safe-temp.mjs') continue; // 它测的就是 tmpdir 本身
    const t = fs.readFileSync(path.join(testDir, f), 'utf8');
    // 漏检面（本轮实测，非推断）：旧守卫只有一个正则，只认 os.tmpdir() 写法；而
    // test-paging / test-features / test-new-features 历史上用的是 import { tmpdir }
    // 加裸 tmpdir()。三种注入形态实测有两种 MISS（这批套件虽已迁到 safeTempDir()，
    // 但守卫抓不到回归 = 没有守卫）。判定改为两条子串规则，避免正则转义与注释误伤：
    //   非注释行出现 tmpdir( → 覆盖 os.tmpdir() 与裸 tmpdir() 两种调用；
    //   非注释行出现 tmpdir } → 覆盖 import { tmpdir }（哪怕本版还没调用它）。
    const scanLines = t.split(/\r?\n/);
    for (const line of scanLines) {
      const s = line.trim();
      if (s.indexOf('//') === 0 || s.indexOf('*') === 0 || s.indexOf('/*') === 0) continue;
      if (s.indexOf('tmpdir(') >= 0 || s.indexOf('tmpdir }') >= 0) { offenders.push(f); break; }
    }
  }
  check('无裸 tmpdir() 调用', offenders.length === 0, offenders.join(', '));
}

console.log('');
console.log('Test 2: 所有 mkdtempSync 调用都以 safeTempDir() 为父目录');
{
  const offenders = [];
  for (const f of files) {
    if (f === 'test-safe-temp.mjs') continue; // 它测的就是 tmpdir 本身
    const t = fs.readFileSync(path.join(testDir, f), 'utf8');
    for (const line of t.split(/\r?\n/)) {
      if (line.indexOf('mkdtempSync(') < 0) continue;
      if (line.indexOf('safeTempDir()') < 0) offenders.push(f + ': ' + line.trim().slice(0, 60));
    }
  }
  check('mkdtemp 父目录合规', offenders.length === 0, offenders.join(' | '));
}

console.log('');
console.log('Test 3: safeTempDir 生产防线仍在（过滤 undefined/null，返回绝对真实路径）');
{
  const home = fs.readFileSync(path.join(W, 'src', 'home.js'), 'utf8');
  check('过滤 undefined 串', /includes\("undefined"\)/.test(home));
  check('过滤 null 串', /includes\("null"\)/.test(home));
  const mod = await import('../src/home.js');
  const d = mod.safeTempDir();
  check('绝对路径', path.isAbsolute(d), d);
  check('不含 undefined 字面量', !/undefined|null/i.test(d), d);
  check('目录真实存在', fs.existsSync(d), d);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);