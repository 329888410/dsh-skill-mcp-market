// Four more live sources, each following the reference implementation's own endpoint:
//   clawhub   — clawhub.ai/api/v1  (browse honours limit; search answers 10 rows per page)
//   trusttools— ai.trusttools.cn/api/skills/search (POST, item carries repo_url/repo_path)
//   LobeHub   — @lobehub/market-cli skills search/install (official CLI, 33万+ skills)
//   skillsmp  — skillsmp.com/api/skills (paged search; Cloudflare-fronted, needs the curl
//               transport because this process's own TLS fingerprint is refused)
//   modelscope— modelscope.cn/api/v1/dolphin/skills (PUT, PageNumber/PageSize + TotalCount)
// Every source here answers a real `page`: either the upstream pages, or a whole catalogue
// is fetched once and sliced locally. That is what makes「加载更多」actually extend the list.
import { getJsonEscalating, postJsonEscalating, pythonText } from "./http.js";
import { execFile } from "node:child_process";
const isWinCli = process.platform === "win32";
function cliRun(pkg, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const cmd = isWinCli
      ? [process.env.ComSpec || "cmd.exe", "/d", "/s", "/c", "npx -y " + pkg + " " + args.map((a) => JSON.stringify(a)).join(" ")]
      : ["npx", "-y", pkg, ...args];
    execFile(cmd[0], cmd.slice(1), { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(pkg + " CLI 失败：" + String((stderr || err.message || "")).slice(0, 160)));
      else resolve(String(stdout || ""));
    });
  });
}
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { skillMetaFromText } from "./frontmatter.js";
import { safeTempDir } from "./home.js";

const UA = { "User-Agent": "dsh-skill-mcp-market/0.9", accept: "application/json" };

