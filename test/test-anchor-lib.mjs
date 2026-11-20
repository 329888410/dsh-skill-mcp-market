#!/usr/bin/env node
// test-anchor-lib.mjs — 锚定位库的契约测试。
//
// 这个库存在的理由是一次真实的核验误报：0.5.129 那轮我用裸 indexOf 核验交付物，
// 锚串「退出选择」在 client.js 里命中 2 次，且第一次出现在窗口起点之前，slice 得到
// 空串，于是核验报 FALSE —— 而实现其实是完整的。「核验脚本自己出错」比实现出错更危险：
// 它给出的结论看起来是实测。所以这里用证伪用例锁死：非唯一锚必须 throw，绝不返回
// 一个可能是空窗口的结果。
import { countHits, once, lineOf, sliceBetween } from './anchor-lib.mjs';

let passed = 0, failed = 0;
const check = (n, cond, d) => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 150) + ']' : '')); } };

console.log('Test 1: countHits');
check('0 命中', countHits('abc', 'zzz') === 0);
check('1 命中', countHits('abc', 'bc') === 1);
check('3 命中', countHits('aaa', 'a') === 3, countHits('aaa', 'a'));
{
  // 死循环回归锁：空 needle 在 V8 会让 indexOf 钳位、循环永不退出。
  // 曾经真的把这一轮挂到超时，所以它必须是显式 throw 而不是静默返回某个数。
  let threw = '';
  try { countHits('ab', ''); } catch (err) { threw = String(err.message); }
  check('空 needle 必须 throw（防死循环）', threw.length > 0 && /空/.test(threw), threw.slice(0, 70));
}

console.log('Test 2: once 命中数判定（证伪核心）');
check('唯一锚返回位置', once('hello world', 'world') === 6);
{
  let threw = '';
  try { once('hello world hello', 'hello'); } catch (e) { threw = String(e.message); }
  check('多命中必须 throw（非唯一即歧义）', threw.length > 0, JSON.stringify(threw.slice(0, 60)));
  check('throw 信息含命中次数', /命中 2 次/.test(threw), threw.slice(0, 80));
}
{
  let threw = '';
  try { once('abc', 'zzz'); } catch (e) { threw = String(e.message); }
  check('0 命中必须 throw（锚已失效）', threw.length > 0 && /命中 0 次/.test(threw), threw.slice(0, 80));
}
check('throw 信息含 label', (() => { try { once('a b a', 'a', '我的锚'); return false; } catch (e) { return /我的锚/.test(e.message); } })());

console.log('Test 3: lineOf');
{
  const src = ['first line', '  second with needle', 'third'].join(String.fromCharCode(10));
  const i = once(src, 'needle');
  check('取到整行而非片段', lineOf(src, i).includes('second') && lineOf(src, i).includes('needle') && !lineOf(src, i).includes('third'), JSON.stringify(lineOf(src, i)));
  check('末行无换行也不炸', lineOf('abc' + String.fromCharCode(10) + 'xyz', 4).trim() === 'xyz');
}

console.log('Test 4: sliceBetween 区间（防 0.5.129 空窗口）');
{
  const src = 'AAAA target1 MMMMM target2 ZZZZ';
  // 区间语义 = [起锚起点, 尾锚起点)：含起锚文本、不含尾锚文本。
  // 这是 0.5.129 当年正确核验用的形态（slice(条起, 条尾)），在此锁死而不是靠记忆。
  check('区间含起锚、不含尾锚', sliceBetween(src, 'target1', 'target2') === 'target1 MMMMM ', JSON.stringify(sliceBetween(src, 'target1', 'target2')));
  check('区间非空且长度正常', sliceBetween(src, 'target1', 'target2').length > 0);
  let threw = '';
  try { sliceBetween(src, 'target2', 'target1'); } catch (e) { threw = String(e.message); }
  // 关键证伪：尾锚早于起锚时，裸 indexOf 会给负长度 → 空串 → 核验误报 FALSE
  check('锚顺序颠倒必须 throw（不得给空窗口）', threw.length > 0 && /顺序颠倒/.test(threw), threw.slice(0, 70));
  let threw2 = '';
  try { sliceBetween(src + ' target1', 'target1', 'target2'); } catch (e) { threw2 = String(e.message); }
  check('起锚不唯一也 throw', /命中 2 次/.test(threw2), threw2.slice(0, 70));
}

console.log('Test 5: 对真实 client.js 复现当年误报（回归锁）');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const W = path.resolve(import.meta.dirname, '..');
  const c = fs.readFileSync(path.join(W, 'client.js'), 'utf8');
  // 「退出选择」正是当年那个多命中锚：它命中 2 次，所以 once 必须拒绝它。
  const bare = '退出选择';
  const hits = countHits(c, bare);
  check('已知多命中锚仍 >1（场景成立）', hits > 1, '命中 ' + hits + ' 次');
  let threw = '';
  try { once(c, bare, '裸退出选择'); } catch (e) { threw = String(e.message); }
  check('裸锚被 once 拒绝', /命中/.test(threw), threw.slice(0, 70));
  // 唯一闭锚必须可用（这就是核验脚本该用的形态）
  const SQ = String.fromCharCode(39);
  const uniq = 'onClick: exitBatch }, ' + SQ + bare + SQ + '))';
  check('唯一闭锚命中 1 次', countHits(c, uniq) === 1, countHits(c, uniq));
  check('唯一闭锚可定位', once(c, uniq, '批量条尾') > 0);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);