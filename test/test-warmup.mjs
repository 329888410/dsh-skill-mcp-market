#!/usr/bin/env node
// test-warmup.mjs — clawhub 并行预热的行为契约。
//
// 契约来源（勿凭记忆改）：0.5.89 引入并行预热；0.5.91「honest pagination」把
// totalPages 改成「只有游标真正耗尽（done=true）才报精确值，无界流报 undefined」。
// clawhub browse 是 28k+ 的无界游标流，而 warmClawHubCatalog 的 budget 默认 1200，
// 循环条件 `!done && rows.length < budget` 决定 rows 上限 ≈ budget + 一页(50)，
// 且 done 恒为 false —— 因此 totalPages 恒为 undefined。
// 旧版本此套件断言 done===true / totalPages 为数字 / rows>2000，与上述三条互斥，
// 自 0.5.91 起恒红（约 18 个版本）。done=true 的精确页数路径由离线确定性的
// test-total-pages 锁定，本套件只锁「有界预算 + 无界流」这一真实形态。
//
// 不在 CI 门内：依赖 clawhub 实网，与 0.5.93 的 CI 可移植性教训一致。
import { searchClawHub, warmClawHubCatalog } from '../src/extra-sources.js';
import { makeCache } from '../src/sources.js';
import path from 'node:path';
import { safeTempDir } from '../src/home.js';

let passed = 0, failed = 0;
function check(name, cond, actual) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (actual === undefined ? '' : '  (actual: ' + actual + ')')); }
}
const newCache = (tag) => makeCache(path.join(safeTempDir(), 'dsh-warmup-' + tag + '-' + Date.now()));

console.log('');
console.log('Test 1: warmClawHubCatalog 返回结构稳定且有界');
{
  const cache = newCache('t1');
  const budget = 120;
  const result = await warmClawHubCatalog(cache, { budget });
  check('rows 是数组', Array.isArray(result.rows), typeof result.rows);
  check('done 是布尔', typeof result.done === 'boolean', typeof result.done);
  check('rows 达到预算量级', result.rows.length > 50, result.rows.length);
  check('rows 不超过 budget + 一页', result.rows.length <= budget + 50, result.rows.length);
}

console.log('');
console.log('Test 2: 0.5.91 诚实契约——有界预算下未耗尽游标时 totalPages 必须是 undefined');
{
  const cache = newCache('t2');
  const warm = await warmClawHubCatalog(cache, { budget: 120 });
  const r = await searchClawHub({ query: '', page: 1, pageSize: 24, cache });
  check('items 有内容', r.items.length === 24, r.items.length);
  check('hasMore 是布尔', typeof r.hasMore === 'boolean', typeof r.hasMore);
  if (warm.done === true) {
    // 极小目录/游标提前耗尽的分支：此时必须报精确页数（与 test-total-pages 同契约）
    check('done=true → totalPages 精确', r.totalPages === Math.ceil(warm.rows.length / 24), r.totalPages);
  } else {
    check('done=false → totalPages undefined（不谎报下界）', r.totalPages === undefined, r.totalPages);
    check('done=false → total undefined', r.total === undefined, r.total);
  }
}

console.log('');
console.log('Test 3: 预热结果被缓存复用（第二次不再从零开始）');
{
  const cache = newCache('t3');
  const a = await warmClawHubCatalog(cache, { budget: 120 });
  const b = await warmClawHubCatalog(cache, { budget: 120 });
  check('第二次不减少行数', b.rows.length >= a.rows.length, a.rows.length + '→' + b.rows.length);
  check('第二次不超预算上限', b.rows.length <= 120 + 50, b.rows.length);
}

console.log('');
console.log('Test 4: 预热在合理时间内完成（默认预算）');
{
  const cache = newCache('t4');
  const t0 = Date.now();
  const warm = await warmClawHubCatalog(cache);
  const elapsed = Math.round((Date.now() - t0) / 1000);
  check('默认预算下 < 10 分钟', elapsed < 600, elapsed + 's');
  check('默认预算 rows ≤ 1200+50', warm.rows.length <= 1250, warm.rows.length);
  console.log('  (actual: ' + elapsed + 's, rows=' + warm.rows.length + ', done=' + warm.done + ')');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