async function getJson(url, timeoutMs = 15000) {
  const response = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

async function postJson(url, body, timeoutMs = 15000) {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...UA, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

/** Local page slice for sources whose upstream hands over a whole catalogue at once. */
function slice(rows, page, pageSize) {
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Number(pageSize) || 24);
  const all = Array.isArray(rows) ? rows : [];
  return { rows: all.slice((p - 1) * size, p * size), start: (p - 1) * size, size, all };
}

// ---------------------------------------------------------------- clawhub
// clawhub 的 fetch 在本机偶发瞬时中断（fetch failed），做一次网络重试，
// 避免把一次抖动当成「不可达」误导用户。
async function getJsonClawHub(url, attempt = 0) {
  try {
    // clawhub 的前端 CDN 对 Node 的 TLS/连接指纹时好时坏，所以走 fetch→curl→python 逐级降级。
    return await getJsonEscalating(url, { headers: UA, timeoutMs: 25000 });
  } catch (error) {
    if (attempt < 1 && /fetch failed|ETIMEDOUT|ECONNRESET|socket|network|timeout/i.test(String((error && error.message) || error))) {
      return getJsonClawHub(url, attempt + 1);
    }
    throw error;
  }
}

// clawhubCategoryOf —— 分类载体的实测顺序：raw.category → raw.categories[0] → raw.topics[0]。
// 2026-11-22 复测（getJsonEscalating 直打真实端点，各 50 行样本）：/api/v1/search 行上
// categories 非空 50/50（如 ["knowledge"]）、topics 键 0/50、category 键 0/50；
// /api/v1/skills（browse）行上 categories 非空 49/49、topics 非空 27/49、category 键 0。
// 0.5.138 当年只看三行样本得出「载体是 topics、上游无 category 键」，据此只读 topics，
// 于是两条路径都存在的 categories 被整个丢弃，面板分类 chip 对 clawhub 永不出现。
// 保留 raw.category 优先（上游今天不给，给了就是权威值，test-clawhub-quality Test 9 锁它）；
// topics 仍作兜底（browse 侧真有）。取首项是**近似**：面板的分类过滤只作用于当前页并用
// categoryNote 明说（sources.js 的本地过滤分支），所以近似不会伪装成服务端过滤。
export function clawhubCategoryOf(raw) {
  const direct = String((raw && raw.category) || "").trim();
  if (direct) return direct;
  const firstNonEmpty = (v) => {
    if (!Array.isArray(v)) return "";
    for (const t of v) {
      const s = String(t || "").trim().toLowerCase();
      if (s) return s;
    }
    return "";
  };
  return firstNonEmpty(raw && raw.categories) || firstNonEmpty(raw && raw.topics);
}

// clawhubIdOf —— clawhub 条目的**身份**是 ownerHandle/slug 对（2026-11-22 实测 219 行 =
// search 100 + browse 119：ownerHandle+slug 齐全 219/219，176 个 distinct 身份对、同键多形态 0）。
// 上游 raw.id 不是身份：57/100 是自带 "clawhub:" 前缀的不透明 id
//（clawhub:kd75kdbc9phg92p12av465mbf1820dqb），另 43/100 是跨源形态 skills-sh:google/skills/<slug>；
// browse 行 0/119 有 raw.id。旧 id 公式 `clawhub:${raw.id || reference || raw.slug}` 于是同时产出
// clawhub:clawhub:<opaque> 与 clawhub:skills-sh:… 两种形态，而 item.id 正是翻页去重键（client.js:822
// new Set(prev.map(x => x.id))）→ 同一技能跨 search/browse 被算成两条。
// install.reference 不参与身份判定：跨源行的 reference 是真安装路由（skills-sh:<owner>/<repo>/<path>，
// 必须原样留在 installRef），拿它的切段当身份会把卡片 owner 写成 "skills-sh:google" 这类错值
//（实测 43/100 行如此，且卡片直接显示它）。CLI 降级行只有字符串 owner（:226 造 {name,owner,…}
// 无 ownerHandle），回落 raw.owner；两段缺任一段就返回空串——宁可空也不造假 id。
// 身份 = owner/slug 对。owner 有两种上游形态：ownerHandle 字符串（219/219 行都有），
// 以及 owner 对象 {handle,displayName,image}（search 100 行里 57 行是对象）——
// 直接 String(对象) 会写出 "[object Object]"，必须先取 .handle。
function clawhubOwnerOf(raw) {
  if (!raw) return "";
  if (raw.ownerHandle) return String(raw.ownerHandle).trim();
  const o = raw.owner;
  if (typeof o === "string") return o.trim();
  return String((o && o.handle) || "").trim();
}
export function clawhubIdOf(raw) {
  const owner = clawhubOwnerOf(raw);
  const slug = String((raw && raw.slug) || "").trim();
  return owner && slug ? `${owner}/${slug}` : "";
}

function mapClawHubRows(rows, q, mode, limitOverride) {
  const limit = limitOverride ?? 24;
  const items = (Array.isArray(rows) ? rows : []).slice(0, limit).map((raw) => {
    const install = raw.install || {};
    const reference =
      String(install.reference || "").trim() ||
      (raw.ownerHandle && raw.slug ? `${raw.ownerHandle}/${raw.slug}` : "");
    return {
      // 身份缺段时回落安装路由，绝不产出空 id（旧写法在这里会写成 clawhub:undefined）。
      id: `clawhub:${clawhubIdOf(raw) || reference}`,
      slug: raw.slug || String(raw.displayName || "").toLowerCase(),
      name: raw.displayName || raw.name || raw.slug || reference,
      description: raw.summary || raw.description || "",
      source: "clawhub",
      sourceLabel: "clawhub",
      owner: clawhubOwnerOf(raw),
      homepage: `https://clawhub.ai${raw.canonicalUrl || `/${reference}`}`,
      upstreamUrl: "",
      installRef: reference,
      // 两个量各取各的上游字段，不再互相复制。实测同一行 stats 里 downloads=494,474、
      // installs=18,549 —— 相差 26 倍：旧写法把 installs 也写成 downloads，卡片上的
      // 「N 次安装」实际是下载数（与 skillhub 那处同类的数据错误）。
      // browse 端点的量在 stats.*，search 端点在顶层 raw.downloads；两处都要读。
      downloads: Number(raw.downloads ?? raw.stats?.downloads ?? raw.metrics?.rolling60DayInstalls ?? 0) || 0,
      // installs 只认真实 installs 字段；缺失或为 0 就保持 0 —— 面板对 0 不显示该段，
      // 宁可不显示也不显示错数（不回落到 downloads）。
      installs: Number(raw.installs ?? raw.stats?.installs ?? 0) || 0,
      category: clawhubCategoryOf(raw),
      // 排序键的展示字段必须与 getter **同源**，否则「排了但看起来没排」：
      // browse 行量在 stats.*；search 行（实测 21 键）stars/createdAt 只挂在 native.skill.* 里，
      // 顶层没有 stars/createdAt → 旧写法在 search 卡片上恒为 0，按 stars 排完看起来像没排。
      stars: Number(raw.stars ?? raw.stats?.stars ?? raw.native?.skill?.stats?.stars) || 0,
      createdAt: Number(raw.createdAt ?? raw.native?.skill?.createdAt) || 0,
      updatedAt: Number(raw.updatedAt ?? raw.metrics?.updatedAt) || 0,
      installable: Boolean(reference),
      // 搜索端点无分页；浏览端点支持 limit。让客户端据此决定「加载更多」是否可用
      paged: mode === "browse",
    };
  });
  return { source: "clawhub", items, total: items.length };
}

// clawhub search 端点的本地排序表（实测 q=react 首行 21 键：
//   canonicalUrl,displayName,downloads,featured,icon,install,links,metrics,native,official,
//   ownerHandle,publisher,score,slug,source,sourceIdentity,summary,trust,updatedAt,version,owner
// 支撑情况（同一批 10 行实测）：
//   downloadCount → 顶层 downloads（10/10，number）；search 行没有安装数字段，
//                   旧键名 installCount 属名实不符（同一数据在 browse 行才有 stats.installs）
//   updated      → 顶层 updatedAt（10/10，epoch ms）
//   newest       → native.skill.createdAt（仅 5/10 有 native；缺失行按 0 沉底）
//   stars        → native.skill.stats.stars（同上 5/10；顶层 stars/stats.stars 在 search 行上恒空，
//                  :99 那套 `raw.stars ?? raw.stats?.stars` 只对 browse 行有效）
//   trending     → 无字段支撑：score 是相关性分桶（除前两条外全等），metrics.rolling60DayInstalls
//                  稀疏近零 → 故意不提供 getter，保持上游序（矩阵与线路的这一格仍不一致，已上报 lead）。
export const CLAWHUB_SEARCH_SORT_GETTERS = {
  downloadCount: (r) => r.downloads ?? r.metrics?.rolling60DayInstalls,
  name: (r) => r.displayName || r.slug,
  updated: (r) => Number(r.updatedAt) || 0,
  newest: (r) => Number(r.native?.skill?.createdAt) || 0,
  stars: (r) => Number(r.native?.skill?.stats?.stars) || 0,
};

const CLAWHUB_CATALOG_KEY = "clawhub_catalog_v1";
const CLAWHUB_CATALOG_TTL = 6 * 3600 * 1000;

// 浏览端点每屏 50 条并带 nextCursor（JSON 字符串），顺着它累积成本地目录再按页切片：
// 这样第 2 页、第 20 页拿到的都是真正的新条目，而不是上游的第一屏。
async function extendClawHubCatalog(cache, need, sortBy = "") {
  const catKey = sortBy ? `${CLAWHUB_CATALOG_KEY}:${sortBy}` : CLAWHUB_CATALOG_KEY;
  let state = cache ? await cache.get(catKey, CLAWHUB_CATALOG_TTL) : undefined;
  if (!state || !Array.isArray(state.rows)) state = { rows: [], cursor: null, done: false };
  const seen = new Set(state.rows.map((raw) => clawhubIdOf(raw)));
  let guard = 0;
  while (!state.done && state.rows.length < need) {
    guard += 1;
    const cursor = state.cursor ? `&cursor=${encodeURIComponent(state.cursor)}` : "";
    const data = await getJsonClawHub(`https://clawhub.ai/api/v1/skills?limit=50${sortBy ? `&sort=${encodeURIComponent(sortBy)}` : ""}${cursor}`);
    const rows = Array.isArray(data.items) ? data.items : Array.isArray(data.results) ? data.results : [];
    for (const raw of rows) {
      const key = clawhubIdOf(raw);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      state.rows.push(raw);
    }
    const next = data.nextCursor || null;
    if (rows.length === 0 || !next || next === state.cursor) state.done = true;
    else state.cursor = next;
  }
  if (cache) await cache.put(catKey, state);
  return state;
}

export async function searchClawHub({ query = "", page = 1, pageSize = 24, cache, sort = "", fetchJson = getJsonClawHub }) {
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Math.min(50, Number(pageSize) || 24));
  const q = String(query || "").trim();
  // 同一 (query,page,size) 5 分钟内复用：clawhub 单次搜索取整个上游窗口再本地翻页。
  const cKey = `clawhub:search:${q.toLowerCase()}:${p}:${size}:${sort || ""}`;
  if (cache) {
    const hit = await cache.get(cKey, 5 * 60 * 1000);
    if (hit && Array.isArray(hit.items) && hit.items.length) return { ...hit, source: "clawhub" };
  }
  if (q) {
    // 上游 /api/v1/search 实测：顶层只有 results（无 total/count）；page 参数被忽略
    // （page=1 与 page=2 首两条是同一批）；limit 生效但 100 是硬上限（limit=150/200/
    // 300/500/1000 恒回 100 条），且 limit=10 的返回正好是 limit=100 的同序前缀。
    // 所以取数口径 = 单次请求整个 100 条窗口 + 本地翻页。旧实现按 page 并发打 1–6 个
    // 假分页请求再拼窗口，实测 total 在页码之间跳（page1=11、page2=10）、page≥2 全空。
    const WINDOW_CAP = 100;
    const wanted = Math.min(60, size * p);
    const searchUrl = `https://clawhub.ai/api/v1/search?q=${encodeURIComponent(q)}&limit=${WINDOW_CAP}`;
    let searchSettled = null;
    let searchFailure = null;
    try {
      searchSettled = await fetchJson(searchUrl);
    } catch (err) {
      searchFailure = err;
    }
    const settled = searchFailure ? [{ status: "rejected", reason: searchFailure }] : [{ status: "fulfilled", value: searchSettled }];
    if (settled.every((item) => item.status === "rejected")) {
      // Web API 全挂 → 官方 CLI 备用（表格文本按列解析；仅 Web 故障时启用）
      let cliRows = [];
      try {
        const text = await cliRun("clawhub", ["search", q, "--limit", String(wanted)]);
        cliRows = text.split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("npm") && !l.startsWith("🦞") && !l.startsWith("Usage:"))
          .map((l) => {
            const m = l.match(/^([\w-]+)\s+@([\w.-]+)\s+(.+?)\s+\d+ installs/);
            if (!m) return null;
            return { name: m[1], owner: m[2], displayName: m[3], slug: m[1] };
          })
          .filter(Boolean);
      } catch (cliErr) {
        throw new Error("clawhub Web API 与官方 CLI 均不可用：" + String((cliErr && cliErr.message) || cliErr).slice(0, 120));
      }
      if (cliRows.length) {
        const out = mapClawHubRows(cliRows, q, "search-cli", cliRows.length);
        out.total = cliRows.length;
        out.hasMore = false;
        out.hint = "clawhub Web API 不可达，结果来自官方 CLI（较慢）";
        if (cache && out.items && out.items.length) await cache.put(cKey, out);
        return out;
      }
      throw new Error("clawhub 搜索不可达（网络中断，已重试一次）");
    }
    const seen = new Set();
    const merged = [];
    for (const item of settled) {
      if (item.status !== "fulfilled") continue;
      const rows = Array.isArray(item.value?.results) ? item.value.results : Array.isArray(item.value?.items) ? item.value.items : [];
      for (const raw of rows) {
        const key = clawhubIdOf(raw) || String(raw.displayName ?? "");
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(raw);
      }
    }
    // 单源排序责任在 handler（dispatcher 只对多源聚合排序）：
  // search 端点的 URL 不接受 sort（实测只认 q/page/limit），所以只能在已取回的窗口内本地排。
  // getter 必须逐键有真实字段支撑，无支撑的键一律不给 getter → sortRawRows 原样返回上游序。
  sortRawRows(merged, sort, CLAWHUB_SEARCH_SORT_GETTERS);
  const slicedRows = merged.slice((p - 1) * size, p * size);
    const out = mapClawHubRows(slicedRows, q, "search", slicedRows.length);
    // wanted 现在只服务 CLI 降级（Web 端点不再分页）。
    const capped = merged.length >= WINDOW_CAP;
    out.total = capped ? undefined : merged.length;
    out.hasMore = capped ? p * size < WINDOW_CAP : p * size < merged.length;
    out.totalPages = capped ? undefined : Math.max(1, Math.ceil(merged.length / size));
    if (capped) out.hint = `clawhub 搜索上游单次最多回 ${WINDOW_CAP} 条且不报总数，再往后的结果需要换关键词继续找`;
    if (cache && out.items && out.items.length) await cache.put(cKey, out);
    // total/hasMore/totalPages/hint 全部在 cache.put 之前赋值（旧写法把
    // totalPages 排在 put 之后，缓存副本因此少一个字段）。
    return out;
  }
  // 浏览：上游 browse 端点支持服务端全盘排序（实测 sort=downloads 跨 cursor 全局单调，首条≈494k）。
  // 旧实现是「预载 N 条再本地排」——那是窗口近似，禁止；现在把 sort 透传给上游，
  // 沿 nextCursor 累积到当前页深度即可保证全局序正确。
  // 上游 sort 值实测：downloads/stars/newest/updated/trending/name 均服务端全盘排序；
  // installs 不单调（数据质量差）→ 该源只能用下载数排，因此键名如实叫 downloadCount，
  // 不再顶着「按安装数」的名字排下载数（名称必须与排序方法一致）。
  const browseSort = sort === "downloadCount" ? "downloads"
    : sort === "stars" ? "stars"
      : sort === "newest" ? "newest"
        : sort === "updated" ? "updated"
          : sort === "trending" ? "trending"
            : sort === "name" ? "name" : "";
  const need = Math.min(2000, size * (p + 2));
  const state = await extendClawHubCatalog(cache, need, browseSort);
  const rows = state.rows;
  const matched = rows.slice((p - 1) * size, p * size);
  const out = mapClawHubRows(matched, q, "browse", matched.length);
  if (!rows.length) out.hint = "clawhub 当前没有返回条目（可达，但列表为空）";
    // 总页数：只有真正耗尽游标（done=true）才报精确值；无界流必须诚实说「未知」，
    // 谎报一个下界（共 2 页）会让用户以为目录就这么大。客户端把 undefined 当未知 → 窗口式分页。
    if (state.done) {
      out.total = rows.length;
      out.totalPages = Math.max(1, Math.ceil(rows.length / size));
    } else {
      out.total = undefined;
      out.totalPages = undefined;
    }
  out.hasMore = p * size < rows.length || (!state.done && rows.length >= p * size);
  if (cache && out.items && out.items.length) await cache.put(cKey, out);
  return out;
}


