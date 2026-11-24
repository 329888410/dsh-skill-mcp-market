#!/usr/bin/env node
// test-sort-server.mjs — TDD: 「矩阵声称支持」必须等于「线路真的生效」。
//
// 锁三处服务端排序缺陷（事实源 src/sort-capability.js 的 CAPABILITIES，本测试不改它）：
//   缺陷1 lobehub skills：:429 把矩阵键原样透传给 @lobehub/market-cli，而上游 skills 词表是
//         createdAt|stars|installCount|name|relevance|ratingAverage|commentCount|updatedAt。
//         实测 newest/updated → exit 1 "Search failed: Bad Request" → sources.js catch 进 degraded
//         → 贡献 0 条（整个源消失，不是「没排序」）。trending 同样不在词表。
//   缺陷2 modelscope：sortMode 只认 installCount/name，stars/newest/updated 落到单页分支 →
//         只对一页排序，翻页顺序跨页错乱；矩阵 :31 却声称 5 个键全支持。
//   缺陷3 clawhub search：URL 不带 sort，sortRawRows 只给 installCount/name 两个 getter →
//         stars/newest/updated/trending 静默不排（sortRawRows 的 !g 分支原样返回上游序）。
//
// 全部断言离线可跑；需要实网/实 CLI 的部分用 DSH_LIVE_SORT=1 显式开启，默认 SKIP（CI 不红）。
import fs from 'node:fs';
import path from 'node:path';
import { safeTempDir } from '../src/home.js';

let passed = 0, failed = 0, skipped = 0;
const check = (n, c, d = '') => { if (c) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + d + ']' : '')); } };
const skip = (n) => { skipped++; console.log('  SKIP ' + n); };

const W = path.resolve(import.meta.dirname, '..');
const es = await import('../src/extra-sources.js');
const srcText = fs.readFileSync(path.join(W, 'src/extra-sources.js'), 'utf8');

// 上游 skills CLI --sort 词表（实测：newest/updated/trending 不在表内 → exit1 Bad Request）。
const LOBEHUB_SKILLS_VOCAB = ["createdAt", "updatedAt", "stars", "installCount", "name", "relevance", "ratingAverage", "commentCount"];
// 矩阵对 lobehub / modelscope / clawhub 的声称（sort-capability.js:25,29,31）。
const MATRIX = {
  lobehub: ["installCount", "stars", "newest", "updated", "name"],
modelscope: ["downloadCount", "stars", "newest", "updated", "name"],
clawhub: ["downloadCount", "stars", "newest", "updated", "trending", "name"],
};

