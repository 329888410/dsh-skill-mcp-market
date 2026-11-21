#!/usr/bin/env node
// test-op-availability.mjs — TDD: 依赖服务端 op 的入口必须「运行时确认存在才出现」，
// 不能摆一个每次点击都必然失败的假可控件。
//
// 实测症状（当前 live）：宿主永不重启，运行中的服务进程仍是旧 index.js，里面没有
// skillhub.evaluation 这个 op（v0.5.131→v0.5.134 唯一新增的 op，已逐字节核对）。于是
// 列表里 24 个「质量」按钮点一次失败一次：unknown operation。判据必须是运行时判别，
// 不是版本号——写死版本号只是把同一个谎换了种写法，宿主不重启时照样失真。
import fs from 'node:fs';
import path from 'node:path';
import { countHits, blockEnd } from './anchor-lib.mjs';

const W = path.resolve(import.meta.dirname, '..');
const NL = String.fromCharCode(10);
const client = fs.readFileSync(path.join(W, 'client.js'), 'utf8').replace(/\r\n/g, NL);
const CL = client.split(NL);
let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  ' + String(d).slice(0, 120) : '')); } };

function grabFn(name) {
  const start = CL.findIndex((l) => l.trimStart().startsWith('const ' + name + ' ='));
  if (start < 0) return null;
  if (!/[({=]$/.test(CL[start].trimEnd())) return CL[start];
  const end = blockEnd(client, start, name);
  return CL.slice(start, end + 1).join(NL);
}

console.log('');
console.log('Test 1: 判据函数存在，且与版本号无关');
{
  const s1 = grabFn('isUnknownOperation');
  const s2 = grabFn('probeOpPresent');
  check('isUnknownOperation 已定义', s1 !== null, 'client.js 里找不到');
  check('probeOpPresent 已定义（统一探测入口）', s2 !== null, 'client.js 里找不到');
}

console.log('');
console.log('Test 2: isUnknownOperation 真值表（两进程的真实错误形态都取自实测）');
{
  const s1 = grabFn('isUnknownOperation');
  if (!s1) check('可求值', false, '函数缺失');
  else {
    const f = new Function(s1 + NL + '; return isUnknownOperation;')();
    check('旧进程 unknown operation → true', f('unknown operation "skillhub.evaluation"') === true);
    check('新进程参数校验错 → false（op 存在）', f('缺少 skill 标识') === false);
    check('普通错误 → false', f('网络超时') === false);
    check('空/未定义 → false', f(undefined) === false && f('') === false);
    check('大小写变化仍判未知', f('Unknown Operation x') === true);
  }
}

console.log('');
console.log('Test 3: probeOpPresent 三情形（call 桩驱动，不碰网络）');
{
  const s1 = grabFn('isUnknownOperation');
  const s2 = grabFn('probeOpPresent');
  if (!s1 || !s2) check('可求值', false, '函数缺失');
  else {
    const { probeOpPresent } = new Function(s1 + NL + s2 + NL + '; return { probeOpPresent };')();
    const run = (fn) => probeOpPresent(fn, 'skillhub.evaluation').then((v) => v, (e) => 'THREW:' + e.message);
    const t1 = await run(async () => ({ ok: true }));
    check('成功响应 → true', t1 === true, String(t1));
    const t2 = await run(async () => { throw new Error('缺少 skill 标识'); });
    check('参数校验错 → true（说明 op 在）', t2 === true, String(t2));
    const t3 = await run(async () => { throw new Error('unknown operation "skillhub.evaluation"'); });
    check('unknown operation → false（op 不在）', t3 === false, String(t3));
  }
}

console.log('');
console.log('Test 4: 渲染门必须是 ===true，且不得用版本号冒充判别');
{
  const gate = countHits(client, "opStatus['skillhub.evaluation'] === true");
  check('质量入口受 opStatus===true 门控', gate >= 1, '命中 ' + gate);
  const fake = countHits(client, "opStatus['skillhub.evaluation'] !== false");
  check('不得用 !== false 假门（缺失时仍会画按钮）', fake === 0, '命中 ' + fake);
  check('boot 触发 probeOps', countHits(client, 'probeOps(') >= 1);
  check('判别不得写死版本号', /opStatus[\s\S]{0,80}0\.5\./.test(client) === false);
}

console.log('');
console.log('Test 5: 证伪——削弱判据后 op 会被误判存在（锁必须咬）');
{
  const s2 = grabFn('probeOpPresent');
  if (!s2) check('可证伪', false, '探测函数缺失');
  else {
    const mutant = 'const isUnknownOperation = () => false;';
    const { probeOpPresent } = new Function(mutant + NL + s2 + NL + '; return { probeOpPresent };')();
    const wrong = await probeOpPresent(async () => { throw new Error('unknown operation "x"'); }, 'x');
    check('判据被削弱 → 误判存在（证明 Test3 有效）', wrong === true, 'got ' + wrong);
  }
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
