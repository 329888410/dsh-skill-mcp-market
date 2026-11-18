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

// 所有有真实 installs 的源都必须跨页全局单调
const SOURCES = ['trusttools', 'skillhub', 'modelscope'];
const SIZE = 12;
for (const SOURCE of SOURCES) {
  console.log('\nTest: 跨页全局降序（' + SOURCE + '）');
  let prevMin = Infinity;
  let collected = [];
  let pages = 0;
  let hasData = false;
  for (let p = 1; p <= 3; p += 1) {
    const r = await searchSkills({ query: '', source: SOURCE, page: p, pageSize: SIZE, cache, sort: 'installCount' });
    const arr = r.items.map((i) => Number(i.installs) || 0);
    if (!arr.length) break;
    pages += 1;
    if (arr.some((v) => v > 0)) hasData = true;
    const within = arr.every((v, k) => k === 0 || arr[k - 1] >= v);
    check(SOURCE + ' page ' + p + ' 页内降序', within);
    if (prevMin !== Infinity) {
      check(SOURCE + ' page ' + p + ' 跨页单调 (max ' + Math.max(...arr) + ' <= 上页min ' + prevMin + ')', Math.max(...arr) <= prevMin);
    }
    collected = collected.concat(arr);
    prevMin = Math.min(...arr);
  }
  check(SOURCE + ' 至少 2 页', pages >= 2, 'got ' + pages);
  if (hasData) {
    const globalOk = collected.every((v, k) => k === 0 || collected[k - 1] >= v);
    check(SOURCE + ' 拼接后整体非递增', globalOk);
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
