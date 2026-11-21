#!/usr/bin/env node
// test-paging-verdict.mjs — 分页判据纯函数真值表（零网络）。
//
// test-nocache 直打真实上游，SKIP/重试分支没法靠上游恰好坏一次来验证 —— 那等于
// 没有锁。判定抽成纯函数后每条边界都能钉死，尤其「放宽绝不放行真回归」。
import { overlapVerdict, emptyPageAction } from './paging-verdict.mjs';
import fs from 'node:fs';

let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  ' + String(d).slice(0, 120) : '')); } };
const v = (o) => overlapVerdict(o).verdict;
const SRC = fs.readFileSync(new URL('./paging-verdict.mjs', import.meta.url), 'utf8');

console.log('');
console.log('Test 1: overlapVerdict 无重叠即 ok');
check('overlap 零 → ok', v({ source: 'skillhub', overlap: 0, pageCount: 12, sortedOverlap: 99 }) === 'ok');
check('与 sortedOverlap 无关', v({ source: 'trusttools', overlap: 0, pageCount: 12, sortedOverlap: 5 }) === 'ok');

console.log('');
console.log('Test 2: 整页重复永远 fail（page 参数被忽略）');
check('skillhub 整页重复 → fail', v({ source: 'skillhub', overlap: 12, pageCount: 12, sortedOverlap: 0 }) === 'fail');
check('其它源整页重复 → fail', v({ source: 'clawhub', overlap: 12, pageCount: 12, sortedOverlap: 0 }) === 'fail');
check('理由提到 page 参数', overlapVerdict({ source: 'skillhub', overlap: 12, pageCount: 12 }).reason.indexOf('page') >= 0);

console.log('');
console.log('Test 3: skillhub 部分重叠是放宽的唯一口子');
check('显式排序干净 → skip', v({ source: 'skillhub', overlap: 7, pageCount: 12, sortedOverlap: 0 }) === 'skip');
check('显式排序也重复 → fail（绝不放宽）', v({ source: 'skillhub', overlap: 2, pageCount: 12, sortedOverlap: 3 }) === 'fail');
check('sortedOverlap 缺失 → fail（不得当成 0 放行）', v({ source: 'skillhub', overlap: 7, pageCount: 12 }) === 'fail');
check('其它源部分重叠不得蹭口子 → fail', v({ source: 'clawhub', overlap: 3, pageCount: 12, sortedOverlap: 0 }) === 'fail');
check('同 overlap 下 sortedOverlap 决定结论', v({ source: 'skillhub', overlap: 7, pageCount: 12, sortedOverlap: 0 }) !== v({ source: 'skillhub', overlap: 7, pageCount: 12, sortedOverlap: 4 }));

console.log('');
console.log('Test 4: emptyPageAction 空第 2 页（重试一次，仍空必须红）');
const ep = (o) => emptyPageAction(o).verdict;
check('第 2 页有条目 → ok', ep({ p1: 12, p2: 12, total: 579074, hasMore: true, attempt: 1 }) === 'ok');
check('第 1 页就空 → fail（不是重试能解决的）', ep({ p1: 0, p2: 0, total: 0, hasMore: false, attempt: 1 }) === 'fail');
check('total 说还有更多且首次 → retry', ep({ p1: 12, p2: 0, total: 579074, hasMore: true, attempt: 1 }) === 'retry');
check('重试后仍空 → fail（分页回归，绝不静默放行）', ep({ p1: 12, p2: 0, total: 579074, hasMore: true, attempt: 2 }) === 'fail');
check('本就没有第 2 页 → ok 不重试', ep({ p1: 5, p2: 0, total: 5, hasMore: false, attempt: 1 }) === 'ok');
check('hasMore 为真也属于必须有第 2 页', ep({ p1: 12, p2: 0, total: 0, hasMore: true, attempt: 2 }) === 'fail');
check('fail 理由提到 offset/page 语义', emptyPageAction({ p1: 12, p2: 0, total: 99, hasMore: true, attempt: 2 }).reason.length > 4);

console.log('');
console.log('Test 5: 判据必须来自 helper（不是测试里另写一份）');
{
  // 真值表依赖的实现只有一份：helper 模块。若哪天测试改回内联判定，
  // 上游恰好不坏就没人验证过 SKIP —— 这条锁住 helper 里确实有两个导出。
  check('helper 导出 overlapVerdict', SRC.indexOf('export function overlapVerdict(') >= 0);
  check('helper 导出 emptyPageAction', SRC.indexOf('export function emptyPageAction(') >= 0);
  // 且 test-nocache 必须真的 import 并使用它们
  const nc = fs.readFileSync(new URL('./test-nocache.mjs', import.meta.url), 'utf8');
  check('test-nocache 使用 overlapVerdict', nc.indexOf('overlapVerdict(') >= 0);
  check('test-nocache 使用 emptyPageAction', nc.indexOf('emptyPageAction(') >= 0);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