/** Background-warm the clawhub cursor catalogue up to 3000 rows (~125 pages).
 *  Called from warmMarketCache so the first panel open is fast; later pages
 *  just slice from the already-accumulated rows. */

/**
 * 全局排序的分页契约：必须在**切页之前**排序，否则每页各自有序、页与页之间无序。
 * 之前 dispatcher 在 handler 切完页后才排序，导致「按安装数」跨页错乱（实测第2页 max > 第1页 max）。
 * 所有 handler 在自己 slice 之前调用本函数。
 */
/**
 * 就地排序原始上游行。getters 把排序键映射到该源的行字段——
 * 排序键与卡片展示字段一一对应（sortKeyOf 的 handler 侧同族），杜绝「排了但看起来没排」。
 * name 升序（localeCompare），其余降序；未提供 getter 的键不动（保持上游序）。
 */
export function sortRawRows(rows, sort, getters = {}) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const key = String(sort || "");
  const g = getters[key];
  if (!g) return rows;
  if (key === "name") {
    return rows.sort((a, b) => String(g(a) || "").localeCompare(String(g(b) || "")));
  }
  return rows.sort((a, b) => (Number(g(b)) || 0) - (Number(g(a)) || 0));
}
export async function warmClawHubCatalog(cache, options = {}) {
  // clawhub 的 browse 目录是 28k+ 且游标不封顶的流：上游既不返回 total，也永远爬不完。
  // 所以这里只预热一个**有界预算**（默认 1200 行 ≈ 50 页），换来首页之后几十页秒开；
  // 总页数因此是「共约」下界而不是精确值——这是上游能力边界，不是本地缺陷。
  const budget = Math.max(50, Number(options.budget) || 1200);
  const state0 = cache ? await cache.get(CLAWHUB_CATALOG_KEY, CLAWHUB_CATALOG_TTL) : undefined;
  const seen = new Set((state0?.rows || []).map((raw) => clawhubIdOf(raw)));
  const rows = [...(state0?.rows || [])];
  let cursor = state0?.cursor || null;
  let done = state0?.done || false;

  let consecutiveErrors = 0;
  while (!done && rows.length < budget && consecutiveErrors < 3) {
    const qs = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    try {
      const data = await getJsonClawHub(`https://clawhub.ai/api/v1/skills?limit=50${qs}`);
      const batch = Array.isArray(data.items) ? data.items : Array.isArray(data.results) ? data.results : [];
      for (const raw of batch) {
        const key = clawhubIdOf(raw);
        if (key && !seen.has(key)) { seen.add(key); rows.push(raw); }
      }
      const next = data.nextCursor || null;
      if (!batch.length || !next || next === cursor) { done = true; break; }
      cursor = next;
      consecutiveErrors = 0;
    } catch {
      consecutiveErrors++;
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
  }
  // 预算用满但游标未尽：done 保持 false，让分页器显示「共约」。
  if (cache) await cache.put(CLAWHUB_CATALOG_KEY, { rows, cursor, done });
  return { rows, done, budget };
}

export async function searchTrustTools({ query = "", page = 1, pageSize = 24, cache, sort = "" } = {}) {
  // trusttools ignores `pageSize` and always answers with 10 rows per page, so a page of 24
  // needs three upstream pages stitched together (pages are disjoint, verified).
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Math.min(60, Number(pageSize) || 24));
  const perPage = 10;
  // 上游有隐藏的服务端全盘排序端点 GET /api/skills?sort_by=install_count&direction=desc
  // （实测首条 ui-ux-pro-max≈446,924，跨页全局单调；POST /search 的 sort 参数全部被忽略）。
  // 旧实现是「取 60 页窗口本地排」——对 579,074 条全量属于近似，禁止。
  // name 排序上游返回空数组（坏），故 name 仍走窗口 + 本地排。
  const serverSort = sort === "installCount";
  const sortMode = sort === "name";
  // serverSort：上游 GET 端点固定 10 条/页且全局有序。面板第 p 页需要第 [(p-1)*size, p*size)
  // 条，对应上游页 floor((p-1)*size/10)+1 .. ceil(p*size/10)，取回后按偏移量本地切。
  const first = serverSort
    ? Math.floor(((p - 1) * size) / perPage) + 1
    : sortMode ? 1 : (p - 1) * Math.ceil(size / perPage) + 1;
  const lastUpstream = serverSort
    ? Math.ceil((p * size) / perPage)
    : first + (sortMode ? 60 : Math.ceil(size / perPage)) - 1;
  const perBatch = Math.max(1, lastUpstream - first + 1);
  const sliceOffset = serverSort ? (p - 1) * size - (first - 1) * perPage : 0;
  const rows = [];
  const seen = new Set();
  let total = 0;
  for (let index = 0; index < perBatch; index += 1) {
    const upstreamPage = first + index;
    const key = `trusttools:${String(query).trim().toLowerCase()}:${upstreamPage}:${sort || ""}`;
    let data = cache ? await cache.get(key, 10 * 60 * 1000) : undefined;
    if (!data) {
      if (serverSort) {
        // GET 端点固定 10 条/页（实测 pageSize 参数被忽略），排序由服务端对全量做
        const qs = new URLSearchParams({ sort_by: "install_count", direction: "desc", page: String(upstreamPage), pageSize: String(perPage) });
        if (String(query || "").trim()) qs.set("search", String(query).trim());
        data = await getJsonEscalating(`https://ai.trusttools.cn/api/skills?${qs.toString()}`, { timeoutMs: 25000 });
      } else {
        data = await postJsonEscalating(
          "https://ai.trusttools.cn/api/skills/search",
          // 上游参数名是 search（不是 q）：传 q 会被忽略，永远返回默认列表。实测 search 才生效。
          { search: query, page: upstreamPage, pageSize: perPage },
          { timeoutMs: 25000 },
        );
      }
      if (cache) await cache.put(key, data);
    }
    const batch = Array.isArray(data.data) ? data.data : [];
    if (data.pagination && Number(data.pagination.total) > 0) total = Number(data.pagination.total);
    let added = 0;
    for (const raw of batch) {
      const id = String(raw.id ?? raw.slug ?? raw.name ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      rows.push(raw);
      added += 1;
    }
    if (batch.length === 0 || added === 0) break; // catalogue exhausted or the page repeats
  }
  // 切页前排序：否则每页各自有序、跨页错乱
  // installCount 由服务端全盘排序，不再本地重排（本地重排会打乱服务端的全量序）
  sortRawRows(rows, sortMode ? sort : "", { name: (r) => r.name || r.slug });
  // 排序模式下窗口从第 1 页起，本地切出第 p 页；否则上游已给对页
  const pageRows = serverSort
    ? rows.slice(sliceOffset, sliceOffset + size)
    : sortMode
      ? rows.slice((p - 1) * size, p * size)
      : rows.slice(0, size);
  const items = pageRows.map((raw) => {
    const repo = String(raw.repo_url || "").replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
    const path = String(raw.repo_path || "").replace(/\/SKILL\.md$/i, "");
    return {
      id: `trusttools:${raw.id}`,
      slug: raw.slug || raw.name,
      name: raw.name || raw.slug,
      description: raw.description_zh || raw.description || raw.short_description || "",
      source: "trusttools",
      sourceLabel: "TrustTools",
      owner: repo,
      homepage: repo ? `https://github.com/${repo}` : "",
      upstreamUrl: repo,
      ref: raw.branch || "main",
      skillDir: path,
      stars: Number(raw.stars || 0),
      // 上游 sort_by=install_count 与 install_count 字段都是真实安装量 → 名称与字段一致；
      // 去掉 || raw.download_count 回落，避免用下载数冒充安装数。
      installs: Number(raw.install_count || 0),
      downloads: Number(raw.download_count || 0),
      security: raw.security_level || "",
      tags: Array.isArray(raw.tags) ? raw.tags : [],
      category: (Array.isArray(raw.tags) && raw.tags[0]) || "",
      installable: Boolean(repo && path),
    };
  });
  const known = total || 0;
  return {
    source: "trusttools",
    items,
    total: known,
    hasMore: known ? p * size < known : items.length >= size,
  };
}

// ---------------------------------------------------------------- LobeHub Skills Marketplace
// LobeHub's Skills Marketplace (33万+ skills) is accessed via the official CLI:
//   search:  npx -y @lobehub/market-cli skills search --q "<query>" --page <n> --page-size <n> --output json
//   install: npx -y @lobehub/market-cli skills install <identifier> --dir <path>
// The CLI auto-downloads via npx; no pre-install or authentication required.
// `view` requires a token and is not used.
// 矩阵键 → skills 子命令 --sort 词表（实测词表见上，2026-11-19 用 4 次 CLI 探测确认）。
// installCount/stars/name 两侧同名且实测 exit0；newest/updated 必须改名；
// 其余（trending/relevance…）不在词表 → 返回空串表示「不传 --sort」。
const LOBEHUB_SKILLS_SORT_MAP = {
  installCount: "installCount",
  stars: "stars",
  name: "name",
  newest: "createdAt",
  updated: "updatedAt",
};

/** 该源请求的排序键映射成上游 CLI 认识的键；词表外返回 ""（保持上游默认序）。 */
export function lobehubSkillSortArg(sort) {
  return LOBEHUB_SKILLS_SORT_MAP[String(sort || "").trim()] || "";
}

// skills 行的实测字段（24/24 齐全）：
//   author,category,commentCount,createdAt,description,github,homepage,icon,identifier,
//   installCount,isFeatured,isOfficial,isValidated,license,name,ratingAvg,ratingCount,
//   resourcesCount,updatedAt,version
// 键名取映射后的上游 --sort 值，createdAt/updatedAt 实测是 "MM/DD/YYYY HH:mm:ss" 本地串，
// Number() 会读成 NaN → 必须 Date.parse（该格式在 V8 下可解析）。
export const LOBEHUB_SKILL_SORT_GETTERS = {
  installCount: (r) => r.installCount ?? r.downloads ?? r.installs,
  name: (r) => r.name || r.identifier,
  createdAt: (r) => Date.parse(r.createdAt) || 0,
  updatedAt: (r) => Date.parse(r.updatedAt) || 0,
  // 上游按 stars 排，但**行内没有 stars 字段**（实测），旧的 (r) => r.stars 恒 undefined
  // → 本地兜底排不动。用同向的 ratingCount（缺失再退 ratingAvg）代替，不假装 r.stars 存在。
  stars: (r) => Number(r.ratingCount ?? r.ratingAvg) || 0,
};

/** 是否有本地兜底（决定 sortRawRows 是否执行）。矩阵键与映射后的上游键都接受。 */
export function lobehubSkillLocalSortApplies(sort) {
  const raw = String(sort || "").trim();
  const key = LOBEHUB_SKILLS_SORT_MAP[raw] || raw;
  return typeof LOBEHUB_SKILL_SORT_GETTERS[key] === "function";
}

export async function searchLobeHubSkills({ query = "", page = 1, pageSize = 24, cache, sort = "" }) {
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Number(pageSize) || 24);
  const sortKey = String(sort || "").trim();
  // 实测（勿凭旧注释）：CLI --sort installCount --order desc 是服务端全盘排序，
  // p1 min(2295) ≥ p2 max(2235)，跨页全局单调。旧注释「跨页仍无序」是错的，
  // 旧实现 sortMode 下反而不传 --sort、退化成 50 条窗口近似——已纠正：始终透传 --sort。
  //
  // 但透传前必须映射：skills 子命令的 --sort 只认
  //   createdAt|stars|installCount|name|relevance|ratingAverage|commentCount|updatedAt
  // 旧实现把矩阵键原样塞进 CLI，newest/updated 不在词表 → CLI exit 1
  // "Search failed: Bad Request" → sources.js 的 catch 把整个 lobehub 记进 degraded，
  // 用户看到的不是「排序没生效」而是 lobehub 贡献 0 条（整源消失）。
  const sortArg = lobehubSkillSortArg(sortKey);
  const fetchPage = p;
  const fetchSize = size;
  const cacheKey = `lobehub_skills_search:${query.trim()}:${sortKey}:${fetchPage}:${fetchSize}`;
  const cached = cache ? await cache.get(cacheKey, 30 * 60 * 1000) : undefined;
  if (cached) return { source: "lobehub", ...cached };

  const { npxRun } = await import("./cli-install.js");
  // Empty query: omit --q entirely (the CLI treats an empty-string arg as a
  // positional and rejects it: "too many arguments for 'search'").
  const q = String(query || "").trim();
  const args = ["skills", "search"];
  if (q) args.push("--q", q);
  // installCount/stars/name 原样透传（实测 exit0）；newest/updated 见上映射；
  // 词表外的键（如 trending）→ sortArg 为空 → 不传 --sort，保持上游默认序，绝不冒整源消失的风险。
  if (sortArg) args.push("--sort", sortArg);
  if (sortArg) args.push("--order", "desc");
  args.push("--page", String(fetchPage), "--page-size", String(fetchSize), "--output", "json");
  // First npx run auto-downloads the CLI (~30 s); subsequent runs are cached.
  // 180 s covers the worst-case cold start without hanging the UI.
  const stdout = await npxRun("@lobehub/market-cli", args, { timeoutMs: 180000 });
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("lobehub search: CLI returned non-JSON output");
  }
  const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
  // 服务端已按请求排序（实测全局单调）；这里只做防御性校验排序，不改变服务端序——
  // 若 CLI 未按请求排序（版本差异），本地兜底仍保证单调。
  // 实测兜底是必要的：单页 installCount 序列出现 …,1982,1901,1905,1873,…（上游排序偏软）。
  // getter 的键名必须与**映射后**的上游键一致，否则 newest/updated 那两行永远是死代码。
  const sortMode = lobehubSkillLocalSortApplies(sortArg);
  if (sortMode) sortRawRows(rawItems, sortArg, LOBEHUB_SKILL_SORT_GETTERS);
  const pageItems = rawItems;
  const items = pageItems.map((raw) => ({
    id: `lobehub:${raw.identifier || ""}`,
    slug: raw.name || raw.identifier || "",
    name: raw.name || raw.identifier || "",
    description: raw.description || "",
    source: "lobehub",
    sourceLabel: "LobeHub 技能市场",
    owner: raw.author || "",
    homepage: raw.homepage || "",
    upstreamUrl: "",
    reference: raw.identifier || "",
    category: raw.category || "",
    tags: [],
    installCount: Number(raw.installCount || 0),
    // 面板读 item.installs；LobeHub 上游字段叫 installCount，补映射让卡片与「按安装数」排序有数。
    installs: Number(raw.installCount || 0),
    rating: Number(raw.ratingAverage || 0),
    installable: Boolean(raw.identifier),
    note: "通过官方 CLI 安装 LobeHub 技能",
  }));
  const total = Number(parsed.totalCount || 0);
  const result = {
    source: "lobehub",
    items,
    total,
    hasMore: total ? p * size < total : items.length >= size,
  };
  if (cache) await cache.put(cacheKey, result);
  return result;
}

