#!/usr/bin/env node
// test-global-sort.mjs — TDD: 「按安装数」排序必须跨页全局单调，而不是每页内部各自排序。
// 症状（实测）：trusttools 第1页 max=55794，第2页 max=60406，页与页无序。
// 判据：把所有页拉回来拼成一个序列，整体必须非递增。
import { searchSkills, makeCache } from '../src/sources.js';
import os from 'node:os';
import path from 'node:path';

let passed = 0, failed = 0;
const check = (n, c, d = '') => { if (c) { passed++; console.log('  \u2713 ' + n); } else { failed++; console.log('  \u2717 ' + n + (d ? '  ' + d : '')); } };

const dir = path.join(os.tmpdir(), 'dsh-gs-' + Date.now());
const cache = makeCache(dir);

// 用 modelscope（有真实 installs 且响应快）验证跨页单调
const SOURCE = 'modelscope';
const SIZE = 24;
console.log('\nTest 1: 跨页全局降序（' + SOURCE + '）');
let prevMin = Infinity;
let collected = [];
let pages = 0;
for (let p = 1; p <= 3; p += 1) {
  const r = await searchSkills({ query: '', source: SOURCE, page: p, pageSize: SIZE, cache, sort: 'installCount' });
  const arr = r.items.map((i) => Number(i.installs) || 0);
  if (!arr.length) break;
  pages += 1;
  const pageMin = Math.min(...arr);
  const pageMax = Math.max(...arr);
  // 页内必须降序
  const within = arr.every((v, k) => k === 0 || arr[k - 1] >= v);
  check('page ' + p + ' 页内降序', within);
  // 跨页：本页最大值必须 <= 上页最小值
  if (prevMin !== Infinity) {
    check('page ' + p + ' 最大值(' + pageMax + ') <= 上页最小值(' + prevMin + ')', pageMax <= prevMin);
  }
  collected = collected.concat(arr);
  prevMin = pageMin;
}
check('至少取到 2 页', pages >= 2, 'got ' + pages);
const globalOk = collected.every((v, k) => k === 0 || collected[k - 1] >= v);
check('拼接后整体非递增', globalOk, collected.slice(0, 8).join(',') + ' ...');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