console.log('');
console.log('Test 1: 缺陷1 — lobehub skills 透传给 CLI 的键必须落在上游词表内');
{
  const fn = es.lobehubSkillSortArg;
  check('导出 lobehubSkillSortArg（矩阵键→上游键）', typeof fn === 'function');
  if (typeof fn === 'function') {
    const bad = [];
    for (const key of MATRIX.lobehub) {
      const arg = fn(key);
      if (!LOBEHUB_SKILLS_VOCAB.includes(arg)) bad.push(key + '->' + JSON.stringify(arg));
    }
    check('矩阵 5 键映射后全在词表内', bad.length === 0, bad.join(' '));
    check('newest 映射 createdAt（原来原样透传 → exit1）', fn('newest') === 'createdAt', String(fn('newest')));
    check('updated 映射 updatedAt（原来原样透传 → exit1）', fn('updated') === 'updatedAt', String(fn('updated')));
    check('installCount/stars/name 原样（实测 exit0）', fn('installCount') === 'installCount' && fn('stars') === 'stars' && fn('name') === 'name');
    // 不在词表的键必须不透传（保持上游默认序），否则整源消失。
    check('trending 不透传（词表外→空）', fn('trending') === '', JSON.stringify(fn('trending')));
    check('空/未知键返回空', fn('') === '' && fn('relevanceX') === '');
  }
  // 结构性锁：CLI 参数行只能用映射后的值，不得再出现 sortKey 原样透传。
  const seg = srcText.slice(srcText.indexOf('export async function searchLobeHubSkills'));
  const call = seg.slice(0, seg.indexOf('--output'));
  check('searchLobeHubSkills 不再 `--sort`, sortKey 原样透传', !/--sort\",\s*sortKey/.test(call.replace(/\s+/g, '')) && !/push("--sort", sortKey)/.test(call), call.match(/--sort[^;]*/)?.[0]?.trim() || '');
  check('CLI --sort 取映射值', /LOBEHUB_SKILLSORT|lobehubSkillSortArg|sortArg/.test(call));
}

console.log('');
console.log('Test 2: 缺陷1 — lobehub 本地兜底 getter 必须覆盖映射后的键，且不得是死代码');
{
  const getters = es.LOBEHUB_SKILL_SORT_GETTERS;
  check('导出 LOBEHUB_SKILL_SORT_GETTERS', getters && typeof getters === 'object');
  if (getters) {
    // 兜底按上游键取（CLI 收到的就是这个键），映射后 newest/updated 才不再悬空。
    check('createdAt 兜底存在（原 newest getter 是死代码）', typeof getters.createdAt === 'function');
    check('updatedAt 兜底存在（原 updated getter 是死代码）', typeof getters.updatedAt === 'function');
    check('installCount/stars/name 兜底存在', ['installCount', 'stars', 'name'].every((k) => typeof getters[k] === 'function'));
    // 实测行内没有 stars 字段（只有 ratingAvg/ratingCount/commentCount）→ 兜底必须用真实字段。
    const row = { identifier: 'a', name: 'A', installCount: 10, ratingCount: 3, ratingAvg: 4.5, createdAt: '03/05/2026 21:35:29', updatedAt: '11/16/2026 21:35:29', stars: undefined };
    check('stars 兜底不用恒空的 r.stars', Number(getters.stars(row)) === 3, String(getters.stars(row)));
    const applies = es.lobehubSkillLocalSortApplies;
    if (typeof applies === 'function') {
      const dead = MATRIX.lobehub.filter((k) => !applies(k));
      check('5 个矩阵键都进入兜底窗口（:415 sortMode 不再挡 newest/updated/stars）', dead.length === 0, dead.join(','));
    } else skip('lobehubSkillLocalSortApplies 未导出');
  }
}

console.log('');
console.log('Test 3: 缺陷2 — modelscope 5 个矩阵键必须都走全量拉取分支');
{
  const fn = es.modelScopeSortMode;
  check('导出 modelScopeSortMode', typeof fn === 'function');
  if (typeof fn === 'function') {
    const off = MATRIX.modelscope.filter((k) => fn(k) !== true);
    check('installCount/stars/newest/updated/name 全为 sortMode=true', off.length === 0, 'still single-page: ' + off.join(','));
    check('空/default/trending 保持上游分页（不乱排）', fn('') === false && fn('default') === false && fn('trending') === false);
  }
  // 结构性锁：5 键必须落在一张表里（不是再写死两个键），且旧的死分支已被替换。
  const keysArr = es.MODELSCOPE_FULL_SORT_KEYS;
  check('导出 MODELSCOPE_FULL_SORT_KEYS 且含矩阵 5 键', Array.isArray(keysArr) && MATRIX.modelscope.every((k) => keysArr.includes(k)), JSON.stringify(keysArr));
  // 离线行为证明（stub 上游，不碰实网）：stars 必须触发**全量多次拉取**并在完整集合上排 + 切页。
  // 旧代码 stars 落到单页分支 → 只发 1 次请求、只排那一页 → 跨页错乱。
  {
    const realFetch = globalThis.fetch;
    const calls = [];
    const mkRow = (n) => ({ Name: 'sk-' + String(n).padStart(5, '0'), DisplayName: 'D' + n, DownloadCount: n, SourceStar: (n * 7) % 101, GmtCreate: 1700000000000 + n * 3600000, GmtModify: 1790000000000 - n * 3600000 });
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      const per = body.PageSize;
      const pg = body.PageNumber;
      const totalRows = 12000; // 合成 12k 条；页长由生产常量定，注释不再写死 5000
      const rows = [];
      for (let i = 0; i < per; i += 1) { const idx = (pg - 1) * per + i; if (idx >= totalRows) break; rows.push(mkRow(idx)); }
      return { ok: true, status: 200, json: async () => ({ Data: { SkillList: rows, TotalCount: totalRows } }) };
    };
    try {
      const p1 = await es.searchModelScope({ query: '', page: 1, pageSize: 12, cache: undefined, sort: 'stars' });
      const p2 = await es.searchModelScope({ query: '', page: 2, pageSize: 12, cache: undefined, sort: 'stars' });
      // 只看第一次请求的翻页序列（后续请求在无 cache 时会再拉一遍，属预期）。
      const firstPull = calls.slice(0, 3).map((c) => c.PageNumber + '/' + c.PageSize).join(' ');
      // 页长从生产源码取，不写死字面量：MS_PAGE 一改，期望序列自动跟着改。
      const srcTxt = fs.readFileSync(path.join(W, 'src', 'extra-sources.js'), 'utf8');
      const MS_PAGE = Number((srcTxt.match(/const MS_PAGE = (\d+);/) || [])[1] || 0);
      check('生产源码里 MS_PAGE 是一个可解析的正数', MS_PAGE > 0, 'MS_PAGE=' + MS_PAGE);
      // 判据不能吃写死的页长字面量：0.5.165 把 MS_PAGE 从 5000 降到 1000（实测 PageSize=5000
      // 单页 66s，被旧的 90s 超时 abort，分类态从第一天就拿不到数据）。这里按同一条算式重取
      // 期望序列，页长再变也不用改判据。
      const wantPull = [1, 2, 3].map((n) => n + '/' + MS_PAGE).join(' ');
      check('stars 首次即全量拉取前三页（页长取生产口径）', firstPull === wantPull, firstPull + ' 期望=' + wantPull);
      // 判别 off-by-one：12000 条 = 3 页；旧循环 pg < pagesNeeded 只拉 2 页 = 10000 条，
      // 于是第 1000 页（offset 11988）为空。修好后必须是 12 条。
      const deep = await es.searchModelScope({ query: '', page: 1000, pageSize: 12, cache: undefined, sort: 'stars' });
      check('全量分支拉够最后一页（12000 条而非 10000）', deep.items.length === 12, 'deepItems=' + deep.items.length);
      const sv = [...p1.items, ...p2.items].map((x) => Number(x.stars) || 0);
      check('stars 跨页降序（卡片 stars 与 getter 同源）', sv.every((x, k) => k === 0 || sv[k - 1] >= x) && sv[0] === 100, sv.slice(0, 6).join(','));
      const v = [...p1.items, ...p2.items].map((i) => Number(i.stars) || Number(i.modelScopeStars) || 0);
      const s = p2.items.map((i) => Number(i.stars) || 0);
      check('跨页仍降序（第2页首条 ≤ 第1页末条）', p1.items.length === 12 && s.length === 12 && (Number(p1.items[11].stars) || 0) >= s[0], 'p1last=' + p1.items[11].stars + ' p2first=' + s[0]);
      check('全量集合参与排序（第2页非上游原序）', v[0] !== ((0 * 7) % 101), String(v[0]));
      globalThis.fetch = realFetch;
      const callsDefault = [];
      globalThis.fetch = async (url, init) => { callsDefault.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ Data: { SkillList: [mkRow(1)], TotalCount: 12000 } }) }; };
      await es.searchModelScope({ query: '', page: 1, pageSize: 12, cache: undefined, sort: '' });
      check('无 sort 时仍是单次快请求（不退化成全量）', callsDefault.length === 1 && callsDefault[0].PageSize === 12, JSON.stringify(callsDefault));
    } catch (e) {
      check('modelscope stub 行为可运行', false, String(e.message).slice(0, 120));
    } finally { globalThis.fetch = realFetch; }
  }

  const seg = srcText.slice(srcText.indexOf('export async function searchModelScope'));
  check('旧的 sort === "installCount" || sort === "name" 死分支已消失', !/sort === "installCount" \|\| sort === "name"/.test(seg));
  check('searchModelScope 用 modelScopeSortMode', /const sortMode = modelScopeSortMode\(sort\)/.test(seg));
  const getters = es.MODELSCOPE_SORT_GETTERS;
  if (getters) {
  // MATRIX 抄本必须与能力表同源，否则「getter 齐备」是在跟一份本地副本较劲。
  const { sortKeysFor: capKeys } = await import('../src/sort-capability.js');
  const msCaps = capKeys('modelscope');
  check('MATRIX.modelscope 与能力表一致', JSON.stringify(MATRIX.modelscope) === JSON.stringify(msCaps), JSON.stringify(MATRIX.modelscope) + ' vs ' + JSON.stringify(msCaps));
  const missing = msCaps.filter((k) => typeof getters[k] !== 'function');
  check('modelscope 能力键 getter 齐备', missing.length === 0, msCaps.join(',') + ' 缺:' + missing.join(','));
  } else skip('MODELSCOPE_SORT_GETTERS 未导出');
}

