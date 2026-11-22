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

console.log('');
console.log('Test 5: skills.sh 搜索的 total 只能来自证据，不能来自页码');
{
  // 实测 2026-11-22：skills.sh /api/search 的 count 恒等于本次返回行数
  // （limit=10/24/30/60 → count=10/24/30/60），且单次硬顶 200
  // （q=test/code/pdf 在 limit=500 下也回 200 行；q=agent 回 144 行）。
  // 旧实现把这两个数当总数：同一个 q=agent 翻到第 8 页时报「共约 312 个」。
  const capSrc = fs.readFileSync(new URL('../src/sources.js', import.meta.url), 'utf8');
  const capHit = /const SKILLS_SH_WINDOW_CAP = (\d+)/.exec(capSrc);
  check('窗口顶常量存在（拿掉它这条修复就失去依据）', capHit !== null);
  const CAP = capHit ? Number(capHit[1]) : -1;
  check('窗口顶等于实测的 200', CAP === 200, 'got ' + CAP);
  check('count 不再参与总数（Math.max(Number(data.count) 已消失）',
    !capSrc.includes('Math.max(Number(data.count)'), '仍有 count 参与 total 的算式');
  check('页码反推算式已从 skills.sh 段消失',
    !capSrc.includes('(p - 1) * size + rows.length'), '仍用 (p-1)*size+rows.length');

  const mkRows = (n) => Array.from({ length: n }, (u, i) => ({
    id: 'r' + i, skillId: 'r' + i, name: 'r' + i, source: 'acme/skills', installs: 5000 - i,
  }));
  let upstreamRows = 0;
  const asked = [];
  const realFetch = globalThis.fetch;
  try {
    // 只替 skills.sh 搜索接口；描述补全走 jsdelivr/raw，一律 404（权威缺失，不产生等待）。
    globalThis.fetch = async (url) => {
      const u = String(url);
      const m = /www\.skills\.sh\/api\/search\?q=([^&]*)&limit=(\d+)/.exec(u);
      if (!m) return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
      const want = Number(m[2]);
      asked.push(want);
      const n = Math.min(want, upstreamRows);
      const body = JSON.stringify({ skills: mkRows(n), count: n });
      return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
    };
    const run = async (q, page, rows) => {
      upstreamRows = rows;
      asked.length = 0;
      const r = await searchSkills({ query: q, source: 'skills.sh', page, pageSize: 24, cache, budgetMs: 5000 });
      return { r, limit: asked[0] };
    };
    // ① 窗口内见底：第 2 页要 49 条只给 30 条 ⇒ 30 就是精确总数，且没有第 3 页。
    {
      const a = await run('leadcase1', 1, 30);
      check('请求窗口多要一条作探针（24→25）', a.limit === 25, 'limit=' + a.limit);
      // 第 1 页探针到手：上游确实还有第 25 条。此时报 24 就是我们要修的谎报，
      // 报 30 同样是猜（这一页并不知道上游只有 30 条）。唯一诚实的形态是未知+有下一页。
      check('探针那条到手 ⇒ 第 1 页只能说还有下一页', a.r.hasMore === true, String(a.r.hasMore));
      check('第 1 页不许报 24（上游其实有 30 条）', a.r.total === undefined, 'total=' + a.r.total);
      const b = await run('leadcase1', 2, 30);
      check('同一集合换页总数不变', b.r.total === 30, 'total=' + b.r.total);
      check('第二页只给剩下的 6 条', b.r.items.length === 6, 'items=' + b.r.items.length);
    }
    // ② 恰好 size*p 条：旧实现按 rows>=depth 认定还有下一页并报 depth+1。
    {
      const a = await run('leadcase2', 6, 144);
      check('探针那条取不到 ⇒ 总数就是 144（不是 145）', a.r.total === 144, 'total=' + a.r.total);
      check('第 6 页是最后一页', a.r.hasMore === false, String(a.r.hasMore));
    }
    // ③ 还有更多：上游没有总数 ⇒ 只能报未知，绝不能报 size*p+1。
    {
      const a = await run('leadcase3', 2, 1000);
      check('有下一页时 total 未知（不报 49）', a.r.total === undefined, 'total=' + a.r.total);
      check('有下一页时 hasMore 为真', a.r.hasMore === true, String(a.r.hasMore));
      const b = await run('leadcase3', 8, 1000);
      check('深翻页仍不报数（不报 312）', b.r.total === undefined, 'total=' + b.r.total);
    }
    // ④ 撞上游硬顶：取不到更多，也数不清，必须写明原因。
    {
      const a = await run('leadcase4', 9, 5000);
      check('撞顶时 total 未知（不报 201）', a.r.total === undefined, 'total=' + a.r.total);
      check('撞顶时不再许诺下一页', a.r.hasMore === false, String(a.r.hasMore));
      // 聚合层收集为 hints 数组（src/sources.js:742，client.js:815/:845 读复数），单数 hint 只存在于单源返回。
      check('撞顶把原因写进 hints（聚合层字段名是复数）',
        Array.isArray(a.r.hints) && a.r.hints.some((h) => String(h).includes(String(CAP))), JSON.stringify(a.r.hints));
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
