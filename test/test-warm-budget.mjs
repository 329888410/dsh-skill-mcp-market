#!/usr/bin/env node
// test-warm-budget.mjs — TDD: clawhub 预热必须有行数预算，不能对着 28k+ 的无限 cursor 流一直爬。
// 症状：catalogue 已 28800 条仍 done=false，warm-up 永不终止 → 内存与 API 无界增长。
import { warmClawHubCatalog } from '../src/extra-sources.js';
import { makeCache } from '../src/sources.js';
import path from 'node:path';
import { safeTempDir } from '../src/home.js';

let passed = 0, failed = 0, skipped = 0;
const check = (n, c, d = '') => { if (c) { passed++; console.log('  \u2713 ' + n); } else { failed++; console.log('  \u2717 ' + n + (d ? '  ' + d : '')); } };
const skip = (n, d = '') => { skipped++; console.log('  SKIP ' + n + (d ? '  [' + String(d).slice(0, 70) + ']' : '')); };

console.log('\nTest 1: warmClawHubCatalog respects a row budget and terminates');
{
  const dir = path.join(safeTempDir(), 'dsh-wb-' + Date.now());
  const cache = makeCache(dir);
  const t0 = Date.now();
  const r = await warmClawHubCatalog(cache, { budget: 300 });
  const elapsed = Math.round((Date.now() - t0) / 1000);
  check('returns rows array', Array.isArray(r.rows));
  // warmClawHubCatalog 内部吞掉上游错误（连续 3 次失败即停），上游不可达时 rows=0。
  // 那是上游侧状态，不是预算逻辑回归 —— 必须 SKIP，否则 CI（GitHub 出口 IP 常被 clawhub
  // CDN 限流/TLS 指纹拒绝）无条件红。2026-11-19 的 0.5.109 CI 失败根因即此类。
  // rows=0 有两种：done=false = 连续 3 次错误被吞（不可达，SKIP）；
  // done=true = 上游正常应答但首批即空（真数据症状，必须 FAIL，不能掩盖）。
  if (!r.rows.length && !r.done) {
    skip('clawhub 不可达（rows=0 且 done=false），预算与耗时断言无从判定');
  } else {
    check('rows <= budget + slack (300..360)', r.rows.length >= 200 && r.rows.length <= 360, 'got ' + r.rows.length);
    check('terminates in < 120s', elapsed < 120, 'took ' + elapsed + 's');
  }
  console.log('  (rows=' + r.rows.length + ', ' + elapsed + 's)');
}

console.log('\nTest 2: default budget is finite (not 99999 / not infinite)');
{
  const dir = path.join(safeTempDir(), 'dsh-wb2-' + Date.now());
  const cache = makeCache(dir);
  const t0 = Date.now();
  const r = await warmClawHubCatalog(cache);
  const elapsed = Math.round((Date.now() - t0) / 1000);
  // 上限断言（rows <= 2200）在 rows=0 时仍成立，可保留；耗时断言在无数据时只是网络耗时，无意义。
  check('default rows <= 2200', r.rows.length <= 2200, 'got ' + r.rows.length);
  if (!r.rows.length && !r.done) skip('clawhub 不可达（rows=0 且 done=false），默认预算耗时不判');
  else check('default run terminates in < 300s', elapsed < 300, 'took ' + elapsed + 's');
  console.log('  (rows=' + r.rows.length + ', ' + elapsed + 's, done=' + r.done + ')');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
process.exit(failed ? 1 : 0);