console.log('');
console.log('Test 4: 缺陷3 — clawhub search 的 getter 必须有字段支撑');
{
  const getters = es.CLAWHUB_SEARCH_SORT_GETTERS;
  check('导出 CLAWHUB_SEARCH_SORT_GETTERS', getters && typeof getters === 'object');
  if (getters) {
    // 矩阵键已改为 downloadCount；这里再断言 getters.installCount 就是锁一个
    // 已被纠正的旧键（名称与真实字段一致整改的直接后果）。
    check('downloadCount getter 存在（读 r.downloads）', typeof getters.downloadCount === 'function');
    check('name 仍读 displayName/slug', typeof getters.name === 'function');
    // 实测 search 行：updatedAt 顶层齐全（epoch ms）；createdAt/stars 只在 native.skill.* 内（5/10 覆盖）。
    check('updated getter 读顶层 updatedAt', typeof getters.updatedAt === 'function' || typeof getters.updated === 'function');
    check('newest getter 读 native.skill.createdAt', typeof getters.newest === 'function');
    check('stars getter 读 native.skill.stats.stars', typeof getters.stars === 'function');
    check('trending 无字段支撑→故意不提供 getter（不造假）', getters.trending === undefined);
    // 展示同源（锁源码形状）：search 行的 stars/createdAt 只挂在 native.skill.* 上，
    // 卡片映射若继续读 raw.stars/raw.createdAt 就恒为 0 → 「排了但看起来没排」。
    const map = srcText.slice(srcText.indexOf('function mapClawHubRows'), srcText.indexOf('const CLAWHUB_CATALOG_KEY'));
    check('卡片 stars 读 native.skill.stats.stars', /raw\.native\?\.skill\?\.stats\?\.stars/.test(map));
    check('卡片 createdAt 读 native.skill.createdAt', /raw\.native\?\.skill\?\.createdAt/.test(map));
  }
}