/**
 * Install a LobeHub skill via the official CLI.
 * `npx -y @lobehub/market-cli skills install <identifier> --dir <tmpDir>`
 * The CLI extracts the skill into <tmpDir>/<identifier>/ (SKILL.md + references/).
 * Returns { name, description, files } in the same shape the old agent-JSON path produced,
 * so callers in skills.js can use it unchanged.
 */
export async function lobehubAgentSkill(identifier) {
  if (!identifier) throw new Error("lobehub skill install requires an identifier");
  const { npxRun } = await import("./cli-install.js");
  const tmpRoot = await mkdtemp(join(safeTempDir(), "dsh-lobehub-"));
  const targetDir = join(tmpRoot, identifier);
  try {
    await npxRun("@lobehub/market-cli", ["skills", "install", identifier, "--dir", tmpRoot], {
      timeoutMs: 120000,
    });
    if (!existsSync(targetDir)) {
      throw new Error(`lobehub CLI did not produce a skill directory at ${targetDir}`);
    }
    // Walk the installed directory and collect all files.
    const files = {};
    const walk = async (current, prefix) => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = join(current, entry.name);
        if (entry.isDirectory()) await walk(full, relative);
        else files[relative] = await readFile(full, "utf8");
      }
    };
    await walk(targetDir, "");
    const skillText = files["SKILL.md"] || "";
    const meta = skillMetaFromText(skillText, identifier);
    if (!meta.name || !meta.description) {
      throw new Error("lobehub skill SKILL.md 缺少 name 或 description frontmatter");
    }
    return { name: meta.name, description: meta.description, files };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- skillsmp
