#!/usr/bin/env node
// test-sort-honesty.mjs — TDD: 排序必须诚实且与展示同源。
// 症状1：skills.sh 卡片硬编码 installs:0，按「安装数」排序把它打乱成无序（假排序）。
// 症状2：排序键与卡片显示的字段不同源，导致「排了但看起来没排」。
import { makeCache, searchSkills, supportsSort, sortKeyOf } from '../src/sources.js';
import os from 'node:os';
import path from 'node:path';

let passed = 0, failed = 0, skipped = 0;
const check = (n, c, d = '') => { if (c) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  ' + d : '')); } };

console.log('');
console.log('Test 1: 没有安装数据的源必须声明不支持按安装数排序');
{
  check('skills.sh does NOT support installCount', supportsSort('skills.sh', 'installCount') === false);
  check('skills.sh supports name', supportsSort('skills.sh', 'name') === true);
  check('trusttools supports installCount', supportsSort('trusttools', 'installCount') === true);
  check('modelscope supports installCount', supportsSort('modelscope', 'installCount') === true);
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

const dir = path.join(os.tmpdir(), 'dsh-sh-' + Date.now());
const cache = makeCache(dir);

console.log('');
console.log('Test 3: skills.sh 按安装数排序时不得打乱上游顺序（连不上则跳过）');
{
  let a, b, errored = false;
  try {
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