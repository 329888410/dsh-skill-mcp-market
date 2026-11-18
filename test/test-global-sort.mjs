#!/usr/bin/env node
// test-global-sort.mjs — TDD: 「按安装数」排序必须跨页全局单调，而不是每页各自排序。
// 两条腿：
//   1) 确定性契约（始终跑）：用合成的有序全集验证「窗口 -> 排序 -> 切页」的切片契约。
//   2) 真实上游（可选）：能连上就验证真源；连不上跳过，绝不让 CI 因网络失败。
import { searchSkills, makeCache } from '../src/sources.js';
import os from 'node:os';
import path from 'node:path';

let passed = 0, failed = 0, skipped = 0;
const check = (n, c, d = '') => { if (c) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  ' + d : '')); } };
const skip = (n) => { skipped++; console.log('  SKIP ' + n); };

// ── 1) 确定性契约：切片必须来自同一份全局排序后的数组 ──
console.log('');
console.log('Test 1: 窗口 -> 全局排序 -> 切页 契约（合成数据）');
{
  const total = 500;
  const full = Array.from({ length: total }, (_, i) => ({ id: 'r' + i, installs: (i * 7919) % 100000 }));
  const sorted = [...full].sort((a, b) => b.installs - a.installs);
  const SIZE = 12;
  const slices = [];
  for (let p = 1; p <= 3; p += 1) slices.push(sorted.slice((p - 1) * SIZE, p * SIZE));
  check('每页来自同一全集', slices.every((s) => s.length === SIZE));
  const flat = slices.flat().map((x) => x.installs);
  check('拼接后整体非递增', flat.every((v, k) => k === 0 || flat[k - 1] >= v));
  check('页间无缝', [1, 2].every((p) => Math.max(...slices[p].map((x) => x.installs)) <= Math.min(...slices[p - 1].map((x) => x.installs))));
  check('无重复项', new Set(flat).size === flat.length);
}

// ── 2) 真实上游（可选，网络不可用则跳过） ──
console.log('');
console.log('Test 2: 真实上游跨页单调（连不上则跳过）');
{
  const dir = path.join(os.tmpdir(), 'dsh-gs-' + Date.now());
  const cache = makeCache(dir);
  const SOURCES = ['trusttools', 'skillhub', 'modelscope'];
  const SIZE = 12;
  for (const SOURCE of SOURCES) {
    let prevMin = Infinity, collected = [], pages = 0, hasData = false, errored = false;
    try {
      for (let pg = 1; pg <= 3; pg += 1) {
        const r = await searchSkills({ query: '', source: SOURCE, page: pg, pageSize: SIZE, cache, sort: 'installCount' });
        const arr = r.items.map((i) => Number(i.installs) || 0);
        if (!arr.length) break;
        pages += 1;
        if (arr.some((v) => v > 0)) hasData = true;
        check(SOURCE + ' p' + pg + ' 页内降序', arr.every((v, k) => k === 0 || arr[k - 1] >= v));
        if (prevMin !== Infinity) check(SOURCE + ' p' + pg + ' 跨页单调', Math.max(...arr) <= prevMin);
        collected = collected.concat(arr);
        prevMin = Math.min(...arr);
      }
    } catch (e) { errored = true; }
    if (errored || pages < 2) { skip(SOURCE + '（上游不可达或页数不足）'); continue; }
    if (hasData) check(SOURCE + ' 拼接后整体非递增', collected.every((v, k) => k === 0 || collected[k - 1] >= v));
  }
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
process.exit(failed ? 1 : 0);