#!/usr/bin/env node
// test-gate-contract.mjs — 锁住闸门契约本身：缺「N passed, M failed」最后一行的
// 套件必须让 gate 变红。此前它只是 run-gate 循环体里的口头约定，同类虚高基线
// 正是靠这条约定挡住的，所以它自己也得有回归锁。
import { gateVerdict } from './gate-verdict.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const W = path.resolve(import.meta.dirname, '..');
let passed = 0, failed = 0;
const check = (n, ok, d) => { if (ok) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 170) + ']' : '')); } };

console.log('Test 1: gateVerdict 全分支（纯函数）');
check('绿：退出0 + 规范 summary + 0 failed', gateVerdict({ code: 0, killed: false, out: 'x\n5 passed, 0 failed\n' }).verdict === 'PASS', '');
check('summary 不必是字面最后一行（尾随空行允许）', gateVerdict({ code: 0, killed: false, out: 'x\n5 passed, 0 failed\n\n' }).verdict === 'PASS', '');
check('skipped 后缀仍算绿', gateVerdict({ code: 0, killed: false, out: 'x\n9 passed, 0 failed, 1 skipped\n' }).verdict === 'PASS', '');
check('summary 里 M>0 → FAIL', gateVerdict({ code: 0, killed: false, out: 'x\n3 passed, 2 failed\n' }).verdict === 'FAIL', '');
check('退出0但无 summary → NO-SUMMARY', gateVerdict({ code: 0, killed: false, out: 'starting stuff\nno summary here\n' }).verdict === 'NO-SUMMARY', '');
check('中文总结不算 summary（正是踩过的坑）', gateVerdict({ code: 0, killed: false, out: 'x\n29 项通过，0 项失败\n' }).verdict === 'NO-SUMMARY', '');
check('PASSED 大写标记不算 summary', gateVerdict({ code: 0, killed: false, out: 'x\nALL PAGING CHECKS PASSED\n' }).verdict === 'NO-SUMMARY', '');
check('summary 不在末尾则不认（中途崩掉）', gateVerdict({ code: 0, killed: false, out: 'x\n5 passed, 0 failed\nthen a crash trace\n' }).verdict === 'NO-SUMMARY', '');
check('非零退出优先于 summary', gateVerdict({ code: 1, killed: false, out: 'x\n5 passed, 0 failed\n' }).verdict === 'FAIL', '');
check('被杀 → TIMEOUT 优先', gateVerdict({ code: null, killed: true, out: 'x\n5 passed, 0 failed\n' }).verdict === 'TIMEOUT', '');
check('summary 文本透传含 skipped', gateVerdict({ code: 0, killed: false, out: 'x\n9 passed, 0 failed, 2 skipped\n' }).summary === '9 passed, 0 failed, 2 skipped', '');

console.log('');
console.log('Test 2: 真 run-gate 证伪（无 summary 的假套件必须让门变红）');
const fake = '.gate-fake-nosummary.mjs';
const good = '.gate-fake-good.mjs';
const fakePath = path.join(W, 'test', fake);
const goodPath = path.join(W, 'test', good);
const gate = (extra) => spawnSync(process.execPath, [path.join(W, 'test', 'run-gate.mjs')], {
  cwd: W, encoding: 'utf8', timeout: 180000,
  env: { ...process.env, DSH_GATE_ONLY: 'test-tdz-order.mjs', DSH_GATE_EXTRA: extra },
});
try {
  fs.writeFileSync(fakePath, 'console.log("套件开跑但没有规范总结");\n');
  const r = gate(fake);
  const out = String(r.stdout || '') + String(r.stderr || '');
  check('gate 退出码非 0', (r.status || 0) !== 0, 'status=' + r.status);
  check('gate 判它 NO-SUMMARY', /NO-SUMMARY/.test(out) && out.includes(fake), out.split('\n').filter((l) => fake.test ? l.includes(fake) : false).slice(0, 1).join(' '));
  check('publish blocked 出现', /publish blocked/.test(out), '');
  // 反向对照：同一条路径下规范套件必须绿 —— 证明 NO-SUMMARY 不是恒红误判
  fs.writeFileSync(goodPath, 'console.log("ok");\nconsole.log(`3 passed, 0 failed`);\nprocess.exit(0);\n');
  const g2 = gate(good);
  const out2 = String(g2.stdout || '') + String(g2.stderr || '');
  check('规范假套件判 PASS', /PASS/.test(out2) && (g2.status || 0) === 0, 'status=' + g2.status);
  // 非法名字必须被拒绝（防目录遍历 / 自我递归）
  const bad = gate('../package.json');
  check('越界名字被拒', (bad.status || 0) === 2 && /非法名字/.test(String(bad.stdout) + String(bad.stderr)), '');
  const rec = gate('run-gate.mjs');
  check('run-gate 自我递归被拒', (rec.status || 0) === 2, 'status=' + rec.status);
} finally {
  for (const p of [fakePath, goodPath]) { try { fs.rmSync(p, { force: true }); } catch {} }
}
check('假套件已清理', !fs.existsSync(fakePath) && !fs.existsSync(goodPath), '');
check('test/ 无残留假套件', !fs.readdirSync(path.join(W, 'test')).some((f) => f.startsWith('.gate-fake')), '');

console.log('');
console.log('Test 3: 登记进门的套件必须自己符合契约（静态锁）');
{
  const chain = JSON.parse(fs.readFileSync(path.join(W, 'package.json'), 'utf8')).scripts['test:chain'];
  const listed = [...chain.matchAll(/node test\/([\w.\-]+\.mjs)/g)].map((m) => m[1]);
  const noSummary = [];
  for (const f of listed) {
    const p = path.join(W, 'test', f);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf8');
    // 必须有一条输出「N passed, M failed」的 console.log（模板或拼接都算），
    // 且不得是「恒真」写法：至少要引用一个计数变量。
    const ok = /console\.log\([^)]*passed[,'"`\s].{0,40}failed/.test(t) || /`\$\{[\w.]+\} passed, \$\{[\w.]+\} failed/.test(t);
    if (!ok) noSummary.push(f);
  }
  check('所有登记套件都输出规范总结', noSummary.length === 0, noSummary.join(','));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