// skillsmp.com answers 403 "Just a moment…" to this process's fetch/https but 200 to the
// curl transport (see src/http.js): the edge fingerprints the TLS client, not the headers.
// The payload is `{ skills: [...], pagination: {...}, filters: {...} }`; every row carries the exact
// GitHub location, so an install is a plain repo+skillDir download. The numbers in pagination are
// a moving target — measured live 2026-11-22: a browse page answers total 1200 (the site's own hero
// counts 4,248,026 SKILL.md files) with totalIsExact:false plus isCapped/maxResults; a search page
// answers page*limit+1 with totalIsExact:false; only an exhausted search answers totalIsExact:true.
// 分类 facet 另有两个口径（全部 2026-11-22 走 getJsonEscalating/python 实测，回归见 test-skillsmp-search.mjs）：
//   · 带 facet 时 pagination.total 恒 480 —— limit=8/24/48 下 totalPages 60/20/10，乘积都是 480，
//     10 个不同分类与 2 个 occupation 全报同一个 480。那是窗口深度，不是该分类的条数。
//   · 同一响应里上游另自报 pagination.totalAll = 该面真实条数：category=debugging → 532411、
//     category=cli-tools → 21484、occupation=software-developers → 1124877。language=zh 与纯浏览态不给该字段，
//     此时总数照旧不报。所以判据是先看窗口再看精确，total 取 totalAll，页数只能取窗口页深。
//   · facet 与 search 不能同时用：search=pdf total=7，加 category=ide-plugins 仍报 7，但首 6 条与不带 facet
//     的结果重叠 0/6 —— 上游忽略 facet 且静默换成另一个集合。带关键词时一律不发 facet。
//   · /zh/categories 页面 75 个分类锚：63 个带条数徽标（可浏览面，词表就是这 63 个），12 个只有板块
//     标题（浏览工具/业务开发/…）没有徽标——它们发给 legacy 一律 HTTP 400
//     body {"success":false,"error":{"code":"INVALID_CATEGORY",...}}（tools、business、data-ai、databases 在内）。
//     63 个里 62 个逐个 GET 实测被接受（test/fixtures/skillsmp-category-vocab.json 记全部 slug+中文标签+条数），
//     documents 那一轮探针超时（可浏览性未知，不是被拒）。没有公开的编目端点可查，所以运行时必须保留 400 兜底。
// 其余判据（search= 键、limit 上界）同样以那组实测为准，注释只写复核过的事实。
const SKILLSMP_TTL = 10 * 60 * 1000;
// limit 上界不是推测值：上游自己把边界写在错误体里。交错重放 4 轮（48/49/40/50 交替，排除
// 「请求次数触发 Cloudflare 挑战」这一混淆项）原文：limit=48 → HTTP 200 n=48（4/4 轮），
// limit=49 与 limit=50 → HTTP 400 Bad Request，body =
//   {"error":"Invalid limit; expected one integer between 1 and 48",...}（4/4 轮同形）；
// 44/45/46/47 另经 getJsonEscalating（插件真实取数路径）逐个实测 n=limit。
// 注意：裸 fetch 对这些请求拿到的是 403「Just a moment...」挑战页，那不是上游对 limit 的答复，
// 所以取证必须走 getJsonEscalating/python 传输。旧实现钳到 50 = 每页宽 48~50 的请求都会被拒。
const SKILLSMP_MAX_LIMIT = 48;
const SKILLSMP_UNBOUNDED_NOTE = "skillsmp 搜索窗口会随翻页移动，上游未报总数时不给数字";
// 分类词表：面板的「按分类浏览」入口只能来自 /zh/categories 这份 HTML（编目端点 10 个候选实测全部
// ENDPOINT_NOT_FOUND），所以这里解析页面锚点，抓取走 pythonText（同一 Cloudflare 指纹门槛）。
// 词表 TTL 取 7 天：判据不是「上游多久改版」，而是「面板宁可退回页内派生 chip，也不长期贴一份旧词表」。
const SKILLSMP_CATEGORIES_URL = "https://skillsmp.com/zh/categories";
const SKILLSMP_VOCAB_KEY = "skillsmp_categories_v1";
const SKILLSMP_VOCAB_TTL = 7 * 24 * 3600 * 1000;

/**
 * /zh/categories → [{slug,name,totalAll}]。只认「带条数徽标的分类卡锚」：板块标题锚形如
 * <span>浏览工具</span> 且无 <bdi>，不是可浏览面（发上游必回 400）。锚体很长（实测 806~1139 字符），
 * 所以窗口取 1400——取 600 时首轮只回来 12 条板块头，那是判据没跑起来而不是页面没有分类。
 */
export function parseSkillsMpCategories(html) {
  const text = String(html || "");
  const out = [];
  const seen = new Set();
  const re = /<a\s[\s\S]{0,1400}?href="(?:\/[^"\/]+)?\/categories\/([a-z0-9][a-z0-9-]*)"[\s\S]{0,1400}?<\/a>/g;
  let m;
  while ((m = re.exec(text))) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    const body = text.slice(m.index, text.indexOf("</a>", m.index) + 4);
    const strip = (s) => String(s || "")
      .replace(/<[^>]*>/g, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, "\"")
      .replace(/&amp;/g, "&")
      .replace(/&nbsp;/g, " ")
      .trim();
    const name = strip((body.match(/<span[^>]*>([\s\S]*?)<\/span>/) || [])[1]);
    const countRaw = strip((body.match(/<bdi>([\s\S]*?)<\/bdi>/) || [])[1]);
    const totalAll = Number(countRaw.replace(/[^0-9]/g, "")) || 0;
    if (!name || /^浏览/.test(name) || totalAll <= 0) continue;
    out.push({ slug, name, totalAll });
  }
  return out;
}

/** 抓词表并落缓存。抓不到/解析不出 → null（空词表与没有词表是两回事，见回归套件）。 */
export async function skillsmpCategoryVocabulary({ cache, getText = pythonText, now = Date.now } = {}) {
  if (!cache) return null;
  const at = Number(typeof now === "function" ? now() : now) || Date.now();
  try {
    const hit = await cache.get(SKILLSMP_VOCAB_KEY, SKILLSMP_VOCAB_TTL);
    // 新旧由 capturedAt 判，而不是 makeCache 的内部时钟：注入 now 才能确定性地测出「过期重取」。
    if (hit && Array.isArray(hit.categories) && hit.categories.length
      && at - Number(hit.capturedAt) < SKILLSMP_VOCAB_TTL) return hit;
  } catch {
    // 缓存读失败只意味着这次要重取
  }
  let html = "";
  try {
    const r = await getText(SKILLSMP_CATEGORIES_URL, {
      headers: { referer: "https://skillsmp.com/" },
      timeoutMs: 20000,
    });
    html = typeof r === "string" ? r : String((r && r.text) || "");
  } catch {
    return null;
  }
  const categories = parseSkillsMpCategories(html);
  // 0 条 = 页面改版，不是「这站没有分类」：不许落成空快照（那会把面板已有的派生 chip 一起关掉）。
  if (!categories.length) return null;
  const value = { capturedAt: at, source: SKILLSMP_CATEGORIES_URL, categories };
  await cache.put(SKILLSMP_VOCAB_KEY, value);
  return value;
}

/** 只读缓存：settings.get 用它，绝不在此处等网络。没有/过期都回 null。 */
export async function readSkillsMpCategoryVocabulary({ cache, now = Date.now } = {}) {
  if (!cache) return null;
  const at = Number(typeof now === "function" ? now() : now) || Date.now();
  try {
    const hit = await cache.get(SKILLSMP_VOCAB_KEY, SKILLSMP_VOCAB_TTL);
    if (!hit || !Array.isArray(hit.categories) || !hit.categories.length) return null;
    if (at - Number(hit.capturedAt) >= SKILLSMP_VOCAB_TTL) return null;
    return hit;
  } catch {
    return null;
  }
}

