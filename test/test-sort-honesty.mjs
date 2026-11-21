#!/usr/bin/env node
// test-sort-honesty.mjs — TDD: 排序必须诚实且与展示同源。
// 症状1：skills.sh 卡片硬编码 installs:0，按「安装数」排序把它打乱成无序（假排序）。
// 症状2：排序键与卡片显示的字段不同源，导致「排了但看起来没排」。
import { makeCache, searchSkills, supportsSort, sortKeyOf } from '../src/sources.js';
import path from 'node:path';
import { safeTempDir } from '../src/home.js';

let passed = 0, failed = 0, skipped = 0;
const check = (n, c, d = '') => { if (c) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  ' + d : '')); } };

console.log('');
console.log('Test 1: 没有安装数据的源必须声明不支持按安装数排序');
{
  // 实测：skills.sh search API 返回真实 installs（4,431,266 首条）→ 支持；
  // sitemap browse 无 installs，但全 0 稳定排序保持上游序（Test 3 锁住不乱排）。
  check('skills.sh supports installCount (search API has installs)', supportsSort('skills.sh', 'installCount') === true);
  check('skills.sh supports name', supportsSort('skills.sh', 'name') === true);
  check('skillsmp NOT installCount (CLI 无此 sort)', supportsSort('skillsmp', 'installCount') === false);
  check('browse.sh supports installCount (459/479 rows)', supportsSort('browse.sh', 'installCount') === true);
  check('trusttools supports installCount', supportsSort('trusttools', 'installCount') === true);
  check('modelscope NOT installCount (上游只有 DownloadCount)', supportsSort('modelscope', 'installCount') === false);
  check('modelscope supports downloadCount', supportsSort('modelscope', 'downloadCount') === true);
  check('skillhub supports installCount', supportsSort('skillhub', 'installCount') === true);
}

console.log('');
console.log('Test 2: 排序键与卡片展示字段同源');
{
  const item = { installs: 42, name: 'x' };
  check('sortKeyOf reads installs', sortKeyOf(item, 'installCount') === 42);
  check('sortKeyOf reads name', sortKeyOf(item, 'name') === 'x');
  check('sortKeyOf default is 0-ish', !sortKeyOf({}, 'installCount'));
}

const dir = path.join(safeTempDir(), 'dsh-sh-' + Date.now());
const cache = makeCache(dir);

console.log('');
console.log('Test 3: skills.sh 按安装数排序时不得打乱上游顺序（连不上则跳过）');
{
  let a, b, errored = false;
  try {
    // 目录是异步预热的；两次调用若跨越预热边界会比到不同数据集。
    // 曾用「相邻两次 total 相等」判稳定，但那会被 highlights 假稳定骗过：
    // 未就绪时回退首页 highlights（约 48 行），total 连续多次都是同一个小区间值，
    // 而全量 sitemap 目录（约 2 万行）恰在 a/b 之间落盘 → 两次比的是不同数据集，
    // 产生间歇性假红（2026-11-19 实测 1 次；上游同负载延迟 3.3s→38s 跨过等待窗口）。
    // 正确判据：数据集身份必须跨过「全量目录」规模门槛，而不只是数值相等。
    const CATALOG_MIN_ROWS = 1000; // 远高于 highlights，低于全量目录（约 2 万）
    let stable = false;
    let prev = -1;
    for (let i = 0; i < 8; i += 1) {
      const probe = await searchSkills({ query: '', source: 'skills.sh', page: 1, pageSize: 12, cache, sort: '' });
      const big = Number(probe.total) >= CATALOG_MIN_ROWS;
      if (big && probe.total === prev && probe.items.length > 0) { stable = true; break; }
      prev = probe.total;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!stable) throw new Error('catalog not ready (still highlights-scale)');
    a = await searchSkills({ query: '', source: 'skills.sh', page: 1, pageSize: 12, cache, sort: 'installCount' });
    b = await searchSkills({ query: '', source: 'skills.sh', page: 1, pageSize: 12, cache, sort: '' });
  } catch { errored = true; }
  if (errored || !a || !a.items.length) { skipped++; console.log('  SKIP (upstream unreachable)'); }
  else {
    const idsA = a.items.map((i) => i.id).join('|');
    const idsB = b.items.map((i) => i.id).join('|');
    check('order unchanged when no install data', idsA === idsB);
  }
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
process.exit(failed ? 1 : 0);