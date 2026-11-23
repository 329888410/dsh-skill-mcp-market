#!/usr/bin/env node
// test-skillsmp-search.mjs — TDD: skillsmp 搜索参数名 + 「窗口上限被当成目录总数」两处口径缺陷。
//
// 两处都以实测上游坐实（2026-11-22，直接打 /api/skills）：
//
// ① 旧实现发的是 `q=`（extra-sources.js:652）。实测 q=、keyword=、query= 全部被忽略，
//    filters 只回显 {"search":"","sortBy":"stars"}；唯一生效的键是 `search=`。
//    后果：带关键词的搜索返回的是全目录首页，用户以为搜过了。
// ② 旧实现的 `total` 直接抄 `pagination.total`（:684）。实测：
//      browse        → {"total":1200,"totalIsExact":false,"isCapped":true,"maxResults":1200}
//      search=pdf    → total 恒为 page*limit+1（24→25、48→49、p2→49、l40→41），totalIsExact:false
//      search 翻完   → totalIsExact:true（这才是真正的完整集合大小）
//    1200 是 API 自报的窗口上限，站点首页写的是 4,248,026 个 SKILL.md。把窗口当目录，
//    等于把「共约 1200 个」显示给用户；把 page*limit+1 当总数，等于总数随翻页线性增长。
// 判据只看上游字段（isCapped / maxResults / totalIsExact），不比较 1200 这种魔法数。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchSkills, makeCache } from '../src/sources.js';
import { searchSkillsMp } from '../src/extra-sources.js';
import { safeTempDir } from '../src/home.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');

let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  ' + String(d).slice(0, 200) : '')); } };

// 真实响应形状：由上游实测样本（data.skills 两行）派生，只改 filters/pagination。
const rawRow = (i) => ({
  id: 'sk-' + i,
  name: 'pdf-tool-' + i,
  description: 'handles pdf',
  author: 'octo',
  githubUrl: 'https://github.com/octo/repo-' + i + '/tree/main/skills/pdf-tool-' + i,
  branch: 'main',
  route: { sourceSkillPath: 'skills/pdf-tool-' + i + '/SKILL.md' },
  stars: 7,
});
const mkData = (n, filters, pagination) => ({ skills: Array.from({ length: n }, (u, i) => rawRow(i)), filters: filters || { search: '', sortBy: 'stars' }, pagination });

const cache = makeCache(safeTempDir());

// RED 阶段（旧实现没有 fetchJson 形参）urls 会是空的：断言必须 FAIL，不能崩在 new URL。
const paramsOf = (u) => (u ? new URL(u) : { searchParams: new URLSearchParams([]) }).searchParams;

console.log('');
console.log('Test 1: 请求带上游真正生效的 search= 参数');
{
  const urls = [];
  const fetchJson = async (u) => { urls.push(u); return mkData(2, { search: 'pdf', sortBy: 'stars' }, { page: 1, limit: 24, total: 25, totalIsExact: false, hasNext: true }); };
  await searchSkillsMp({ query: 'pdf', page: 1, pageSize: 24, cache: null, fetchJson });
  check('请求经由注入的 fetchJson 发出（seam 生效）', urls.length === 1, JSON.stringify(urls));
  const q = paramsOf(urls[0]);
  console.log('   实测 URL: ' + String(urls[0]));
  check('带上 search=pdf', q.get('search') === 'pdf', urls[0]);
  check('不再带被上游忽略的 q=', q.get('q') === null && q.get('keyword') === null && q.get('query') === null, urls[0]);
  const u2 = { searchParams: paramsOf(urls[0]) };
  check('带上 page 与 limit', u2.searchParams.get('page') === '1' && u2.searchParams.get('limit') === '24', urls[0]);
}

console.log('');
console.log('Test 2: 无关键词（browse）时不发 search=');
{
  const urls = [];
  const fetchJson = async (u) => { urls.push(u); return mkData(2, { search: '', sortBy: 'stars' }, { page: 1, limit: 24, total: 1200, totalPages: 50, hasNext: true, totalIsExact: false, isCapped: true, maxResults: 1200 }); };
  await searchSkillsMp({ query: '   ', page: 1, pageSize: 24, cache: null, fetchJson });
  const sp = paramsOf(urls[0]);
  check('browse 请求根本不带 search 键（空值也算污染回显）', sp.get('search') === null, urls[0]);
  check('browse 仍带上 page/limit', sp.get('page') === '1' && sp.get('limit') === '24', urls[0]);
}

