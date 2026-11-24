#!/usr/bin/env node
// test-suite-inventory.mjs — 套件清单一致性：门里不许有重复，磁盘上不许有游离。
//
// 起因：我核验时写了 `list.length !== new Set(list).length` —— Set 没有 length，
// 它是 undefined，于是这个判定恒为 true，看起来像「查出重复」其实什么都没测。
// 正确写法是 .size。这条经验必须变成 CI 断言，而不是靠我记得。
//
// 同时把「磁盘有、门里无」的套件显式化：要么登记，要么进豁免表并写明理由。
// 静默游离 = 基线数字虚高或漏项，两边都可能掩盖回归。
import fs from 'node:fs';
import path from 'node:path';

const W = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(W, 'package.json'), 'utf8'));
const chain = pkg.scripts['test:chain'];
const listed = [];
const re = /node test\/([\w.\-]+\.mjs)/g;
let m;
while ((m = re.exec(chain))) listed.push(m[1]);

let passed = 0, failed = 0;
const check = (n, cond, d) => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 160) + ']' : '')); } };

console.log('Test 1: 门内清单');
check('解析到套件', listed.length >= 40, listed.length);
// Set 用 .size；写成 .length 会得到 undefined，让不等式恒真（假信号）。
check('无重复登记（.size 判定）', listed.length === new Set(listed).size, '登记 ' + listed.length + ' 唯一 ' + new Set(listed).size);
const dupes = listed.filter((x, i) => listed.indexOf(x) !== i);
check('重复项清单为空', dupes.length === 0, dupes.join(','));
check('run-gate 的解析与门一致', fs.readFileSync(path.join(W, 'test/run-gate.mjs'), 'utf8').includes("pkg.scripts['test:chain']"), '');

