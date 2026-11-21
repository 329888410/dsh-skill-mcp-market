#!/usr/bin/env node
// test-paging-deterministic.mjs — 聚合层分页契约的确定性测试（全部注入 handler，零网络）。
//
// 为什么要这个套件（用户 2026-11-22 指出）：test-paging 把断言绑在真实上游上，
// trusttools 一超时它就『门里红、单跑绿』——这种门禁既制造假红，也会掩盖下一次
// 真回归。真实上游可达性应归为信息性探针，契约本身必须能用注入的 handler 复现。
// 定位过程中探针抓到一个真代码缺陷（同一提交修掉）：整源失败时聚合层报 pages=1
// —— 一次抓取失败宣称『目录只有 1 页』；而同一视图 p2 成功时又报 pages=undefined，
// 一个情况两种口径。
import { makeCache, searchSkills } from '../src/sources.js';
import { safeTempDir } from '../src/home.js';
import fs from 'node:fs';
import path from 'node:path';

let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  ' + String(d).slice(0, 140) : '')); } };
const dir = fs.mkdtempSync(path.join(safeTempDir(), 'pdet-'));
const cache = makeCache(dir);
const rows = (p, n) => Array.from({ length: n || 12 }, (u, i) => ({ id: 'x' + p + '-' + i, slug: 'x' + p + '-' + i, name: 'x' + p + '-' + i }));

console.log('');
console.log('Test 1: 单源整取失败（degraded）→ pages/total/hasMore 必须都是未知');
{
  const h = { flaky: async () => { throw new Error('上游超时'); } };
  const r = await searchSkills({ query: '', source: 'flaky', page: 1, pageSize: 12, cache, handlers: h, budgetMs: 3000 });
  console.log('   形态: items=' + r.items.length + ' total=' + String(r.total) + ' pages=' + String(r.pages) + ' hasMore=' + String(r.hasMore) + ' degraded=' + (r.degraded || []).length);
  check('条目为空', r.items.length === 0);
  check('degraded 记录了这次失败', (r.degraded || []).length === 1);
  check('pages 未知：一次失败不得谎称「共 1 页」', r.pages === undefined, 'got ' + String(r.pages));
  check('total 未知：失败不等于空目录', r.total === undefined, 'got ' + String(r.total));
  check('hasMore 未知：不得宣称已到底', r.hasMore === undefined, 'got ' + String(r.hasMore));
}

console.log('');
console.log('Test 2: p1 失败 p2 有货（门内实测的 trusttools 形态）→ 同一视图口径必须一致');
{
  const h = { flaky: async (o) => { if (o.page === 1) throw new Error('上游超时'); return { items: rows(2), total: undefined, hasMore: true }; } };
  const p1 = await searchSkills({ query: '', source: 'flaky', page: 1, pageSize: 12, cache, handlers: h, budgetMs: 3000 });
  const p2 = await searchSkills({ query: '', source: 'flaky', page: 2, pageSize: 12, cache, handlers: h, budgetMs: 3000 });
  console.log('   p1.pages=' + String(p1.pages) + ' | p2.items=' + p2.items.length + ' p2.pages=' + String(p2.pages));
  check('两页 pages 同口径（不得 1 对 undefined）', p1.pages === p2.pages, String(p1.pages) + ' vs ' + String(p2.pages));
  check('p2 正常返回条目（未知不代表取数坏）', p2.items.length === 12);
}

console.log('');
console.log('Test 3: 反向边界——取数成功时必须照报数字（未知不得吞掉一切）');
{
  const h = { ok: async (o) => ({ items: rows(o.page), total: 96, hasMore: o.page * 12 < 96 }) };
  const r = await searchSkills({ query: '', source: 'ok', page: 1, pageSize: 12, cache, handlers: h, budgetMs: 3000 });
  check('pages 是数字且等于 ceil(96/12)', typeof r.pages === 'number' && r.pages === 8, String(r.pages));
  check('total 如实', r.total === 96, String(r.total));
  check('hasMore 如实', r.hasMore === true, String(r.hasMore));
}

console.log('');
console.log('Test 4: 多源聚合部分失败 → 保留现行口径（好的源照报，坏的列进 degraded）');
{
  const h = {
    good: async (o) => ({ items: rows(o.page), total: 48, hasMore: o.page * 12 < 48 }),
    bad: async () => { throw new Error('上游超时'); },
  };
  const r = await searchSkills({ query: '', source: 'all', page: 1, pageSize: 12, cache, handlers: h, budgetMs: 3000 });
  check('成功源的条目仍在', r.items.length === 12, String(r.items.length));
  check('degraded 列出坏源', (r.degraded || []).some((d) => d.source === 'bad'), JSON.stringify((r.degraded || []).map((d) => d.source)));
  check('聚合 pages 仍为数字（既有聚合语义不变）', typeof r.pages === 'number', String(r.pages));
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
