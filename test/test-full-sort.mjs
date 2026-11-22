#!/usr/bin/env node
// test-full-sort.mjs — TDD: 「按安装数」必须是真实全盘排序，禁止窗口近似。
//
// 实测事实（侦察结论，勿凭记忆改动）：
//   trusttools GET /api/skills?sort_by=install_count&direction=desc → 服务端对 579,074 条全盘排序，
//     首条 ui-ux-pro-max≈446,924，跨页全局单调。POST /search 的 sort 参数全部被忽略。
//   skillhub   GET ?sortBy=installs&order=desc → 服务端全盘排序，首条 self-improving-agent
//     installs=86,140（实测两次请求一致），跨页全局单调。注意上游 installs 与 downloads 是
//     两个不同字段：早期侦察误把 installCount 接到 downloads（首条 dev-god≈12.1M 就是下载榜），
//     0.5.133 修正为 installs；因此本套件的绝对下限也改成自校准判据，不再硬编码那个下载数。
//   lobehub    CLI --sort installCount --order desc → 服务端全盘排序，p1 min ≥ p2 max。
//   clawhub    browse GET ?sort=downloads（不是 search！）→ 服务端全盘排序，首条 ≈493,957，
//     跨 cursor 全局单调；sort=installs 不单调（stats.installs 数据质量差），必须用 downloads。
//   modelscope 无服务端 sort；PageSize 可到 20000，全量 88,993 条 = 5 次调用。全量拉取后本地排
//     是「真实全量」，取前 N 条窗口排是「近似」——禁止后者。
//   browse.sh  一次返回全量 479 条（459 条带 installCount），本地全量排 = 真实全量。
//   skillsmp   CLI 仅 --sort stars|recent，无 installCount → 必须诚实声明不支持。
//   skills.sh  search API 返回已按 installs 降序（4431266,14,14…）；sitemap browse 无 installs。
import { searchSkills, makeCache, supportsSort } from '../src/sources.js';
import fs from 'node:fs';
import path from 'node:path';
import { safeTempDir } from '../src/home.js';

let passed = 0, failed = 0, skipped = 0;
const check = (n, c, d = '') => { if (c) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + d + ']' : '')); } };
const skip = (n) => { skipped++; console.log('  SKIP ' + n); };
const W = path.resolve(import.meta.dirname, '..');