console.log('');
console.log('Test 5: 缺陷3 — 真实 sortRawRows + getter 在合成行上的行为');
{
  const rows = [
    { id: '1', displayName: 'React', slug: 'react', downloads: 9957, updatedAt: 1785070153224, native: { skill: { createdAt: 1770657896736, stats: { stars: 3 } } } },
    { id: '2', displayName: 'react', slug: 'react2', downloads: 19014, updatedAt: 1794827870801 },
    { id: '3', displayName: 'Best', slug: 'best', downloads: 7231, updatedAt: 1778486478500, native: { skill: { createdAt: 1770728047421, stats: { stars: 4 } } } },
    { id: '4', displayName: 'Expert', slug: 'exp', downloads: 74, updatedAt: 1794986452462, native: { skill: { createdAt: 1794985854480, stats: { stars: 0 } } } },
  ];
  const clone = () => rows.map((r) => JSON.parse(JSON.stringify(r)));
  const desc = (a) => a.every((v, k) => k === 0 || a[k - 1] >= v);
  const g = es.CLAWHUB_SEARCH_SORT_GETTERS || {};
  if (typeof es.sortRawRows === 'function' && Object.keys(g).length) {
    const upd = es.sortRawRows(clone(), 'updated', g).map((r) => r.updatedAt);
    check('updated 降序单调', desc(upd), upd.join(','));
    const nw = es.sortRawRows(clone(), 'newest', g).map((r) => r.native?.skill?.createdAt ?? 0);
    check('newest 降序，缺 native 的行沉底', nw.length === 4 && nw[3] === 0 && desc(nw), nw.join(','));
    const st = es.sortRawRows(clone(), 'stars', g).map((r) => r.native?.skill?.stats?.stars ?? 0);
    check('stars 降序，缺 native 的行沉底', desc(st) && st[st.length - 1] === 0, st.join(','));
    const ic = es.sortRawRows(clone(), 'downloadCount', g).map((r) => r.downloads);
    check('downloadCount 降序单调', desc(ic), ic.join(','));
    const nm = es.sortRawRows(clone(), 'name', g).map((r) => String(r.displayName));
    check('name 升序', nm.join('|') === [...nm].sort((a, b) => a.localeCompare(b)).join('|'), nm.join('|'));
    const tr = es.sortRawRows(clone(), 'trending', g).map((r) => r.id).join(',');
    check('trending 保持上游序（不乱排）', tr === '1,2,3,4', tr);
  } else skip('sortRawRows/getters 不可用');
}