function skillsmpTarget(raw) {
  const route = raw.route || {};
  const url = String(raw.githubUrl || "");
  const tree = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/i);
  const branch = String(raw.branch || (tree ? tree[3] : "") || "main");
  let skillDir = String(route.sourceSkillPath || "").replace(/\/?SKILL\.md$/i, "");
  if (!skillDir && tree) skillDir = tree[4];
  const repo = tree ? `${tree[1]}/${tree[2]}` : "";
  return { repo, branch, skillDir };
}

  // 搜索参数与总数口径的回归测试：test/test-skillsmp-search.mjs。
  // 抓取方法与 searchClawHub 同构：把 json 抓取注入成参数，确定性测试才不用真打 skillsmp。
  // 默认值保持线上行为：Cloudflare 按 TLS 指纹拦抢，只有 CPython urllib 能过。
export async function searchSkillsMp({ query = "", page = 1, pageSize = 24, cache, sort = "", category = "", fetchJson = getJsonEscalating }) {
  const q = String(query || "").trim();
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Math.min(SKILLSMP_MAX_LIMIT, Number(pageSize) || 24));
  // facet 是服务端过滤，缓存键必须带上它；带关键词时上游会忽略 facet 并静默换集合（见上），
  // 所以 facet 只在纯浏览态生效。
  const facet = q ? "" : String(category || "").trim().toLowerCase();
  const key = `skillsmp:${q || "all"}:${facet || "any"}:${p}:${size}:${sort || ""}`;
  const cached = cache ? await cache.get(key, SKILLSMP_TTL) : undefined;
  if (cached && Array.isArray(cached.items) && cached.items.length) return { ...cached, source: "skillsmp" };
  // 实测：/api/skills 只认 search。q、keyword、query 一律被忽略（data.filters 只在真键生效时
  // 回显 {"search":...}），所以别不要再把别名当「兜底」一起发——那样面板会以为搜过了，实际拿的是全库首页。
  const params = new URLSearchParams({ page: String(p), limit: String(size) });
  if (q) params.set("search", q);
  // sortBy 实测服务端全盘生效且跨页单调（p1 最小 updatedAt 等于 p2 最大 = 1795140060），
  // 所以这两个键交给上游，绝不再在本页重排——本页重排会把服务端的全盘序打乱。
  if (sort === "stars") params.set("sortBy", "stars");
  else if (sort === "updated") params.set("sortBy", "recent");
  if (facet) params.set("category", facet);
  const options = {
    headers: { referer: "https://skillsmp.com/" },
    timeoutMs: 20000,
    // 唯一需要 python 的站点：Cloudflare 按 TLS 指纹拦截，fetch/curl 均 403，只有 CPython urllib 能过。
    pythonFirst: true,
  };
  let data;
  let facetUsed = facet;
  let facetRefused = false;
  const refusedNote = `skillsmp 不接受分类「${facet}」（上游回 400 INVALID_CATEGORY），已按全部分类返回这一页`;
  try {
    data = await fetchJson(`https://skillsmp.com/api/skills?${params.toString()}`, options);
  } catch (err) {
    // 页面 63 个可浏览 slug 里 62 个实测被 legacy 接受，板块标题与 documents（探针超时、可浏览性未知）不保证。词表只能从页面解析，
    // 无法运行时预知，所以被拒时去掉 facet 重发一次：宁可给全库首页并说明，也不许整源进 degraded。
    if (!facet) throw err;
    params.delete("category");
    data = await fetchJson(`https://skillsmp.com/api/skills?${params.toString()}`, options);
    facetRefused = true;
    facetUsed = "";
  }
  const rows = Array.isArray(data.skills) ? data.skills : [];
  // name 没有对应的服务端 sort 键，只能本页升序（本页不是全盘，口径由聚合层给 note）；stars/updated 已交上游。
  sortRawRows(rows, sort, { name: (r) => r.name ?? r.skillName });
  const items = rows.slice(0, size).map((raw) => {
    const { repo, branch, skillDir } = skillsmpTarget(raw);
    return {
      id: `skillsmp:${raw.id || raw.name}`,
      slug: raw.name || String(raw.id || ""),
      name: raw.name || String(raw.id || ""),
      description: raw.description || "",
      source: "skillsmp",
      sourceLabel: "skillsmp",
      owner: raw.author || "",
      homepage: raw.githubUrl || "",
      // parseRepoRef understands `owner/repo@ref`, so the branch rides along here.
      upstreamUrl: repo ? `${repo}@${branch}` : "",
      skillDir,
      ref: branch,
      // 实测 stars/forks 是仓库真实值（plain 首行 stars=469982、sortBy=recent 首行 1602，forks 同理）；
      // 同一仓库的多个技能共用该仓库 star 数是上游口径，不是占位符，照实透出。
      stars: Number(raw.stars) || 0,
      // 行上没有任何分类字段（实测 16 键里没有 category/topics/tags），分类只能来自本次浏览的 facet，
      // 由请求侧回填；facet 被上游拒绝时不回填，绝不给卡片安一个上游没承认的分类。
      category: facetUsed,
      installable: Boolean(repo),
    };
  });
  // Upstream decides what counts as a total, not this function. Measured shapes:
  //   browse             total 1200 + totalIsExact:false + isCapped:true + maxResults:1200 -> window cap
  //   facet browse       total 480 + isCapped:true + maxResults:480 + totalAll -> 窗口深度与真实条数是两个数
  //   search, unfinished total = page*limit+1 + totalIsExact:false -> a lower bound that moves per page
  //   search, exhausted  totalIsExact:true -> that number IS the full match set
  const pg = data.pagination || {};
  const upstreamTotal = Number(pg.total);
  const upstreamAll = Number(pg.totalAll);
  // 先窗口后精确：capped 态里那个 total 是窗口深度（facet 态恒 480），拿它当总数就是谎报目录条数。
  const windowed = pg.isCapped === true || pg.maxResults !== undefined || pg.totalIsExact === false;
  const exactTotal = !windowed && pg.totalIsExact === true && Number.isFinite(upstreamTotal);
  let total;
  let hasMore;
  let totalPages;
  let hint;
  if (exactTotal) {
    total = upstreamTotal;
    hasMore = Boolean(pg.hasNext);
    totalPages = Number(pg.totalPages) || (total ? Math.max(1, Math.ceil(total / size)) : 1);
  } else if (windowed) {
    // Leave the count unknown instead of presenting a window as the catalogue, and say why on the
    // hint channel (sources.js:598 collects hints, client.js renders them as one notice line).
    hasMore = typeof pg.hasNext === "boolean" ? pg.hasNext : undefined;
    // A number is nameable only when upstream states the window size itself (maxResults) or the real
    // size of that facet (totalAll). A bare totalIsExact:false ships a value that moves every page,
    // so quoting it would be this function inventing a figure upstream never stated.
    const window = Number(pg.maxResults) || 0;
    if (Number.isFinite(upstreamAll)) {
      total = upstreamAll;
      const depth = window > 0 ? Math.max(1, Math.ceil(window / size)) : Number(pg.totalPages) || 1;
      totalPages = depth;
      if (pg.hasNext === false) hasMore = false;
      hint = `skillsmp 该分类目录共 ${upstreamAll} 条（上游自报 totalAll），可浏览窗口只有 ${window} 条即 ${depth} 页 × ${size} 条，`;
      hint += `第 ${depth} 页之后取不到也不计数，换关键词或换分类能继续往里走`;
    } else if (window === 0) {
      // 只有「连窗口多大都不知道」才需要那句话。窗口自报过 maxResults 时不再对用户念
      // 科普（用户 2026-11-23 点名那条说明已失效）：总数与页数照旧留未知（上面不赋
      // total/totalPages 就是这个意思），只是不解释——面板的分类 chip 各自带上游 totalAll，
      // 「继续往里走」早就不止「换关键词」一条路，那句出路本身已经不成立。
      hint = SKILLSMP_UNBOUNDED_NOTE;
    }
    if (facetRefused) hint = refusedNote;
  } else {
    // No pagination block at all: still unknown, and no fabricated lower bound.
    hasMore = items.length === size;
    hint = facetRefused ? refusedNote : SKILLSMP_UNBOUNDED_NOTE;
  }
  // serverFacet 是给聚合层的声明：facet 确实作为服务端参数发了出去、且没有被 400 拒回，
  // 这一页才是「上游已按分类筛过的集合」。聚合层只有收到 true 才敢关掉本地过滤——谎报等于
  // 把首屏那一页说成整目录已筛过（带关键词时 facet 根本不发，所以必为 false）。
  const serverFacet = facet !== "" && !facetRefused;
  const payload = { source: "skillsmp", items, total, hasMore, totalPages, serverFacet, facetUsed };
  if (hint) payload.hint = hint;
  // An empty page is never cached: one upstream hiccup must not blank the market for ten
  // minutes, and the next request should retry immediately.
  if (cache && items.length) await cache.put(key, payload);
  return payload;
}