console.log('');
console.log('Test 3: isCapped/maxResults 的窗口上限不得当成目录总数');
{
  const fetchJson = async () => mkData(24, { search: '', sortBy: 'stars' }, { page: 1, limit: 24, total: 1200, totalPages: 50, hasNext: true, hasPrev: false, totalIsExact: false, isCapped: true, maxResults: 1200 });
  const r = await searchSkillsMp({ query: '', page: 1, pageSize: 24, cache: null, fetchJson });
  console.log('   实测(browse 窗口): total=' + String(r.total) + ' hasMore=' + String(r.hasMore) + ' hint=' + String(r.hint));
  check('browse 不报 1200 这种窗口总数', r.total === undefined, String(r.total));
  check('browse 不给由窗口推算的 totalPages', r.totalPages === undefined, String(r.totalPages));
  // 用户 2026-11-23 点名这句说明已失效、不要再显示：数字本身（maxResults=1200
  // 实测仍在）不是问题，问题是它给的出路只有一条「换关键词继续找」，而面板现在
  // 有 63 个分类 chip（各自带上游 totalAll 真实条数）可走。去掉说明不等于放弃口径：
  // 总数与总页数必须继续留未知——不许因为「不再解释」就顺手把窗口当总数报出来。
  check('browse 窗口态不再显示那条过时说明', r.hint === undefined || r.hint === '', String(r.hint));
  check('去掉说明后总数仍不得冒充目录规模', r.total === undefined && r.totalPages === undefined, String(r.total) + '/' + String(r.totalPages));
  check('hasMore 沿用上游 hasNext=true', r.hasMore === true, String(r.hasMore));
  // 没有 isCapped 但 totalIsExact:false：同样是「不精确」，一样不许报数
  const r2 = await searchSkillsMp({ query: 'pdf', page: 1, pageSize: 24, cache: null, fetchJson: async () => mkData(24, { search: 'pdf', sortBy: 'stars' }, { page: 1, limit: 24, total: 25, hasNext: true, totalIsExact: false }) });
  console.log('   实测(search 未翻完): total=' + String(r2.total) + ' hint=' + String(r2.hint));
  check('totalIsExact:false 时 total 保持未知', r2.total === undefined, String(r2.total));
  check('totalIsExact:false 时仍给出「总数未知」说明', typeof r2.hint === 'string' && r2.hint.length > 0, String(r2.hint));
  // 真实上游 2026-11-22 实测：search 未翻完只回 totalIsExact:false（没有 isCapped/maxResults），
  // 那个 total 是 page*limit+1 的每页移动值，绝不许写进说明里冒充窗口。
  check('未翻完 search 的说明不得引用会移动的 total 数字', !/\d/.test(String(r2.hint)), String(r2.hint));
  check('上游没回 isCapped 时说明不得谎称 isCapped', !/isCapped/i.test(String(r2.hint)), String(r2.hint));
  // 上游自报 hasNext:false（实测 search 深页形状：窗口未翻完但确实没有下一页）：不许再承诺下一页
  const r3 = await searchSkillsMp({ query: 'pdf', page: 1, pageSize: 24, cache: null, fetchJson: async () => mkData(24, { search: 'pdf', sortBy: 'stars' }, { page: 1, limit: 24, total: 1000, hasNext: false, totalIsExact: false }) });
  console.log('   实测(窗口未翻完 + hasNext=false): total=' + String(r3.total) + ' hasMore=' + String(r3.hasMore));
  check('hasNext=false 时 hasMore 必须是 false（不承诺空页）', r3.hasMore === false, String(r3.hasMore));
  // hasNext 缺失：unknown 就留 unknown，不拿「本页装满」去猜
  const r4 = await searchSkillsMp({ query: 'pdf', page: 1, pageSize: 24, cache: null, fetchJson: async () => mkData(24, { search: 'pdf', sortBy: 'stars' }, { page: 1, limit: 24, total: 1000, totalIsExact: false }) });
  check('hasNext 缺失时 hasMore 保持未知', r4.hasMore === undefined, String(r4.hasMore));
  // 窗口数字必须来自上游字段：换一种 maxResults，说明里的数字要跟着变
  const r5 = await searchSkillsMp({ query: '', page: 1, pageSize: 24, cache: null, fetchJson: async () => mkData(24, { search: '', sortBy: 'stars' }, { page: 1, limit: 24, total: 4242, totalPages: 6, hasNext: true, totalIsExact: false, isCapped: true, maxResults: 777 }) });
  console.log('   实测(maxResults=777): hint=' + String(r5.hint));
  // 窗口态整条说明已撤，所以这里改锁「换 maxResults 也不会冒出数字」：
  // 撤掉一条说明不许顺手留下别的数字来源。
  check('maxResults=777 时同样不显示窗口说明', (r5.hint === undefined || r5.hint === '') && !/777/.test(String(r5.hint)), String(r5.hint));
  // isCapped 只声明「有窗口」，没声明窗口多大：没有 maxResults 就不许从 total 倒推出数字。
  const r6 = await searchSkillsMp({ query: '', page: 1, pageSize: 24, cache: null, fetchJson: async () => mkData(24, { search: '', sortBy: 'stars' }, { page: 1, limit: 24, total: 1200, totalPages: 50, hasNext: true, totalIsExact: false, isCapped: true }) });
  check('只有 isCapped 没有 maxResults 时说明不得凭 total 编数字', !/\d/.test(String(r6.hint)), String(r6.hint));
  // maxResults 存在但退化（0）：同样不许回头引用会移动的 total。
  const r7 = await searchSkillsMp({ query: '', page: 1, pageSize: 24, cache: null, fetchJson: async () => mkData(24, { search: '', sortBy: 'stars' }, { page: 1, limit: 24, total: 1200, hasNext: true, totalIsExact: false, isCapped: true, maxResults: 0 }) });
  check('maxResults 退化时不得回头引用 total', !/1200/.test(String(r7.hint)), String(r7.hint));
}