console.log('');
console.log('Test 2: 磁盘 vs 门（游离必须显式豁免）');
const onDisk = fs.readdirSync(path.join(W, 'test')).filter((f) => f.endsWith('.mjs'));
// 辅助模块（库/运行器）不是套件，不该进门。硬编码清单会腐烂：0.5.132 新增
// gate-verdict.mjs 时这里没更新，守卫就把它误报成「静默游离」。改成自动判定：
// 名字不是 test-*.mjs（run-gate.mjs），或被同目录其他文件 import（anchor-lib、
// gate-verdict），任一成立即视为辅助模块。
const allFiles = fs.readdirSync(path.join(W, 'test')).filter((x) => x.endsWith('.mjs'));
const importedBy = new Set();
for (const x of allFiles) {
  const src = fs.readFileSync(path.join(W, 'test', x), 'utf8');
  for (const ref of src.matchAll(/from\s+['"]\.[\/](\.?\/?)([\w.\-]+\.mjs)['"]/g)) importedBy.add(ref[2]);
  for (const ref of src.matchAll(/import\(.*?['"][\w.\-]*\/?([\w.\-]+\.mjs)['"]/g)) importedBy.add(ref[1]);
}
const helpers = allFiles.filter((x) => !x.startsWith('test-') || importedBy.has(x));
// 豁免表：不进门的套件必须写清理由，且文件必须真实存在（防豁免表腐烂）。
const EXEMPT = {
  'test-sources.mjs': '交互式海量探针（--skill/--mcp 参数），120s 不收敛，不适合当 CI 门',
};
const unlisted = onDisk.filter((f) => !listed.includes(f) && !helpers.includes(f));
const silent = unlisted.filter((f) => !Object.prototype.hasOwnProperty.call(EXEMPT, f));
check('无静默游离套件（要么进门要么写豁免）', silent.length === 0, '游离: ' + silent.join(', '));
const ghostExempt = Object.keys(EXEMPT).filter((f) => !onDisk.includes(f));
check('豁免表里的文件都真实存在', ghostExempt.length === 0, ghostExempt.join(','));
const listedHelpers = listed.filter((f) => helpers.includes(f));
check('辅助模块未被当套件登记', listedHelpers.length === 0, listedHelpers.join(','));

console.log('');
console.log('Test 3: 门内套件文件都存在');
{
  const missing = listed.filter((f) => !onDisk.includes(f));
  check('无幽灵登记', missing.length === 0, missing.join(','));
}

console.log('');

console.log('');
console.log('Test 4: 仓库根不得有核验临时件（.gate.txt/.msg.txt 事故的根因锁）');
{
  const { execFileSync } = await import('node:child_process');
  const run = (a) => { try { return execFileSync('git', a, { cwd: W, encoding: 'utf8' }); } catch { return ''; } };
  const st = run(['status', '--porcelain']);
  const stray = [];
  for (const line of st.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // 未跟踪的点文件 = 核验脚本写在仓库根的临时件。历史事故：f074f0b 曾用 git add -A
    // 把 .gate.txt/.msg.txt 收进提交（只能 amend 剔除 + 重打 tag）；.al-err.txt/.al-out.txt
    // 句柄残留是同一根因。正确做法是写到仓库外（我现在的脚本用 C:\Users\Public\dsh-scratch）。
    if (line.trimStart().startsWith('??')) {
      const p = line.slice(3).trim();
      if (p.startsWith('.')) stray.push(p);
      // 字面环境变量目录（%SystemDrive%\ProgramData\…）＝某条命令把没展开的变量名
      // 当成路径传给了 Windows shell，于是仓库根长出一棵真的 Windows 缓存树。它不以点开头，
      // 点文件判据抓不到；git check-ignore 对它也无输出，只能显式点名。
      if (/%[^%/]+%/.test(p) || p.charAt(0) === "$") stray.push(p);
    }
  }
  check('工作树无未跟踪的临时点文件', stray.length === 0, stray.join(', '));
  // 只看 git status 不够：垃圾树一旦被 .gitignore 兜住，工作树判据永远沉默，
  // 而磁盘上那几 MB 缓存还在原地。这里直接扫仓库根的目录名。
  const junk = [];
  for (const ent of fs.readdirSync(W, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const nm = ent.name;
    if (/%[^%]+%/.test(nm) || nm.charAt(0) === '$') junk.push(nm);
    else if (/\{?[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}?/.test(nm)) junk.push(nm);
  }
  check('仓库根不含字面环境变量或 GUID 式垃圾目录', junk.length === 0, junk.join(', '));
  const tracked = run(['ls-files']).split(/\r?\n/).filter(Boolean);
  const bad = tracked.filter((x) => {
    if (x.indexOf('/') >= 0) return false;
    if (x === '.gitignore' || x === '.npmignore') return false;
    return x.startsWith('.');
  });
  check('版本库根不含点文件临时件', bad.length === 0, bad.join(', '));
}

console.log('');
console.log('Test 5: 辅助模块必须有可执行断言覆盖（工具无断言 = 假绿风险）');
{
  // edit-lib/anchor-lib/gate-verdict/run-gate 这类辅助模块本身不是套件，但每一个都必须
  // 被至少一个 test-* 引用（import）或执行（spawn）。否则就是「看起来安全的机制」没人
  // 验证 —— applier 静默错位事故正是这一类：语法合法、diff 看不出问题、语义已经错了。
  const helpers = onDisk.filter((f) => !f.startsWith('test-'));
  const uncovered = [];
  for (const h of helpers) {
    let referenced = false;
    for (const t of onDisk) {
      if (!t.startsWith('test-')) continue;
      if (fs.readFileSync(path.join(W, 'test', t), 'utf8').indexOf(h) >= 0) { referenced = true; break; }
    }
    if (!referenced) uncovered.push(h + '（没有任何 test-* 引用/执行它）');
  }
  check('每个辅助模块都被至少一个套件引用/执行', uncovered.length === 0, uncovered.join(', '));
}
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
