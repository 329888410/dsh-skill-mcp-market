#!/usr/bin/env node
// test-edit-lib.mjs — 写文件 helper 自身的契约（含证伪）。
// 手写插入脚本的笔误连续复发，这个 helper 是把纪律做成机制；机制自己必须有锁，
// 否则它就成了新的「看起来安全但没人验证」的路径。
import fs from 'node:fs';
import path from 'node:path';
import { planEdits, patchFile, applyOps, runOpsFile } from './edit-lib.mjs';
import { blockEnd } from './anchor-lib.mjs';
import { placeBlock } from './edit-lib.mjs';
import { safeTempDir } from '../src/home.js';

let passed = 0, failed = 0;
const check = (n, cond, d) => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 150) + ']' : '')); } };

const CR = String.fromCharCode(13);
const NL = String.fromCharCode(10);
const tmp = fs.mkdtempSync(path.join(safeTempDir(), 'editlib-'));
const file = path.join(tmp, 'crlf.txt');
fs.writeFileSync(file, ['line one', 'target line', 'line three'].join(CR + NL) + CR + NL);

console.log('Test 1: 锚唯一性');
check('唯一锚替换成功', planEdits(fs.readFileSync(file, 'utf8'), [{ find: 'target line', replace: 'fixed' }]).text.includes('fixed'), '');
let err = '';
try { planEdits(fs.readFileSync(file, 'utf8'), [{ find: 'line one', replace: 'a' }, { find: 'line one', replace: 'b' }]); } catch (e) { err = String(e.message); }
check('第二次用同一锚被拒（幂等护栏）', /命中 0 次/.test(err), err.slice(0, 80));
const dup = 'x' + CR + NL + 'y' + CR + NL + 'x' + CR + NL + 'z';
let err2 = '';
try { planEdits(dup, [{ find: 'x', replace: 'q' }]); } catch (e) { err2 = String(e.message); }
check('多命中锚 throw 并列出位置', /命中 2 次/.test(err2) && /位置 1,3/.test(err2), err2.slice(0, 90));
let err3 = '';
try { planEdits(dup, [{ find: [], replace: 'q' }]); } catch (e) { err3 = String(e.message); }
check('空锚被拒（空锚无法定位）', /不得为空/.test(err3), err3.slice(0, 70));

console.log('');
console.log('Test 2: EOL 约定与不混用');
const lfFile = path.join(tmp, 'lf.txt');
fs.writeFileSync(lfFile, 'a' + NL + 'b' + NL);
const r2 = patchFile(lfFile, [{ find: 'b', replace: 'c' }]);
check('LF 文件保持 LF', !fs.readFileSync(lfFile, 'utf8').includes(CR), '');
const mixedFile = path.join(tmp, 'mixed.txt');
fs.writeFileSync(mixedFile, 'a' + CR + NL + 'b' + NL);
let err4 = '';
try { patchFile(mixedFile, [{ find: 'b', replace: 'c' }]); } catch (e) { err4 = String(e.message); }
check('混用行尾的文件拒绝编辑', /混用行尾/.test(err4), err4.slice(0, 80));

console.log('');
console.log('Test 3: expectDelta / expectLines 抓结构性缺陷');
let err5 = '';
try { patchFile(file, [{ find: 'target line', replace: ['a', 'b', 'c'] }], { expectDelta: 0 }); } catch (e) { err5 = String(e.message); }
check('行数变化与预期不符即 throw', /≠ 预期/.test(err5), err5.slice(0, 80));
check('throw 时原文件未被改写', fs.readFileSync(file, 'utf8').includes('target line'), '');

console.log('');
console.log('Test 4: 多行块插入（真实事故形态）');
const ins = patchFile(file, [{ find: 'line one', replace: ['line one', 'inserted 1', 'inserted 2'] }]);
check('插入落在锚之后', ins.text.indexOf('inserted 1') > ins.text.indexOf('line one'), '');
check('替换后旧行消失', !ins.text.includes('target line') === false, '');
check('块内每行都在', ['inserted 1', 'inserted 2'].every((s) => ins.text.includes(s)), '');
check('dryRun 不落盘', (() => { const before = fs.readFileSync(file, 'utf8'); patchFile(file, [{ find: 'line one', replace: 'noop' }], { dryRun: true }); return fs.readFileSync(file, 'utf8') === before; })(), '');