console.log('');
console.log('Test 4: 搜索翻完后上游报的精确总数必须照实上报');
{
  const fetchJson = async () => mkData(0, { search: 'zzzzxqqq', sortBy: 'stars' }, { page: 1, limit: 24, total: 0, totalPages: 1, hasNext: false, hasPrev: false, totalIsExact: true });
  const r = await searchSkillsMp({ query: 'zzzzxqqq', page: 1, pageSize: 24, cache: null, fetchJson });
  console.log('   实测(翻完): total=' + String(r.total) + ' hasMore=' + String(r.hasMore));
  check('totalIsExact:true 时 total 就是上游的 0', r.total === 0, String(r.total));
  check('hasMore 取上游 hasNext=false', r.hasMore === false, String(r.hasMore));
  const r5 = await searchSkillsMp({ query: 'pdf', page: 1, pageSize: 24, cache: null, fetchJson: async () => mkData(5, { search: 'pdf', sortBy: 'stars' }, { page: 1, limit: 24, total: 5, totalPages: 1, hasNext: false, totalIsExact: true }) });
  check('totalIsExact:true 的 5 条结果照实上报', r5.total === 5 && r5.hasMore === false, String(r5.total) + '/' + String(r5.hasMore));
}

console.log('');
console.log('Test 5: 聚合层不得再冒出窗口数字');
{
  const handlers = {
    skillsmp: () => searchSkillsMp({ query: '', page: 1, pageSize: 24, cache: null, fetchJson: async () => mkData(24, { search: '', sortBy: 'stars' }, { page: 1, limit: 24, total: 1200, totalPages: 50, hasNext: true, totalIsExact: false, isCapped: true, maxResults: 1200 }) }),
  };
  const r = await searchSkills({ query: '', source: 'skillsmp', page: 1, pageSize: 24, cache: makeCache(safeTempDir()), handlers, budgetMs: 5000 });
  console.log('   实测聚合: total=' + String(r.total) + ' totalPages=' + String(r.totalPages) + ' hints=' + JSON.stringify(r.hints));
  check('单源 skillsmp 的 browse 不报总数', r.total === undefined, String(r.total));
  check('单源 skillsmp 的 browse 不报总页数', r.totalPages === undefined, String(r.totalPages));
  // 展示层收口：browse 不再有那条说明 ⇒ 聚合 hints 里不得再出现它（也不得冒出 1200）。
  check('聚合 hints 不再携带那条窗口说明', Array.isArray(r.hints) && r.hints.length === 0 && !JSON.stringify(r.hints).includes('1200'), JSON.stringify(r.hints));
}