// ---------------------------------------------------------------- ModelScope
// PUT https://modelscope.cn/api/v1/dolphin/skills {PageNumber,PageSize,Query?} → Data.SkillList,
// Data.TotalCount（实测 88k+ 条、页与页不重复）。技能正文挂在 SourceURL 的 GitHub 地址上。
const MODELSCOPE_SKILLS_URL = "https://modelscope.cn/api/v1/dolphin/skills";

// 矩阵（sort-capability.js:31）对 modelscope 声称 installCount/stars/newest/updated/name。
// 上游没有任何服务端 sort，所以「支持」= 全量拉取后本地排。少一个键进全量分支，
// 就是那一键只在单页内有序（跨页错乱），即「声称支持、线路不生效」。
// 与 MODELSCOPE_SORT_GETTERS 同步：ModelScope 上游只有 DownloadCount（下载数），没有安装量列。
// 全量排分派表必须认这个键，否则 downloadCount 退回单页分支 —— 正是本套件头部写的
// 「缺陷2」形态（只对一页排序、跨页错乱）。
export const MODELSCOPE_FULL_SORT_KEYS = ["downloadCount", "stars", "newest", "updated", "name"];

/** 该排序键是否需要全量拉取 + 本地排 + 切页；false = 保持上游分页（快，一次调用）。 */
export function modelScopeSortMode(sort) {
  return MODELSCOPE_FULL_SORT_KEYS.includes(String(sort || "").trim());
}

// 排序键 → 上游行字段（实测列名）：DownloadCount / SourceStar|Likes / GmtCreate / GmtModify|LastSyncTime / DisplayName|Name
// 注意 DownloadCount 是下载数不是安装数（该源上游没有安装量列），所以键名叫 downloadCount ——
// 旧名 installCount 会让卡片显示「N 次安装」而数字其实是下载数。
export const MODELSCOPE_SORT_GETTERS = {
  downloadCount: (r) => r.DownloadCount,
  stars: (r) => r.SourceStar ?? r.Likes,
  newest: (r) => Date.parse(r.GmtCreate) || Number(r.GmtCreate) || 0,
  updated: (r) => Date.parse(r.GmtModify || r.LastSyncTime) || 0,
  name: (r) => r.DisplayName || r.Name,
};