console.log('');
console.log('Test 6: 实网/实 CLI 复核（默认 SKIP，DSH_LIVE_SORT=1 开启）');
{
  if (process.env.DSH_LIVE_SORT !== '1') { skip('lobehub newest 实 CLI'); skip('modelscope stars 跨页单调'); skip('clawhub stars 实网单调'); }
  else {
    const cache = es.makeCache ? es.makeCache(path.join(safeTempDir(), 'dsh-ss-' + Date.now())) : undefined;
    try {
      const r = await es.searchLobeHubSkills({ query: 'react', page: 1, pageSize: 5, cache, sort: 'newest' });
      check('lobehub newest 有结果（不再整源消失）', Array.isArray(r.items) && r.items.length > 0, JSON.stringify(r).slice(0, 80));
    } catch (e) { check('lobehub newest 有结果（不再整源消失）', false, String(e.message).slice(0, 120)); }
    try {
      const a = await es.searchModelScope({ query: '', page: 1, pageSize: 10, cache, sort: 'stars' });
      const b = await es.searchModelScope({ query: '', page: 2, pageSize: 10, cache, sort: 'stars' });
      const lastA = Math.max(...a.items.map((i) => Number(i.stars) || 0));
      const firstB = Number(b.items[0]?.stars) || 0;
      check('modelscope stars 跨页有序', lastA >= firstB, 'p1max=' + lastA + ' p2first=' + firstB);
    } catch (e) { check('modelscope stars 跨页有序', false, String(e.message).slice(0, 120)); }
    try {
      const r = await es.searchClawHub({ query: 'react', page: 1, pageSize: 10, cache, sort: 'stars' });
      const v = r.items.map((i) => Number(i.stars) || 0);
      check('clawhub search stars 单调', v.every((x, k) => k === 0 || v[k - 1] >= x), v.join(','));
      check('clawhub search 卡片 stars 非恒 0', v.some((x) => x > 0), v.join(','));
    } catch (e) { check('clawhub search stars 单调', false, String(e.message).slice(0, 120)); }
  }
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
process.exit(failed ? 1 : 0);