console.log('');
console.log('Test 6: 发出的 limit 必须落在上游接受范围内');
{
  const urls = [];
  const fetchJson = async (u) => { urls.push(u); return mkData(1, { search: '', sortBy: 'stars' }, { page: 1, limit: 1, total: 0, totalIsExact: true, hasNext: false }); };
  await searchSkillsMp({ query: '', page: 1, pageSize: 50, cache: null, fetchJson });
  const lim = Number(paramsOf(urls[0]).get('limit'));
  console.log('   实测 pageSize=50 → limit=' + lim + '（上游 49/50 回 HTTP 400：Invalid limit; expected one integer between 1 and 48）');
  check('limit 不越过上游接受上限 48', lim <= 48, String(lim));
  check('pageSize 被完整用上（clamp 到 48 而不是缩到 10）', lim === 48, String(lim));
  const urls2 = [];
  await searchSkillsMp({ query: '', page: 0, pageSize: 0, cache: null, fetchJson: async (u) => { urls2.push(u); return mkData(1, undefined, undefined); } });
  const sp2 = paramsOf(urls2[0]);
  check('page 至少为 1（page=0 上游回 400）', Number(sp2.get('page')) >= 1, sp2.get('page'));
  check('limit 至少为 1（limit=0 上游回 400）', Number(sp2.get('limit')) >= 1, sp2.get('limit'));
}

console.log('');
console.log('Test 7: 上游整体缺 pagination 时仍不得造总数');
{
  const urls = [];
  const r = await searchSkillsMp({ query: 'pdf', page: 1, pageSize: 24, cache: null, fetchJson: async (u) => { urls.push(u); return { skills: [rawRow(1)] }; } });
  check('缺 pagination 时 total 保持未知', r.total === undefined, String(r.total));
  check('缺 pagination 时仍给出说明', typeof r.hint === 'string' && r.hint.length > 0, String(r.hint));
  check('缺 pagination 时 hasMore 以本页是否装满判断', r.hasMore === false, String(r.hasMore));
}

console.log('');
console.log('Test 8: 命中集合必须是上游过滤后的行（条数与上游一致）');
{
  const fetchJson = async (u) => {
    const sp = new URL(u).searchParams;
    const s = sp.get('search') || '';
    const all = Array.from({ length: 40 }, (x, i) => rawRow(i));
    const rows = s ? all.slice(0, 5) : all;
    return mkData(rows.length, { search: s, sortBy: 'stars' }, { page: 1, limit: 24, total: rows.length, totalPages: 1, hasNext: false, totalIsExact: true });
  };
  const hit = await searchSkillsMp({ query: 'pdf', page: 1, pageSize: 24, cache: null, fetchJson });
  const browse = await searchSkillsMp({ query: '', page: 1, pageSize: 24, cache: null, fetchJson });
  console.log('   实测: search=pdf → ' + hit.items.length + ' 条 total=' + String(hit.total) + '；browse → ' + browse.items.length + ' 条 total=' + String(browse.total));
  check('search=pdf 的条数等于上游过滤集大小', hit.items.length === 5 && hit.total === 5, hit.items.length + '/' + String(hit.total));
  check('browse 的条数等于上游全集大小', browse.items.length === 24 && browse.total === 40, browse.items.length + '/' + String(browse.total));
  check('上报计数与实际集合一致（不是窗口值）', browse.total === 40, String(browse.total));
}