console.log('');
console.log('Test 5: blockEnd 按深度定位块尾');
{
  const src = ['const fn = (a) => {', '  while (a) {', '    if (a) { break; }', '  }', '  return a;', '}'].join(NL);
  check('块尾是最后一行而不是内层}', blockEnd(src, 0) === 5, blockEnd(src, 0));
  check('字符串内的花括号不计数', blockEnd('const s = "a{b"; x = { y: 1 };', 0) === 0, '');
  check('行注释里的花括号不计数', blockEnd(['{', '  // }', '  }'].join(NL), 0) === 2, '');
  let err6 = '';
  try { blockEnd('{', 0); } catch (e) { err6 = String(e.message); }
  check('未闭合必须 throw（不猜块尾）', /未找到配对闭括号/.test(err6), err6.slice(0, 70));
  let err7 = '';
  try { blockEnd('  }', 0); } catch (e) { err7 = String(e.message); }
  check('起点前有闭括号必须 throw', /闭括号/.test(err7), err7.slice(0, 70));
  let err8 = '';
  try { blockEnd('a', 9); } catch (e) { err8 = String(e.message); }
  check('越界起点必须 throw', /越界/.test(err8), err8.slice(0, 70));
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log('');

console.log('');
console.log('Test 6: applyOps 幂等 + 结构锚保护 + placeBlock 方向（机制证伪，全部真跑）');
{
  const dir2 = fs.mkdtempSync(path.join(safeTempDir(), 'editlib2-'));
  const f2 = path.join(dir2, 'crlf2.txt');
  fs.writeFileSync(f2, ['const A = 1;', 'const target = 2;', 'const B = 3;'].join(CR + NL) + CR + NL);
  // needle 与替换后的行不得有子串关系（const target = 2; 是 const target = 22; 的前缀，
  // 会让幂等判定的 needle 命中计数失真 —— 这是选 99 而不是 22 的原因）。
  const ops1 = [{ needle: 'const target = 2;', span: 1, block: ['// replaced', 'const target = 99;'] }];
  const ra = applyOps(f2, ops1);
  const bytes1 = fs.readFileSync(f2, 'utf8');
  check('applyOps 首次应用 applied=1', ra.applied === 1, JSON.stringify(ra));
  const rb = applyOps(f2, ops1);
  const bytes2 = fs.readFileSync(f2, 'utf8');
  check('同一 ops 二次应用 skipped=1 applied=0（幂等）', rb.skipped === 1 && rb.applied === 0, JSON.stringify(rb));
  check('两次连跑字节完全一致', bytes1 === bytes2, '');
  const before = fs.readFileSync(f2, 'utf8');
  let threw = '';
  try { applyOps(f2, [{ needle: 'const target = 99;', span: 2, block: ['// oops'] }]); } catch (e) { threw = String(e.message); }
  check('span 吃掉结构锚必须 throw', threw.indexOf('结构锚') >= 0, threw.slice(0, 120));
  check('throw 时文件未被改写', fs.readFileSync(f2, 'utf8') === before, '');
  const rc = applyOps(f2, [{ needle: 'const target = 99;', span: 1, block: ['const target = 99;', 'const C = 4;'] }]);
  check('块回归被替行则允许（span=1）', rc.applied === 1 && fs.readFileSync(f2, 'utf8').includes('const C = 4;'), JSON.stringify(rc));
  let threw2 = '';
  try { applyOps(f2, [{ needle: 'const absent = 9;', span: 1, block: ['x'] }]); } catch (e) { threw2 = String(e.message); }
  check('needle 0 命中且块不在必须 throw（不许静默跳过）', threw2.indexOf('命中 0') >= 0, threw2.slice(0, 120));
  let threw3 = '';
  try { placeBlock(f2, { anchor: 'const A = 1;', side: 'keep', block: ['x'] }); } catch (e) { threw3 = String(e.message); }
  check('placeBlock 非法 side 必须 throw（拒绝猜测方向）', threw3.indexOf('side') >= 0, threw3.slice(0, 120));
  const rd = placeBlock(f2, { anchor: 'const A = 1;', side: 'after', block: ['const A2 = 0;'] });
  const txt = fs.readFileSync(f2, 'utf8');
  const txtLines = txt.split(CR + NL);
  check('placeBlock side=after 落点在锚之后', txt.indexOf('const A2 = 0;') > txt.indexOf('const A = 1;'), '');
  check('placeBlock 落点相邻（锚下一行即块首）', txtLines[txtLines.indexOf('const A = 1;') + 1] === 'const A2 = 0;', JSON.stringify(txtLines[txtLines.indexOf('const A = 1;') + 1]));
  // runOpsFile：一次性消费 + 状态回写
  const opsPath = path.join(dir2, 'ops.json');
  fs.writeFileSync(path.join(dir2, 'blk.txt'), 'const D2 = 5;' + NL);
  fs.writeFileSync(opsPath, JSON.stringify([{ file: f2, needle: 'const B = 3;', span: 1, blockFile: 'blk.txt' }]));
  const t1 = runOpsFile(opsPath);
  check('runOpsFile 应用 1 条', t1.applied === 1, JSON.stringify(t1));
  check('ops 文件已回写 done:true', JSON.parse(fs.readFileSync(opsPath, 'utf8'))[0].done === true, '');
  const t2 = runOpsFile(opsPath);
  check('重跑只计 alreadyDone（一次性消费）', t2.alreadyDone === 1 && t2.applied === 0, JSON.stringify(t2));
  check('结果确实写入文件', fs.readFileSync(f2, 'utf8').includes('const D2 = 5;'), '');
  // 逃逸口审计锁：默认仍 throw（上面已锁）；带逐条 flag 才放行，且 forced 必须
  // 计数并持久化到 ops 条目 —— 本轮逃逸数必须是读得出的数字，不能靠感觉。
  const fEsc = path.join(dir2, 'esc.txt');
  fs.writeFileSync(fEsc, ['const X3 = 1;', 'const Y3 = 2;'].join(CR + NL) + CR + NL);
  const rEsc = applyOps(fEsc, [{ needle: 'const X3 = 1;', span: 2, block: ['// erased'], allowStructuralLoss: true }]);
  check('flag 逃逸放行且 forced=1（可审计计数）', rEsc.applied === 1 && rEsc.forced === 1, JSON.stringify(rEsc));
  const rZero = applyOps(fEsc, [{ needle: '// erased', span: 1, block: ['// erased2'] }]);
  check('普通 op forced=0', rZero.forced === 0, JSON.stringify(rZero));
  const fEsc2 = path.join(dir2, 'esc2.txt');
  fs.writeFileSync(fEsc2, ['const A2 = 1;', 'const B2 = 2;'].join(CR + NL) + CR + NL);
  let threw4 = '';
  try { applyOps(fEsc2, [{ needle: 'const A2 = 1;', span: 2, block: ['// gone'] }]); } catch (e) { threw4 = String(e.message); }
  check('不显式带 flag 就不存在逃逸（默认仍 throw）', threw4.indexOf('结构锚') >= 0, threw4.slice(0, 110));
  const fEsc3 = path.join(dir2, 'esc3.txt');
  fs.writeFileSync(fEsc3, ['const P1 = 1;', 'const P2 = 2;'].join(CR + NL) + CR + NL);
  fs.writeFileSync(path.join(dir2, 'blk3.txt'), '// wiped' + NL);
  const opsEsc = path.join(dir2, 'opsesc.json');
  fs.writeFileSync(opsEsc, JSON.stringify([{ file: fEsc3, needle: 'const P1 = 1;', span: 2, blockFile: 'blk3.txt', allowStructuralLoss: true }]));
  const t3 = runOpsFile(opsEsc);
  check('runOpsFile 汇总 forced=1', t3.forced === 1, JSON.stringify(t3));
  check('ops 条目持久化 forced（逐条可审计）', JSON.parse(fs.readFileSync(opsEsc, 'utf8'))[0].forced === 1, '');
  fs.rmSync(dir2, { recursive: true, force: true });
}

console.log('');
console.log('Test 7: 本轮结构锚逃逸数必须为 0（仓库内不得出现未申报的 allowStructuralLoss）');
{
  // 逃逸口是逐条显式的，所以「用没用」是能静态读出来的数字，不靠人回忆。
  // 期望值固定 0：一旦哪天出现非 0，这条就红，交付说明必须写清是哪条 op、为什么。
  const fs2 = await import('node:fs');
  const path2 = await import('node:path');
  const root = path2.resolve(import.meta.dirname, '..');
  const found = [];
  for (const dir of ['test', 'src']) {
    for (const name of fs2.readdirSync(path2.join(root, dir))) {
      if (!/\.(mjs|js)$/.test(name)) continue;
      const text = fs2.readFileSync(path2.join(root, dir, name), 'utf8');
      const hits = text.split(String.fromCharCode(10)).filter((l) => l.indexOf('allowStructuralLoss: true') >= 0).length;
      if (hits) found.push(dir + '/' + name + ':' + hits);
    }
  }
  // 机制本体与 Test 6 的证伪样本允许出现（那是刻意的逃逸演练），其余都算未申报
  const allowed = new Set(['test/edit-lib.mjs', 'test/test-edit-lib.mjs']);
  const offenders = found.filter((x) => !allowed.has(x.split(':')[0]));
  check('仓库内无未申报的结构锚逃逸', offenders.length === 0, offenders.join(', '));
}

console.log('');
console.log('Test 8: Test 7 的白名单与作用面本身被锁死');
{
  // 判据串一律用字符码拼出：断言里若出现被搜索字面量的本体，self 会命中两次
  // （自指）—— 第一版就是这么假红的。
  const self = fs.readFileSync(new URL('./test-edit-lib.mjs', import.meta.url), 'utf8');
  const Q = String.fromCharCode(39);
  const LB = String.fromCharCode(91);
  const RB = String.fromCharCode(93);
  const NLN = String.fromCharCode(10);
  const ALLOW = 'const allowed = new Set(' + LB;
  const LOOP = 'for (const dir of ' + LB + Q + 'test' + Q + ', ' + Q + 'src' + Q + RB;
  check('白名单声明唯一', self.split(ALLOW).length - 1 === 1, self.split(ALLOW).length - 1);
  const at = self.indexOf(ALLOW);
  const firstLine = self.slice(at, self.indexOf(NLN, at));
  check('白名单恰为两项（该行四个引号）', firstLine.split(Q).length - 1 === 4 && firstLine.indexOf('edit-lib.mjs') >= 0 && firstLine.indexOf('test-edit-lib.mjs') >= 0, JSON.stringify(firstLine.slice(0, 110)));
  check('扫描面唯一且限定 test 与 src', self.split(LOOP).length - 1 === 1, self.split(LOOP).length - 1);
}

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);