// ── 静态断言：缓存键必须含 sort（跨排序污染 bug 的锁） ──
console.log('');
console.log('Test 0: 所有 handler 的结果缓存键必须包含 sort');
{
  const e = fs.readFileSync(path.join(W, 'src/extra-sources.js'), 'utf8');
  const s = fs.readFileSync(path.join(W, 'src/sources.js'), 'utf8');
  const all = e + '\n' + s;
  // 只检查「结果缓存」键：存原始未排序行的目录缓存（modelscope:full / clawhub_catalog）
  // 合法地不含 sort——排序在每次请求时现做，缓存的是上游原始序。
  const keyLines = all.split('\n').filter((l) => /const \w*[kK]ey\w* = `/.test(l) && /search|skillsmp|trusttools|clawhub:|modelscope:search|skillssh|lobehub_skills/.test(l) && !/modelscope:full|CLAWHUB_CATALOG/.test(l));
  const missing = keyLines.filter((l) => !/sort/i.test(l));
  check('every result cache key includes sort', missing.length === 0, missing.map((m) => m.trim().slice(0, 60)).join(' | '));
}

// ── 能力表必须与实测一致 ──
console.log('');
console.log('Test 1: supportsSort 与上游真实能力一致');
{
  check('trusttools installCount', supportsSort('trusttools', 'installCount') === true);
  check('skillhub installCount', supportsSort('skillhub', 'installCount') === true);
  check('lobehub installCount', supportsSort('lobehub', 'installCount') === true);
  check('clawhub NOT installCount（真实可排字段是下载数）', supportsSort('clawhub', 'installCount') === false);
  check('modelscope NOT installCount（上游无安装量列）', supportsSort('modelscope', 'installCount') === false);
  check('clawhub downloadCount（browse sort=downloads / search getter r.downloads）', supportsSort('clawhub', 'downloadCount') === true);
  check('modelscope downloadCount（DownloadCount 是其唯一量级字段）', supportsSort('modelscope', 'downloadCount') === true);
  check('browse.sh installCount', supportsSort('browse.sh', 'installCount') === true);
  check('skillsmp NOT installCount (CLI 无此 sort)', supportsSort('skillsmp', 'installCount') === false);
}

const cache = makeCache(path.join(safeTempDir(), 'dsh-fs-' + Date.now()));
const sz = 12;
// vals 取 installs：仍被 trusttools / skillhub / browse.sh 的绝对值段使用（那些源
// 确实按 installCount 排）。clawhub/modelscope 不靠它 —— 它们按 downloads 排，
// 取值字段见 GLOBAL_SORT_KEY/fieldOf，名称与字段一致。
const vals = (items) => items.map((i) => Number(i.installs) || 0);

// 每个源用它「实际排序字段」验单调：clawhub 可排的是 downloads，installs 稀疏
// （60 条样本仅 18 条有值），拿 installs 验单调得到的是字段选错的假乱序而非回归。
const GLOBAL_SORT_KEY = { trusttools: "installCount", skillhub: "installCount", clawhub: "downloadCount", "browse.sh": "installCount", lobehub: "installCount", modelscope: "downloadCount" };
const fieldOf = (k) => (k === 'downloadCount' ? 'downloads' : 'installs');
async function globalSortCheck(label, source, opts = {}) {
  let p1, p2, errored = false;
  try {
    const sortKey = GLOBAL_SORT_KEY[source] || 'installCount';
    p1 = await searchSkills({ query: '', source, page: 1, pageSize: sz, cache, sort: sortKey, ...opts });
    p2 = await searchSkills({ query: '', source, page: 2, pageSize: sz, cache, sort: sortKey, ...opts });
  } catch (e) { errored = true; }
  if (errored || !p1 || !p1.items.length || !p2 || !p2.items.length) { skip(label + '（上游不可达）'); return; }
  const f = fieldOf(GLOBAL_SORT_KEY[source] || 'installCount');
  const v1 = p1.items.map((i) => Number(i[f]) || 0), v2 = p2.items.map((i) => Number(i[f]) || 0);
  check(label + ' p1 单调降序', v1.every((v, k, a) => k === 0 || a[k - 1] >= v), v1.join(','));
  check(label + ' 跨页全局单调', Math.max(...v2) <= Math.min(...v1), 'p1min=' + Math.min(...v1) + ' p2max=' + Math.max(...v2));
  console.log('    ' + label + ' p1 head: ' + v1.slice(0, 3).join(', '));
}

console.log('');
console.log('Test 2: 服务端全盘排序源（首条必须是全局最大级别，而非窗口内最大）');
await globalSortCheck('trusttools', 'trusttools');
await globalSortCheck('skillhub', 'skillhub');
await globalSortCheck('clawhub', 'clawhub');

console.log('');
console.log('Test 3: 绝对值下限——证明排的是全量而不是窗口');
{
  try {
    const r = await searchSkills({ query: '', source: 'trusttools', page: 1, pageSize: sz, cache, sort: 'installCount' });
    // searchSkills 从不抛错：单源失败被吞进 degraded 并返回空 items（sources.js:541-543）。
    // 只有「空 items 且该源确实在 degraded[] 里」才是上游不可达 → SKIP；
    // 空 items 但无 degraded = handler 回归（本应 FAIL），不能放过。
    if (!r.items.length && r.degraded && r.degraded.length) { skip('trusttools absolute（上游不可达，见 degraded）'); }
    else {
      const top = Math.max(...vals(r.items));
      // 窗口法实测首条 ~63,307；服务端全盘首条 446,924。取 200,000 为分界。
      check('trusttools 首条 > 200,000（全盘）而非 ~63k（窗口）', top > 200000, 'got ' + top);
    }
  } catch (e) { skip('trusttools absolute (' + String(e.message).slice(0, 30) + ')'); }
  try {
    const r = await searchSkills({ query: '', source: 'skillhub', page: 1, pageSize: sz, cache, sort: 'installCount' });
    if (!r.items.length && r.degraded && r.degraded.length) { skip('skillhub absolute（上游不可达，见 degraded）'); }
    else {
      const top = Math.max(...vals(r.items));
      // 只断言「installs 字段确实有全盘量级的数据」。曾经这里还想跟「未排序窗口的
      // max」比大小，实测那次判据自己会漂：未排序是按 updated_at 排的，一个高安装数
      // 条目刚被更新就会进到窗口里（top=86,140 对 窗口max=57,561，3 倍余量不成立）。
      // 「排的是全量而非窗口」这件事由上面的 globalSortCheck 用结构性质证明
      // （p1 组内单调 + 跨页 p1min ≥ p2max），那才是与上游数值漂移无关的确定性判据。

      // 上限级 sanity：installs 全局首条应在数万量级；若上游把该字段清空，这里会变红
      // （实测 60 条样本里 50 条 installs 为 0，但全盘排序的榜首仍是 86,140）。
      check('skillhub installs 字段仍有数据', top > 20000, 'top=' + top);
    }
  } catch (e) { skip('skillhub absolute'); }
  try {
    const r = await searchSkills({ query: '', source: 'clawhub', page: 1, pageSize: sz, cache, sort: 'downloadCount' });
    if (!r.items.length && r.degraded && r.degraded.length) { skip('clawhub absolute（上游不可达，见 degraded）'); }
    else {
      // 该源按 downloads 排（名称与字段一致），绝对值下限也必须读 downloads；
      // vals() 取的是 installs，用它会得到 18,549 而不是榜首 494,474。
      const top = Math.max(...r.items.map((i) => Number(i.downloads) || 0));
      // 绝对值下限判的是「排的是全量而非窗口」。窗口侧的量用一条真实的未排序
      // 请求去量（不硬编码窗口大小）：实测未排序首页 downloads max≈2,070、installs max=129，
      // 而下载榜首是 self-improving-agent downloads=494,474 —— 相差两个数量级。
      // 阈值取窗口上限与榜首之间（10,000）：既不是凭旧注释拍的数字，也不随上游漂移。
      const plain = await searchSkills({ query: '', source: 'clawhub', page: 1, pageSize: sz, cache });
      const windowMax = Math.max(...plain.items.map((i) => Number(i.downloads) || 0));
      check('clawhub 下载榜首条远高于未排序窗口 downloads max', top > Math.max(windowMax * 3, 10000), 'top=' + top + ' 窗口max=' + windowMax);
      check('clawhub 下载榜首条 > 400,000（实测榜首 self-improving-agent 494,474）', top > 400000, 'got ' + top);
    }
  } catch (e) { skip('clawhub absolute'); }
}

console.log('');
console.log('Test 4: browse.sh 全量本地排（479 条全量 = 真实全盘）');
{
  try {
    const r = await searchSkills({ query: '', source: 'browse.sh', page: 1, pageSize: sz, cache, sort: 'installCount' });
    const v = vals(r.items);
      // 旧断言只问「至少一条 >0」，把上游偶发空/降级响应直接判成失败（2026-11-19 实测 1 次假红；
  // 同刻上游健康：479 条 / 459 条非零）。改为：空响应 → SKIP（上游侧问题，非本仓库回归）；
  // 有数据 → 校验覆盖率（实测 459/479 ≈ 96%，门槛取保守的 50%）。
  if (!v.length) skip('browse.sh 目录为空（上游空响应，非数据回归）');
  else check('browse.sh installs 覆盖率过半', v.filter((x) => x > 0).length >= Math.ceil(v.length * 0.5), v.filter((x) => x > 0).length + '/' + v.length);
    check('browse.sh p1 单调', v.every((x, k, a) => k === 0 || a[k - 1] >= x), v.join(','));
  } catch (e) { skip('browse.sh'); }
}

console.log('');
console.log('Test 5: skillsmp 按安装数必须被诚实拒绝（保持上游序，不乱排）');
{
  try {
    // 基线必须双采样：单次比较把「上游两次抓取之间顺序漂移」也算成本仓库回归
    // （本轮实测：同一条 check 单跑三次两次全绿、门里一次红，正是这种抖动）。
    // 缓存会把漂移藏起来，所以三次请求各用独立 cache 目录。
    const mkSmp = (tag) => makeCache(path.join(safeTempDir(), 'dsh-smp-' + tag + '-' + Date.now()));
    const a = await searchSkills({ query: '', source: 'skillsmp', page: 1, pageSize: sz, cache: mkSmp('a'), sort: 'installCount' });
    const b = await searchSkills({ query: '', source: 'skillsmp', page: 1, pageSize: sz, cache: mkSmp('b'), sort: '' });
    const b2 = await searchSkills({ query: '', source: 'skillsmp', page: 1, pageSize: sz, cache: mkSmp('b2'), sort: '' });
    const smpKey = (r) => r.items.map((i) => i.id).join('|');
    // 空转绿灯修复：两侧都空时 '' === '' 恒真，会把「Cloudflare 挡住导致 skillsmp 一条都没有」
    // 判成「降级正确」。必须区分：空且 degraded 非空 = 上游不可达（SKIP）；
    // 空但无 degraded = handler 回归（FAIL）。有数据时比较表达式逐字不变。
    //
    // 单边降级同样无从判定（2026-11-22 21:4x 实测：4 轮里有 1 轮 a 超时回 0 条、
    // b 正常回 12 条，degraded=['skillsmp:来源响应超时（预算 12s），已跳过']，
    // 旧判据只看「两侧皆空」于是走进比较分支，把「这台机器此刻取不到 skillsmp」
    // 报成本仓库回归 —— 门内原文 FAIL installCount 被降级为不排序 a= | b=skillsmp:morluto…，
    // 以及 FAIL a 与基线条目集合一致 a=0 b=12）。降级是上游侧状态、不是排序语义，
    // 所以任一侧 degraded 非空即 SKIP 并如实打出名单；单边空但没降级仍是真回归。
    const dg = (r) => (r.degraded || []).map((d) => d.source + ':' + String(d.error || '')).join(',');
    if ((a.degraded && a.degraded.length) || (b.degraded && b.degraded.length)) {
      skip('skillsmp 取数降级（sort 侧 [' + dg(a) + '] / 基线侧 [' + dg(b) + ']），降级比较无从判定');
    } else if (!a.items.length && !b.items.length) {
      // 两侧皆空且都没降级：这是 handler 回归，绝不能落到 '' === '' 的比较上。
      check('skillsmp 返回空且无 degraded（handler 回归）', false, 'items=0 且 degraded=[]');
    } else if (smpKey(b) !== smpKey(b2)) {
      skip('skillsmp 上游序自身在漂（两次 sort 为空的结果不同），降级比较无从判定');
    } else if (!a.items.length || !b.items.length) {
      // 单边空、两侧都未降级 = 带 sort 的那一路自己丢了条目，真回归。
      check('单边为空且无 degraded（sort 路径回归）', false, 'a=' + a.items.length + ' b=' + b.items.length);
    } else {
      check('installCount 被降级为不排序', smpKey(a) === smpKey(b), 'a=' + smpKey(a).slice(0, 70) + ' | b=' + smpKey(b).slice(0, 70));
      const sa = new Set(a.items.map((i) => i.id));
      const sb = new Set(b.items.map((i) => i.id));
      check('a 与基线条目集合一致（没因 sort 走不同分支）', sa.size === sb.size && [...sa].every((x) => sb.has(x)), 'a=' + sa.size + ' b=' + sb.size);
    }
  } catch (e) { skip('skillsmp（Cloudflare）：' + String(e && e.message || e).slice(0, 60)); }
}

console.log('');
console.log('Test 6: 缓存中毒回归——同 cache 先 name 后默认，默认必须不被污染');
{
  const c2 = makeCache(path.join(safeTempDir(), 'dsh-fs2-' + Date.now()));
  try {
    const sorted = await searchSkills({ query: '', source: 'skillsmp', page: 1, pageSize: sz, cache: c2, sort: 'name' });
    const plain = await searchSkills({ query: '', source: 'skillsmp', page: 1, pageSize: sz, cache: c2, sort: '' });
    const fresh = await searchSkills({ query: '', source: 'skillsmp', page: 1, pageSize: sz, cache: makeCache(path.join(safeTempDir(), 'dsh-fs3-' + Date.now())), sort: '' });
    // 同上：三侧都为空的空转绿灯会掩盖污染回归。
    if (!plain.items.length && !fresh.items.length) {
      if (plain.degraded && plain.degraded.length) skip('skillsmp 不可达（degraded 非空），缓存污染比较无从判定');
      else check('skillsmp 返回空且无 degraded（handler 回归）', false, 'items=0 且 degraded=[]');
    } else {
      check('plain == fresh（未被 name 排序污染）', plain.items.map((i) => i.id).join('|') === fresh.items.map((i) => i.id).join('|'));
    }
  } catch (e) { skip('poisoning test（skillsmp 不可达）'); }
}

console.log('');
console.log('Test 7: 聚合模式（source=all）的排序不得被能力降级误杀');
{
  // 回归：supportsSort('all', ...) 恒 false → effectiveSort 被清空 → 聚合排序静默失效。
  // 聚合时 dispatcher 必须仍对合并结果排序（各 handler 也应收到 sort 以便取各自的头部条目）。
  //
  // 本段原先完全依赖真实上游：门里 59 套件并发时每个源各 12s 预算（sources.js:588
  // budgetMs=12000），一旦 skillhub/trusttools/lobehub/browse.sh 集体超时，只剩
  // skillsmp+modelscope 两个「上游确实没有安装量列」的源（实测 extras:951 installs:0、
  // modelscope 无 install_count），withData 必然为空 —— 于是把「这台机器此刻被压满」
  // 判成本仓库回归（2026-11-22 21:0x 门内实测：22 passed, 1 failed「aggregation sort
  // applied (nonzero installs exist) [0,0,0,0,0,0]」，同一改动单跑 22/0/4skip）。
  // searchSkills 本来就提供 handlers 注入点（sources.js:607 注释：fake handler 才能在
  // 没有网络、没有上游波动的情况下断言并发与顺序性质），排序语义属于 dispatcher，
  // 所以判据改走注入；真实上游那一层退到下面的 live 段，并补上「 answered 源全无
  // 安装量」这个原先缺失的 SKIP 分支。
  const mk = (src, vals) => ({
    source: src,
    items: vals.map((v, k) => ({ id: src + '-' + k, name: src + '-' + k, source: src, installs: v })),
    total: vals.length,
    totalPages: 1,
  });
  const aggHandlers = {
    // 故意把高值放在后面、两个源交错，本地不排就绝不可能单调
    'src-a': async () => mk('src-a', [5, 90, 7, 60]),
    'src-b': async () => mk('src-b', [42, 3, 77, 11]),
    // 上游确实没有安装量列的源：参与合并但不得把非零判据凑上
    'src-zero': async () => mk('src-zero', [0, 0]),
  };
  const inj = await searchSkills({ query: 'agent', source: 'all', page: 1, pageSize: 24, cache: null, sort: 'installCount', handlers: aggHandlers });
  const injVals = inj.items.map((i) => Number(i.installs) || 0);
  check('aggregation sort applied (nonzero installs exist)', injVals.filter((x) => x > 0).length > 0, injVals.join(','));
  const injData = injVals.filter((x) => x > 0);
  check('aggregation page monotonic over nonzero', injData.every((x, k, arr) => k === 0 || arr[k - 1] >= x), injData.join(','));
  check('dispatcher 合并后确实重排（注入序被打乱）', inj.items.map((i) => i.id).join('|') !== 'src-a-0|src-a-1|src-a-2|src-a-3|src-b-0|src-b-1|src-b-2|src-b-3|src-zero-0|src-zero-1', inj.items.map((i) => i.id).join('|'));
  check('零安装量源未被丢弃（合并完整性）', inj.items.length === 10 && inj.items.some((i) => i.source === 'src-zero'), 'n=' + inj.items.length);
  const injPlain = await searchSkills({ query: 'agent', source: 'all', page: 1, pageSize: 24, cache: null, sort: '', handlers: aggHandlers });
  check('sorted != plain（sort 真的改变了聚合序）', inj.items.map((i) => i.id).join('|') !== injPlain.items.map((i) => i.id).join('|'), injPlain.items.map((i) => i.installs).join(','));
  // 真实上游侧的聚合排序：只在「至少一个 answered 源带安装量」时才判，否则 SKIP。
  let merged = null, errored = false;
  try {
    const c4 = makeCache(path.join(safeTempDir(), 'dsh-agg-' + Date.now()));
    merged = await searchSkills({ query: 'agent', source: 'all', page: 1, pageSize: 24, cache: c4, sort: 'installCount' });
  } catch (e) { errored = true; }
  const answered = (merged && merged.items ? merged.items : []).filter((i) => !((merged.degraded || []).some((d) => d.source === i.source)));
  const liveVals = answered.map((i) => Number(i.installs) || 0);
  if (errored || !merged || !merged.items.length) { skip('aggregation（上游不可达）'); }
  else if (!liveVals.some((x) => x > 0)) {
    // 全部 answered 源都没有安装量数据 = 此刻只有 skillsmp/modelscope 这类无该列的源回话
    // （或被压满时其它源超时），不是排序回归；把降级名单如实打出来便于复核。
    skip('aggregation live：answered 源均无 installs 数据（degraded=' + (merged.degraded || []).map((d) => d.source).join(',') + '）');
  }
  else {
    check('aggregation live sort applied (nonzero installs exist)', liveVals.filter((x) => x > 0).length > 0, liveVals.slice(0, 6).join(','));
    const liveData = liveVals.filter((x) => x > 0);
    check('aggregation live page monotonic over nonzero', liveData.every((x, k, arr) => k === 0 || arr[k - 1] >= x), liveData.slice(0, 6).join(','));
  }
}
console.log('');
console.log(passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
process.exit(failed ? 1 : 0);