console.log('');
console.log('Test 9: 守卫自证 —— 静态源码不得再出现被忽略的 q= 参数或 p*size 造数');
{
  const src = fs.readFileSync(path.join(REPO, 'src', 'extra-sources.js'), 'utf8');
  const s = src.indexOf('export async function searchSkillsMp');
  const e = src.indexOf('// ---------------------------------------------------------------- ModelScope', s);
  const body = src.slice(s, e);
  check('searchSkillsMp 区域内不再用 URLSearchParams({ q, ... }) 形式', !/new URLSearchParams\(\s*\{\s*q[,:]/.test(body), body.slice(body.indexOf('new URLSearchParams'), body.indexOf('new URLSearchParams') + 90));
  check('searchSkillsMp 区域内不再以 p * size 造总数', !/p\s*\*\s*size\s*\+/.test(body), '');
  check('请求参数键只有 page/limit/search', /params\.set\("search", q\)/.test(body) && !/params\.set\("(q|keyword|query)"/.test(body), '');
  check('limit 上限取自实测接受值（SKILLSMP_MAX_LIMIT）', /Math\.min\(SKILLSMP_MAX_LIMIT/.test(body), '');
  // 边界值必须有上游原文支撑（用户 2026-11-22 点名：48 落在 40 与 50 之间的未知区）：
  // 交错重放 4 轮实测 48 → HTTP 200 n=48，49/50 → HTTP 400 且错误体自己写「between 1 and 48」。
  check('SKILLSMP_MAX_LIMIT 等于上游自报的边界 48', /const SKILLSMP_MAX_LIMIT = 48;/.test(src), '边界与上游原文不符');
  check('边界取证写明上游原文与重放轮次', /Invalid limit; expected one integer between 1 and 48/.test(src) && /交错重放 4 轮/.test(src), '注释里没有可复核的上游证据');
}

console.log('');
console.log('Test 10: cache.get 只经 cache 对象调用（不得残留 makeCache(...) 直调）');
{
  const src = fs.readFileSync(path.join(REPO, 'src', 'extra-sources.js'), 'utf8');
  const s = src.indexOf('export async function searchSkillsMp');
  const e = src.indexOf('// ---------------------------------------------------------------- ModelScope', s);
  const body = src.slice(s, e);
  check('区域内不含 makeCache(', !body.includes('makeCache('), '');
  check('区域内 cache.get 走的是 cache 对象', /cache\.get\(key, SKILLSMP_TTL\)/.test(body), '');
}

console.log('');
console.log('Test 11: 分类 facet 只在纯浏览态透传上游，并回填到卡片');
{
  const urls = [];
  const mkFacet = () => mkData(2, { search: '', sortBy: 'stars' }, { page: 1, limit: 24, total: 480, totalPages: 10, hasNext: true, totalIsExact: true, isCapped: true, maxResults: 480, totalAll: 532411 });
  const r = await searchSkillsMp({ query: '', page: 1, pageSize: 24, category: 'debugging', cache: null, fetchJson: async (u) => { urls.push(u); return mkFacet(); } });
  const sp = paramsOf(urls[0]);
  console.log('   实测 URL: ' + String(urls[0]));
  check('纯浏览态把 category 发给上游', sp.get('category') === 'debugging', String(urls[0]));
  check('facet 回填到卡片 category（行上无分类字段时）', r.items.length > 0 && r.items.every((it) => it.category === 'debugging'), JSON.stringify(r.items.map((it) => it.category)));
  const urls2 = [];
  await searchSkillsMp({ query: 'pdf', page: 1, pageSize: 24, category: 'debugging', cache: null, fetchJson: async (u) => { urls2.push(u); return mkData(2, { search: 'pdf', sortBy: 'stars' }, { page: 1, limit: 24, total: 7, hasNext: true, totalIsExact: false }); } });
  check('带关键词时绝不发 facet（实测被忽略且静默换集合）', paramsOf(urls2[0]).get('category') === null, String(urls2[0]));
  // 一次性缓存目录：safeTempDir() 是共享目录，磁盘缓存活过 10 分钟 TTL 会让本场景跨轮次互相污染。
  const c2 = makeCache(safeTempDir() + '/skillsmp-facet-' + Date.now());
  const n3 = [];
  const fj3 = async (u) => { n3.push(u); return mkFacet(); };
  await searchSkillsMp({ query: '', page: 1, pageSize: 24, category: 'debugging', cache: c2, fetchJson: fj3 });
  await searchSkillsMp({ query: '', page: 1, pageSize: 24, category: 'cli-tools', cache: c2, fetchJson: fj3 });
  await searchSkillsMp({ query: '', page: 1, pageSize: 24, category: 'debugging', cache: c2, fetchJson: fj3 });
  check('缓存键含 facet（不同分类不得串同一页）', n3.length === 2, JSON.stringify(n3));
  check('同一分类重复浏览才走缓存', n3[0] !== n3[1] && /category=debugging/.test(n3[0]), JSON.stringify(n3));
  let threw = '';
  let rr = null;
  const n4 = [];
  try {
    rr = await searchSkillsMp({ query: '', page: 1, pageSize: 24, category: 'tools', cache: null, fetchJson: async (u) => {
      n4.push(u);
      if (new URL(u).searchParams.get('category')) throw new Error('python 取数失败：Traceback ... urllib.error.HTTPError: HTTP Error 400: Bad Request');
      return mkData(2, { search: '', sortBy: 'stars' }, { page: 1, limit: 24, total: 1200, totalPages: 50, hasNext: true, totalIsExact: false, isCapped: true, maxResults: 1200 });
    } });
  } catch (e) { threw = String((e && e.message) || e); }
  check('facet 被上游 400 拒绝时整源不崩', threw === '' && rr !== null, threw);
  check('被拒后去 facet 重发一次（不是放弃这一页）', n4.length === 2 && !new URL(n4[1]).searchParams.get('category'), JSON.stringify(n4));
  check('被拒时 hint 如实说不接受该分类', !!rr && typeof rr.hint === 'string' && /分类/.test(rr.hint), rr && String(rr.hint));
  check('被拒时不得把该分类回填到卡片', !!rr && rr.items.every((it) => !it.category), JSON.stringify(rr && rr.items.map((it) => it.category)));
}

console.log('');
console.log('Test 12: facet 态的 480 是窗口深度、totalAll 才是目录条数');
{
  // 样本自洽：limit=24 时上游给的 totalPages 就是 480/24=20（实测 limit=48 → 10）。
  const shape = (extra) => Object.assign({ page: 1, limit: 24, total: 480, totalPages: 20, hasNext: true, totalIsExact: true, isCapped: true, maxResults: 480, totalAll: 532411 }, extra || {});
  const r = await searchSkillsMp({ query: '', page: 1, pageSize: 24, category: 'debugging', cache: null, fetchJson: async () => mkData(24, { search: '', sortBy: 'stars' }, shape()) });
  console.log('   实测(facet 首页): total=' + String(r.total) + ' totalPages=' + String(r.totalPages) + ' hasMore=' + String(r.hasMore) + ' hint=' + String(r.hint));
  check('facet 态总数报 totalAll（不是窗口 480）', r.total === 532411, String(r.total));
  check('总页数只能是窗口页深 480/24=20（不得用 totalAll 反推）', r.totalPages === 20, String(r.totalPages));
  check('hint 同时给出目录条数与可翻页深度', /532411/.test(String(r.hint)) && /480/.test(String(r.hint)), String(r.hint));
  const rEnd = await searchSkillsMp({ query: '', page: 10, pageSize: 48, category: 'debugging', cache: null, fetchJson: async () => mkData(48, { search: '', sortBy: 'stars' }, shape({ page: 10, limit: 48, hasNext: false })) });
  check('窗口末页 hasNext=false → hasMore 必须 false', rEnd.hasMore === false, String(rEnd.hasMore));
  check('末页仍报 totalAll', rEnd.total === 532411, String(rEnd.total));
  const rNoAll = await searchSkillsMp({ query: '', page: 1, pageSize: 24, category: 'tools', cache: null, fetchJson: async () => mkData(24, { search: '', sortBy: 'stars' }, { page: 1, limit: 24, total: 480, totalPages: 20, hasNext: true, totalIsExact: false, isCapped: true, maxResults: 480 }) });
  check('没有 totalAll 时绝不报数字总数', rNoAll.total === undefined, String(rNoAll.total));
  const rPlain = await searchSkillsMp({ query: 'pdf', page: 1, pageSize: 24, cache: null, fetchJson: async () => mkData(5, { search: 'pdf', sortBy: 'stars' }, { page: 1, limit: 24, total: 5, totalPages: 1, hasNext: false, totalIsExact: true }) });
  check('普通翻完的精确态不回退（total 照报 5）', rPlain.total === 5 && rPlain.hasMore === false, String(rPlain.total) + '/' + String(rPlain.hasMore));
}

console.log('');
console.log('Test 13: stars 不再写死为 0，口径注释必须改对');
{
  const rows = [Object.assign(rawRow(0), { stars: 469982 }), Object.assign(rawRow(1), { stars: 1602 })];
  const r = await searchSkillsMp({ query: '', page: 1, pageSize: 24, cache: null, fetchJson: async () => ({ skills: rows, filters: { search: '', sortBy: 'stars' }, pagination: { page: 1, limit: 24, total: 2, totalIsExact: true, hasNext: false } }) });
  check('stars 取上游真实值', r.items[0].stars === 469982 && r.items[1].stars === 1602, JSON.stringify(r.items.map((i) => i.stars)));
  const src = fs.readFileSync(path.join(REPO, 'src', 'extra-sources.js'), 'utf8');
  const s = src.indexOf('export async function searchSkillsMp');
  const e = src.indexOf('// ---------------------------------------------------------------- ModelScope', s);
  const body = src.slice(s, e);
  check('skillsmp 区域内不再有 stars: 0', !/stars: 0/.test(body), '');
  check('skillsmp 区域内不再称 stars 是 placeholder', !/placeholder/i.test(body), '');
}

console.log('');
console.log('Test 14: 排序键映射到上游生效的 sortBy，且不再本页重排');
{
  const unordered = [Object.assign(rawRow(0), { stars: 10, updatedAt: 5 }), Object.assign(rawRow(1), { stars: 900, updatedAt: 9 }), Object.assign(rawRow(2), { stars: 50, updatedAt: 7 })];
  const mk = () => ({ skills: unordered.slice(), filters: { search: '', sortBy: 'stars' }, pagination: { page: 1, limit: 24, total: 3, totalIsExact: true, hasNext: false } });
  const urls = [];
  const rStars = await searchSkillsMp({ query: '', page: 1, pageSize: 24, sort: 'stars', cache: null, fetchJson: async (u) => { urls.push(u); return mk(); } });
  check('sort=stars 发 sortBy=stars', paramsOf(urls[0]).get('sortBy') === 'stars', String(urls[0]));
  check('stars 由服务端排，本页不得重排', rStars.items.map((i) => i.stars).join(',') === '10,900,50', rStars.items.map((i) => i.stars).join(','));
  const urls2 = [];
  const rUpd = await searchSkillsMp({ query: '', page: 1, pageSize: 24, sort: 'updated', cache: null, fetchJson: async (u) => { urls2.push(u); return mk(); } });
  check('sort=updated 映射到上游唯一生效的 sortBy=recent', paramsOf(urls2[0]).get('sortBy') === 'recent', String(urls2[0]));
  check('updated 也不得本页重排（条目顺序即上游序）', rUpd.items.map((i) => i.name).join(',') === 'pdf-tool-0,pdf-tool-1,pdf-tool-2', rUpd.items.map((i) => i.name).join(','));
  const urls3 = [];
  const rName = await searchSkillsMp({ query: '', page: 1, pageSize: 24, sort: 'name', cache: null, fetchJson: async (u) => { urls3.push(u); return mk(); } });
  check('sort=name 不发 sortBy（上游无 name 排序）', paramsOf(urls3[0]).get('sortBy') === null, String(urls3[0]));
  check('sort=name 仍本地升序', rName.items[0].name <= rName.items[2].name, JSON.stringify(rName.items.map((i) => i.name)));
  const urls4 = [];
  await searchSkillsMp({ query: '', page: 1, pageSize: 24, sort: 'installCount', cache: null, fetchJson: async (u) => { urls4.push(u); return mk(); } });
  check('installCount 绝不伪造 sortBy', paramsOf(urls4[0]).get('sortBy') === null, String(urls4[0]));
}

console.log('');
console.log('Test 15: 取证注释必须把 facet 窗口与白名单写成可复核的事实');
{
  const src = fs.readFileSync(path.join(REPO, 'src', 'extra-sources.js'), 'utf8');
  const s = src.indexOf('// ---------------------------------------------------------------- skillsmp');
  const e = src.indexOf('export async function searchSkillsMp', s);
  const notes = src.slice(s, e);
  check('注释写明 480 是窗口深度不是条数', /480/.test(notes) && /窗口/.test(notes) && /不是/.test(notes), '');
  check('注释引用上游自报 totalAll 实测值', /totalAll/.test(notes) && /532411/.test(notes), notes.slice(0, 200));
  check('注释写明白名单是真子集（63 接受 / 11 拒绝）', /63/.test(notes) && /11/.test(notes) && /(INVALID_CATEGORY|400)/.test(notes), '');
}
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
