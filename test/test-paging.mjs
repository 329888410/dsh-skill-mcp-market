// 逐个源验证「下一页」真的取到不同的条目（而不是重复第一页）。
import { safeTempDir } from "../src/home.js";
import { makeCache, searchSkills, ALL_SOURCES, skillsShCatalog } from "../src/sources.js";
import { overlapVerdict, emptyPageAction } from "./paging-verdict.mjs";

const cache = makeCache(safeTempDir());
const pageSize = 12;
let failures = 0;
let checks = 0;

function ids(rows) {
  return (rows || []).map((x) => x.id);
}

console.log("预热 skills.sh sitemap 目录…");
const t0 = Date.now();
const cat = await skillsShCatalog(cache);
console.log(`目录 ${cat.length} 条，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

for (const source of ALL_SOURCES) {
  const started = Date.now();
  try {
    const p1 = await searchSkills({ query: "", source, page: 1, pageSize, cache });
    let p2 = await searchSkills({ query: "", source, page: 2, pageSize, cache });
    // 空第 2 页有两种可能：上游瞬时故障（实测 trusttools 一次 p1=12/p2=0，复测三次
    // 都是 12/12）或 page/offset 真算错。判据交给 emptyPageAction：允许重试一次，
    // 重试后仍空必须 FAIL —— 否则分页回归会被「上游偶尔坏」永久掩盖。
    let epAttempt = 1;
    if (emptyPageAction({ p1: p1.items.length, p2: p2.items.length, total: p1.total, hasMore: p1.hasMore, attempt: epAttempt }).verdict === 'retry') {
      await new Promise((rr) => setTimeout(rr, 1500));
      p2 = await searchSkills({ query: "", source, page: 2, pageSize, cache });
      epAttempt = 2;
    }
    const ep = emptyPageAction({ p1: p1.items.length, p2: p2.items.length, total: p1.total, hasMore: p1.hasMore, attempt: epAttempt });
    const a = ids(p1.items);
    const b = ids(p2.items);
    const overlap = b.filter((id) => a.includes(id));
    // 判据与 test-nocache 共用同一个 helper（overlapVerdict），不再写「恰好 1 条且
    // 落在边界」这种魔法阈值：本轮实测 skillhub 默认榜重叠一次 2、一次 7，阈值 1
    // 会把上游重排判成本仓库回归（gate14 里 test-paging 变红的正是这条）。
    // 整页重复仍然 fail —— 那才是 page 参数被忽略，是我们的回归，绝不放宽。
    let sortedOverlap;
    if (source === 'skillhub' && overlap.length > 0) {
      const s1 = await searchSkills({ query: '', source, page: 1, pageSize, cache, sort: 'installCount' });
      const s2 = await searchSkills({ query: '', source, page: 2, pageSize, cache, sort: 'installCount' });
      const idsS = new Set(ids(s1.items));
      sortedOverlap = ids(s2.items).filter((id) => idsS.has(id)).length;
    }
    const vd = overlapVerdict({ source, overlap: overlap.length, pageCount: a.length, sortedOverlap });
    const boundaryDrift = vd.verdict === 'skip';
    // 上游整体不可达（degraded 命中）与「分页窗口算错」是两件事：前者是外部状态，
    // 后者才是本仓库回归。2026-11-20 实测 ai.trusttools.cn 直接 fetch 失败（10.7s），
    // 记成 FAIL 会把上游宕机算到我们头上（同 0.5.110 修的误红）。
    const unreachable = Array.isArray(p1.degraded) && p1.degraded.some((d) => d.source === source);
    const empty = p1.items.length === 0 && b.length === 0 && unreachable;
    const ok = empty || (p1.items.length > 0 && ep.verdict === 'ok' && vd.verdict !== 'fail');
    checks += 1;
    if (!ok) failures += 1;
    console.log(
      `${ok ? (empty ? "SKIP" : "OK  ") : "FAIL"} ${source.padEnd(14)} p1=${String(a.length).padStart(2)} p2=${String(b.length).padStart(2)} ` +
        `overlap=${overlap.length}${boundaryDrift ? "(边界漂移)" : ""} total=${p1.total} pages=${p1.pages} hasMore=${p1.hasMore} ` +
        `${((Date.now() - started) / 1000).toFixed(1)}s` +
        (empty ? " 上游不可达（外部状态，非回归）" : "") + (p1.hint ? ` hint=${p1.hint.slice(0, 40)}` : ""),
    );
    if (!ok) {
      console.log(`     p1=${a.slice(0, 3).join(" | ")}`);
      console.log(`     p2=${b.slice(0, 3).join(" | ")}`);
    }
  } catch (e) {
    checks += 1;
    failures += 1;
    console.log(`FAIL ${source.padEnd(14)} ${String(e.message || e).slice(0, 160)}`);
  }
}

// 聚合源也要能翻页
const all1 = await searchSkills({ query: "", source: "all", page: 1, pageSize, cache });
const all2 = await searchSkills({ query: "", source: "all", page: 2, pageSize, cache });
const dup = ids(all2.items).filter((id) => ids(all1.items).includes(id));
console.log(`\nall: p1=${all1.items.length} p2=${all2.items.length} overlap=${dup.length} hasMore=${all1.hasMore} total=${all1.total}`);
checks += 1;
if (all2.items.length === 0) failures += 1;

// 关键词搜索也翻页（skills.sh 搜索 API 没有 offset，靠 depth 切片）
const q1 = await searchSkills({ query: "agent", source: "skills.sh", page: 1, pageSize, cache });
const q2 = await searchSkills({ query: "agent", source: "skills.sh", page: 2, pageSize, cache });
const qd = ids(q2.items).filter((id) => ids(q1.items).includes(id));
console.log(`skills.sh 搜索 agent: p1=${q1.items.length} p2=${q2.items.length} overlap=${qd.length} hasMore=${q1.hasMore}`);
checks += 1;
if (q1.items.length === 0 || q2.items.length === 0 || qd.length > 0) failures += 1;

// MCP 官方注册表：cursor 分页 —— 连续三页零重叠、缓存命中后仍能翻、越界页为空
{
  const { searchMcpRegistryPage, REGISTRY_PAGE_SIZE } = await import("../src/mcp-registry.js");
  const pageIds = [];
  let hasMoreAt3 = false;
  for (const page of [1, 2, 3]) {
    const r = await searchMcpRegistryPage({ query: "", page, pageSize: REGISTRY_PAGE_SIZE, cache });
    pageIds.push(ids(r.items));
    if (page === 3) hasMoreAt3 = r.hasMore;
  }
  const overlaps = pageIds.flatMap((list, i) => (i === 0 ? [] : list.filter((id) => pageIds.slice(0, i).flat().includes(id))));
  const okSizes = pageIds.every((list) => list.length === REGISTRY_PAGE_SIZE);
  console.log(`\nregistry(\u5b98\u65b9\u6ce8\u518c\u8868) p1/p2/p3 = ${pageIds.map((l) => l.length).join("/")} overlap=${overlaps.length} hasMore@p3=${hasMoreAt3}`);
  checks += 1;
  if (!okSizes || overlaps.length > 0) failures += 1;

  // 缓存命中后（第二次读 p1）仍然要能翻页：cursor 必须随缓存一起保存
  const again1 = await searchMcpRegistryPage({ query: "", page: 1, pageSize: REGISTRY_PAGE_SIZE, cache });
  const again2 = await searchMcpRegistryPage({ query: "", page: 2, pageSize: REGISTRY_PAGE_SIZE, cache });
  const cachedOverlap = ids(again2.items).filter((id) => ids(again1.items).includes(id));
  const cachedOk = ids(again1.items).join() === pageIds[0].join() && ids(again2.items).join() === pageIds[1].join();
  console.log(`registry \u7f13\u5b58\u547d\u4e2d p1/p2 \u4e0e\u9996\u6b21\u4e00\u81f4=${cachedOk} overlap=${cachedOverlap.length}`);
  checks += 1;
  if (!cachedOk || cachedOverlap.length > 0) failures += 1;

  const beyond = await searchMcpRegistryPage({ query: "", page: 9999, pageSize: REGISTRY_PAGE_SIZE, cache });
  console.log(`registry \u8d8a\u754c\u9875 9999 \u2014 ${beyond.items.length} \u6761, hasMore=${beyond.hasMore}`);
  checks += 1;
  if (beyond.items.length !== 0 || beyond.hasMore) failures += 1;
}

console.log(failures === 0 ? "\nALL PAGING CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
// run-gate 契约：最后一行必须是「N passed, M failed」，否则判 NO-SUMMARY（闸门宁缺毋滥）。
console.log(`${checks - failures} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