export async function searchModelScope({ query = "", page = 1, pageSize = 24, cache, sort = "" } = {}) {
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Math.min(50, Number(pageSize) || 24));
  const q = String(query || "").trim();
  // 上游无 sort（实测 9 种参数名全部被忽略），但 PageSize 可到 20000（实测）。
  // 排序模式 = 全量拉取（88,993 条 ÷ 20000 = 5 次调用，缓存 6h）后在完整集合上本地排 + 切页。
  // 旧实现取 500 条窗口本地排——对全量属于近似，禁止。
  //
  // 旧 sortMode 只认 installCount/name，于是矩阵 :31 声称支持的 stars/newest/updated
  // 落到「单页分支」：只取一页 → 只对这一页排 → 用户看到「按星级」却跨页错乱。
  // 现在 5 个键一律走全量分支。代价（明确记账）：这 3 个键从「单页快但错」变成
  // 「首次慢（5000×9 全量拉取，实测约 30–90 s）后正确」；fullKey 缓存 6h，翻页只是切片。
  const sortMode = modelScopeSortMode(sort);
  // 非排序模式：保持上游分页（快，一次调用）。
  // 排序模式：上游无服务端 sort，必须拉全量（88,993 ÷ 20000 ≈ 5 次）在完整集合上排。
  const cacheKey = `modelscope:search:${q.toLowerCase()}:${p}:${size}:${sort || ''}`;
  const hit = cache ? await cache.get(cacheKey, 5 * 60 * 1000) : undefined;
  if (hit) return { ...hit, source: "modelscope" };
  const fetchOne = async (pageNumber, pageSize, timeoutMs = 25000) => {
    const response = await fetch(MODELSCOPE_SKILLS_URL, {
      method: "PUT",
      headers: { ...UA, "content-type": "application/json" },
      body: JSON.stringify({ PageNumber: pageNumber, PageSize: pageSize, ...(q ? { Query: q } : {}) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`ModelScope HTTP ${response.status}`);
    const payload = await response.json();
    const data = payload.Data || {};
    return { rows: Array.isArray(data.SkillList) ? data.SkillList : [], total: Number(data.TotalCount) || 0 };
  };
  let rows = [];
  let total = 0;
  if (sortMode) {
    // 全量目录缓存 6 小时：排序是对完整集合做的，翻页只是切片，不再重复拉取。
    const fullKey = `modelscope:full:${q.toLowerCase()}`;
    const fullHit = cache ? await cache.get(fullKey, 6 * 3600 * 1000) : undefined;
    if (fullHit && Array.isArray(fullHit.rows)) {
      rows = fullHit.rows;
      total = fullHit.total || rows.length;
    } else {
      // 上游分页深度上限实测为 offset≈45,000（PageSize=20000 时 page2 即空；
      // PageSize=5000 时 page9 有数据、page10 空）。按 5000×9 拉取上游可达的全部行。
      const MS_PAGE = 5000;
      const MS_MAX_PAGES = 9;
      const first = await fetchOne(1, MS_PAGE, 90000);
      rows = first.rows;
      total = first.total;
      // 注意边界：pagesNeeded 是**需要的页数**，循环必须含它（旧写法 pg < pagesNeeded
      // 少拉最后一页，实测差一整页 5000 条 ≈ 可达集合的 11%，与上面注释「5000×9」自相矛盾，
      // 排序集合因此并非声称的「上游可返回的全部行」）。空页仍由 break 兜住。
      const pagesNeeded = Math.min(MS_MAX_PAGES, Math.ceil(Math.min(total || 1, MS_PAGE * MS_MAX_PAGES) / MS_PAGE));
      for (let pg = 2; pg <= pagesNeeded; pg += 1) {
        try {
          const nx = await fetchOne(pg, MS_PAGE, 90000);
          if (!nx.rows.length) break;
          rows = rows.concat(nx.rows);
        } catch {
          break; // partial catalogue is still far better than a 500-row window
        }
      }
      if (cache && rows.length) await cache.put(fullKey, { rows, total });
    }
  } else {
    const one = await fetchOne(p, size);
    rows = one.rows;
    total = one.total;
  }
  const usableRows = rows.filter((raw) => raw && raw.Name);
  // 上游分页深度上限（实测 offset≈45k）导致可达集合 < 全量时，如实告知用户排序覆盖范围。
  const msDepthHint = sortMode && total > rows.length
    ? `ModelScope 上游分页深度上限约 ${rows.length.toLocaleString()} 条（目录共 ${total.toLocaleString()} 条），排序覆盖上游可返回的全部行`
    : "";
  sortRawRows(usableRows, sort, MODELSCOPE_SORT_GETTERS);
  const pageRows = sortMode ? usableRows.slice((p - 1) * size, p * size) : usableRows;
  const items = pageRows.map((raw) => {
    const owner = raw.Path || raw.Owner || "";
    const name = raw.Name || "";
    const ident = owner ? `${owner}/${name}` : name;
    const source = String(raw.SourceURL || "");
    const gh = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/(?:blob|tree)\/([^/]+)\/(.+)$/i.exec(source);
    const repo = gh ? `${gh[1]}/${gh[2]}` : "";
    const branch = gh ? gh[3] : "main";
    const skillDir = gh ? gh[4].replace(/\/?SKILL\.md$/i, "") : "";
    return {
      id: `modelscope:${ident}`,
      slug: name,
      name: raw.DisplayName || name,
      description: raw.Description || raw.DescriptionEn || "",
      category: raw.L1 && typeof raw.L1 === "object" ? raw.L1.ChineseName || "" : "",
      source: "modelscope",
      sourceLabel: "ModelScope",
      owner,
      homepage: source || `https://modelscope.cn/skills/${ident}`,
      upstreamUrl: repo ? `${repo}@${branch}` : "",
      ref: branch,
      skillDir,
      downloads: Number(raw.DownloadCount || 0),
      // 该源上游无安装量列：installs 保持 0（面板不显示），不把下载数冒充安装数。
      // 注：此前行被多缩进两个空格（771 行），一并修正。
      installs: 0,
      // 展示字段与 MODELSCOPE_SORT_GETTERS 同源（stars=SourceStar|Likes，时间戳同 :665-668 的读法）：
      // 此前 modelscope 卡片不带这几个字段，「按星级/按最新」排完在界面上无从核验。
      // 字段名沿用 clawhub 的既有约定（:100-101 的 createdAt/updatedAt），不另造新名。
      stars: Number(raw.SourceStar ?? raw.Likes) || 0,
      // 兼容两种上游格式（epoch ms 或日期串，实测未定）：先 Date.parse 再退 Number，
      // 与 MODELSCOPE_SORT_GETTERS 同一读法，避免「卡片显示 0 但确实按时间排了」。
      createdAt: Number(Date.parse(raw.GmtCreate) || raw.GmtCreate) || 0,
      updatedAt: Number(Date.parse(raw.GmtModify || raw.LastSyncTime) || raw.GmtModify) || 0,
      tags: Array.isArray(raw.Tags) ? raw.Tags : [],
      installable: true,
      modelScopeIdent: ident,
    };
  });
  const result = { source: "modelscope", items, total: total || p * size + (rows.length >= size ? 1 : 0), hasMore: total ? p * size < total : rows.length >= size, ...(msDepthHint ? { hint: msDepthHint } : {}) };
  if (cache) await cache.put(cacheKey, result);
  return result;
}

/**
 * Download a ModelScope skill via the official ZIP endpoint:
 *   https://modelscope.cn/skills/<owner>/<name>/archive/zip/master
 * The ZIP contains a single top-level directory (e.g. `skills-owner.name-master-<sha>/`)
 * with SKILL.md inside. Returns { name, description, files } in the same shape as
 * lobehubAgentSkill, so callers in skills.js can use it unchanged.
 */
export async function modelScopeSkill(ident) {
  if (!ident) throw new Error("modelscope skill install requires an ident (owner/name)");
  const { readZip, stripCommonPrefix, locateSkillRoot } = await import("./zip.js");
  const { pythonDownload } = await import("./http.js");
  const url = `https://modelscope.cn/skills/${encodeURIComponent(ident)}/archive/zip/master`;
  let buffer;
  try {
    const response = await fetch(url, {
      headers: { ...UA, accept: "application/zip, application/octet-stream" },
      signal: AbortSignal.timeout(60000),
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    buffer = Buffer.from(await response.arrayBuffer());
  } catch {
    // Fall back to the Python transport (honours the system proxy):
    const { mkdtemp } = await import("node:fs/promises");
    const { join: jp } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const tmp = await mkdtemp(jp(safeTempDir(), "dsh-ms-zip-"));
    const target = jp(tmp, "skill.zip");
    try {
      await pythonDownload(url, target, { timeoutMs: 60000 });
      const { readFile: rf } = await import("node:fs/promises");
      buffer = await rf(target);
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }
  const { files: raw } = readZip(buffer);
  const flat = stripCommonPrefix(raw);
  const root = locateSkillRoot(flat);
  if (root === null) throw new Error("ModelScope ZIP 里没有找到 SKILL.md");
  const prefix = root ? `${root}/` : "";
  const files = {};
  for (const [entry, content] of Object.entries(flat)) {
    if (prefix && !entry.startsWith(prefix)) continue;
    files[entry.slice(prefix.length)] = content;
  }
  const skillText = files["SKILL.md"] || "";
  const meta = skillMetaFromText(skillText, ident);
  if (!meta.name || !meta.description) {
    throw new Error("ModelScope skill SKILL.md 缺少 name 或 description frontmatter");
  }
  return { name: meta.name, description: meta.description, files };
}

/**
 * Download a ModelScope skill via its GitHub upstream (when the search API
 * returned an `upstreamUrl` such as `owner/repo@branch` + `skillDir`).
 * Uses the shared `downloadSkillDir` from github.js — the same fast path
 * skills.sh and skillsmp use. Returns { name, description, files } in
 * the same shape as modelScopeSkill, so callers in skills.js are unchanged.
 *
 * Throws when the GitHub download fails so the caller can fall back to
 * the official ZIP endpoint (modelScopeSkill).
 */
export async function modelScopeGitHubSkill(upstreamUrl, skillDir, ident) {
  if (!upstreamUrl) throw new Error("modelscope GitHub fast path requires an upstreamUrl (owner/repo@branch)");
  const { downloadSkillDir, parseRepoRef } = await import("./github.js");
  const { mkdir, rm, mkdtemp, readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join: jp } = await import("node:path");

  const parsed = parseRepoRef(upstreamUrl);
  const repo = parsed.repo;
  const ref = parsed.ref || "main";

  const tmp = await mkdtemp(jp(safeTempDir(), "dsh-ms-gh-"));
  try {
    await mkdir(jp(tmp, "skill"), { recursive: true });
    const { files: written, skillText, skipped } = await downloadSkillDir({
      repo,
      ref,
      skillDir: skillDir || "",
      destDir: jp(tmp, "skill"),
    });
    if (!written.length || !skillText) {
      throw new Error(`ModelScope GitHub download produced no files for ${repo}@${ref}${skillDir ? "/" + skillDir : ""}`);
    }
    // Collect the in-memory file map so skills.js can use the same writeSkill path.
    const files = {};
    for (const rel of written) {
      const { readFile: rf } = await import("node:fs/promises");
      files[rel] = await rf(jp(tmp, "skill", rel), "utf8");
    }
    const meta = skillMetaFromText(files["SKILL.md"] || "", ident);
    if (!meta.name || !meta.description) {
      throw new Error("ModelScope skill SKILL.md 缺少 name 或 description frontmatter");
    }
    return { name: meta.name, description: meta.description, files };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Resolve a clawhub reference (`owner/slug`) to its GitHub-backed skill directory.
 *
 * Two strategies, tried in order:
 *   1. HTML scrape — fetch the clawhub.ai detail page and regex-extract the GitHub
 *      repo URL. Fast when the page structure still carries a bare github.com link.
 *   2. Search API — fall back to `clawhub.ai/api/v1/search?q=<slug>` and read the
 *      structured `links.source` field from the matching result.  Works even when
 *      the HTML page no longer embeds a raw GitHub URL (the 2026-11 failure mode).
 *
 * Returns `{ repo, skillDir, apiFallback }` — `apiFallback` is true when the
 * structured API supplied the repo instead of the HTML scrape.
 * If neither strategy finds a GitHub source, throws an Error whose message
 * includes the detail-page URL so the client can offer a "open in browser" fallback.
 */
export async function clawhubResolve(reference) {
  const [owner, slug] = String(reference || "").split("/");
  if (!owner || !slug) throw new Error("clawhub 引用格式应为 owner/slug");

  // Strategy 1: HTML scrape (original path, may fail if page structure changed).
  let htmlMatch = null;
  try {
    const page = await (await fetch(`https://clawhub.ai/${owner}/skills/${slug}`, {
      headers: UA,
      signal: AbortSignal.timeout(15000),
    })).text();
    htmlMatch = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)(?:\/tree\/[\w.-]+\/([\w./-]+))?/.exec(page);
  } catch {
    // Network hiccup — fall through to API.
  }
  if (htmlMatch) return { repo: htmlMatch[1], skillDir: htmlMatch[2] || "", apiFallback: false };

  // Strategy 2: Search API (structured, resilient to HTML changes).
  try {
    const results = await getJsonClawHub(
      `https://clawhub.ai/api/v1/search?q=${encodeURIComponent(slug)}&page=1&limit=20`,
    );
    const rows = Array.isArray(results) ? results : results?.results || [];
    const hit = rows.find(
      (r) => r?.ownerHandle === owner && r?.slug === slug,
    ) || rows.find((r) => {
      const ref = r?.install?.reference || "";
      return ref === `${owner}/${slug}`;
    });
    if (hit) {
      // links.source carries the GitHub repo URL when the skill has one.
      const sourceUrl =
        hit.links?.source ||
        hit.install?.sourceUrl ||
        hit.upstreamUrl ||
        "";
      if (sourceUrl) {
        const m = /github\.com\/([\w.-]+\/[\w.-]+)(?:\/tree\/[\w.-]+\/([\w./-]+))?/.exec(sourceUrl);
        if (m) return { repo: m[1], skillDir: m[2] || "", apiFallback: true };
      }
      // Some entries carry the repo under native.skill or sourceIdentity.
      const repoField =
        hit.native?.skill?.repoUrl ||
        hit.sourceIdentity?.repo ||
        hit.native?.repo ||
        "";
      if (repoField) {
        return { repo: String(repoField).replace(/^github\.com\//, "").replace(/^https?:\/\/github\.com\//, ""), skillDir: "", apiFallback: true };
      }
    }
  } catch {
    // API also unreachable — fall through to the error below.
  }

  const detailUrl = `https://clawhub.ai/${owner}/skills/${slug}`;
  throw new Error(
    `clawhub 页面与 API 里都没有找到 GitHub 源仓库（${detailUrl}）——可直接在浏览器中打开该页查看详情`,
  );
}
