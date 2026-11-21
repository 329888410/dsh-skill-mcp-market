// Live online sources only. No bundled catalog: every list comes from an upstream
// that is reachable right now, and every install resolves its content live.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { searchSkills as searchSkillHub } from "./skillhub.js";
import { enrichPageDescriptions, enrichSkillsShFast } from "./enrich.js";
import { supportsSort as capabilitySupports, sortKeysFor } from "./sort-capability.js";
import {
  searchClawHub,
  warmClawHubCatalog,
  searchLobeHubSkills,
  searchModelScope,
  searchSkillsMp,
  searchTrustTools,
} from "./extra-sources.js";
import { safeTempDir } from "./home.js";

const UA = { "User-Agent": "dsh-skill-mcp-market/0.3 (+skill and mcp market)", accept: "application/json" };

async function fetchText(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: UA, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ disk cache
export function makeCache(dir) {
  const memory = new Map();
  return {
    async get(key, ttlMs) {
      const hit = memory.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return hit.value;
      const file = join(dir, `${key.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
      if (!existsSync(file)) return undefined;
      try {
        const stored = JSON.parse(await readFile(file, "utf8"));
        if (Date.now() - stored.at > ttlMs) return undefined;
        memory.set(key, stored);
        return stored.value;
      } catch {
        return undefined;
      }
    },
    async put(key, value) {
      const entry = { at: Date.now(), value };
      memory.set(key, entry);
      try {
        const file = join(dir, `${key.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(entry), "utf8");
      } catch {
        // cache is best-effort
      }
    },
  };
}

// ------------------------------------------------------------------ skills.sh
// 首页只挂了约 48 条精选；真正的目录在 sitemap（sitemap-skills-1/-2.xml，合计约 2 万条）。
// 把整份目录缓存一天、再本地切片，「加载更多」才可能翻到第 49 条之后的技能。
const SKILLS_SH_SITEMAP = "https://www.skills.sh/sitemap.xml";
const SKILLS_SH_CATALOG_KEY = "skills_sh_catalog_v2";
const SKILLS_SH_CATALOG_TTL = 24 * 3600 * 1000;
const SKILLS_SH_URL_RE = /^https?:\/\/(?:www\.)?skills\.sh\/([^/]+)\/([^/]+)\/([^/]+)\/?$/i;

/** skills.sh 的列表接口没有简介字段：读不到 SKILL.md 时给一句诚实的兜底，卡片才不会空着。 */
function fillMissingDescriptions(items) {
  for (const item of items || []) {
    if (item.description) continue;
    const where = item.owner ? `${item.owner} ` : "";
    item.description = `${where}收录于 skills.sh 的技能；上游未提供简介，安装后会读取它的 SKILL.md`;
  }
}

/** 本地分页切片：上游没有 page 参数的源都靠它实现真正的翻页。 */
// 补描述是「锦上添花」：上游每个技能要一次网络往返，整屏补完可能十几秒。
// 给一个总预算，超时就先把卡片发出去（描述留空/通用文案），绝不让面板等着转圈。
const DESCRIPTION_BUDGET_MS = 9000;

async function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function pageSlice(rows, page, pageSize) {
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Number(pageSize) || 24);
  return (Array.isArray(rows) ? rows : []).slice((p - 1) * size, p * size);
}

function skillsShCard(row) {
  const owner = row.owner;
  const slug = row.slug;
  return {
    id: `skills.sh:${owner}/${slug}`,
    slug,
    name: slug,
    description: "",
    source: "skills.sh",
    sourceLabel: "skills.sh",
    owner,
    homepage: `https://www.skills.sh/${owner}/${slug}`,
    upstreamUrl: owner,
    skillDir: "",
    // 安装需要「仓库 + --skill 名」：owner 是网站路径（可能是 owner/repo），
    // 真正的 GitHub 仓库与技能名由 skills.sh 详情页里的 `npx skills add` 命令解析得出。
    // 这里先给出页面地址，resolveSkillsShInstall 会读取它并解析。
    installRef: `https://www.skills.sh/${owner}/${slug}`,
    installs: 0,
    installable: true,
  };
}

/** 走 sitemap 取全量目录（首次约 1 分钟，之后一天内直接读缓存）。 */
export async function skillsShCatalog(cache) {
  const cached = cache ? await cache.get(SKILLS_SH_CATALOG_KEY, SKILLS_SH_CATALOG_TTL) : undefined;
  if (Array.isArray(cached) && cached.length > 0) return cached;
  const index = await fetchText(SKILLS_SH_SITEMAP, 30000);
  const shards = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((m) => m[1])
    .filter((url) => /sitemap-skills-\d+\.xml$/i.test(url));
  const settled = await Promise.allSettled(shards.map((shard) => fetchText(shard, 180000)));
  const out = [];
  const seen = new Set();
  for (const item of settled) {
    if (item.status !== "fulfilled") continue;
    for (const match of String(item.value).matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const hit = SKILLS_SH_URL_RE.exec(match[1]);
      if (!hit) continue;
      const key = `${hit[1]}/${hit[2]}/${hit[3]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ owner: `${hit[1]}/${hit[2]}`, slug: hit[3] });
    }
  }
  if (out.length > 0 && cache) await cache.put(SKILLS_SH_CATALOG_KEY, out);
  return out;
}

/** 首页推荐的约 48 条：全量目录还没就绪时的兜底，保证首屏不空白。 */
async function skillsShHighlights(cache) {
  const cached = cache ? await cache.get("skills_sh_home", 30 * 60 * 1000) : undefined;
  if (Array.isArray(cached) && cached.length > 0) return cached;
  const html = await fetchText("https://www.skills.sh/", 25000);
  const seen = new Set();
  const rows = [];
  for (const match of html.matchAll(/\/([A-Za-z0-9_.-]+)\/skills\/([A-Za-z0-9_.-]+)/g)) {
    const key = `${match[1]}/${match[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ owner: `${match[1]}/skills`, slug: match[2] });
  }
  if (rows.length > 0 && cache) await cache.put("skills_sh_home", rows);
  return rows;
}

// 全量目录冷启动约 6 秒（索引 + 两个 10000 行的 shard）。首屏最多等这么久，
// 超时就先给首页推荐并让抓取在后台继续，否则打开技能市场会像卡死一样。
const CATALOG_WAIT_MS = 12000;

async function loadSkillsShCatalog(cache) {
  const cached = cache ? await cache.get(SKILLS_SH_CATALOG_KEY, SKILLS_SH_CATALOG_TTL) : undefined;
  if (Array.isArray(cached) && cached.length > 0) return cached;
  const fetching = skillsShCatalog(cache);
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), CATALOG_WAIT_MS);
  });
  try {
    const winner = await Promise.race([fetching.catch(() => null), timeout]);
    if (Array.isArray(winner) && winner.length > 0) return winner;
  } finally {
    clearTimeout(timer);
  }
  // 让后台把目录抓完写进缓存，下次打开（或下一次翻页）就是全量了。
  void fetching.catch(() => {});
  return null;
}

async function browseSkillsSh({ query = "", page = 1, pageSize = 24, cache, sort = "" } = {}) {
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Number(pageSize) || 24);
  let catalog = await loadSkillsShCatalog(cache);
  let hint;
  if (!catalog) {
    catalog = await skillsShHighlights(cache);
    hint = "skills.sh 全量目录（约 2 万条）正在后台载入，首次约需 1 分钟；现在先显示首页推荐，稍后再点「加载更多」即可翻到更多";
  }
  const needle = String(query || "").trim().toLowerCase();
  const matched = needle
    ? catalog.filter((row) => `${row.owner}/${row.slug}`.toLowerCase().includes(needle))
    : catalog;
  // 切页前排序。必须排**副本**：无查询时 matched === catalog，就地排序会污染模块缓存，
  // 导致同一次会话里后续调用拿到已被重排的目录（实测：sort 改变了默认顺序）。
  const ordered = sortSkillsShRows(matched.slice(), sort);
  const items = pageSlice(ordered, p, size).map(skillsShCard);
  // 首页/sitemap 都不带描述：先读 SKILL.md 头，落空的再读 skills.sh 详情页的 meta。
  // 整段有总时间预算，超时就先发卡片（描述退回通用文案），面板不会为此转圈。
  await withDeadline(
    (async () => {
      try {
        // 详情页 meta 一次请求就有准确简介（concurrency 8，24 条约 3 秒）。
        await enrichPageDescriptions(items, cache, 8);
      } catch {
        // 详情页读不到就退回通用文案
      }
      try {
        // 少数详情页也没有 meta 时，再读仓库里的 SKILL.md 头（顺带补出 skillDir）。
        const missing = items.filter((item) => !item.description);
        if (missing.length > 0) await enrichSkillsShFast(missing, cache, 8);
      } catch {
        // descriptions are best-effort: a failed read never blocks the list
      }
    })(),
    DESCRIPTION_BUDGET_MS,
  );
  fillMissingDescriptions(items);
  return { source: "skills.sh", items, total: matched.length, totalPages: Math.max(1, Math.ceil(matched.length / size)), hasMore: p * size < matched.length, hint };
}

/** skills.sh exposes a real JSON search API (Algolia-backed). */
/** skills.sh 上游行排序（切页之前调用）。 */
function sortSkillsShRows(rows, sort) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  if (sort === "installCount") {
    // search API 的字段就叫 installs（实测 id,source,skillId,name,installs）；
    // 旧代码读 installCount ?? downloads → 恒 undefined → 排序静默退化成不排序。
    const v = (r) => Number(r.installs ?? r.installCount ?? r.downloads) || 0;
    return rows.sort((a, b) => v(b) - v(a));
  }
  if (sort === "name") {
    return rows.sort((a, b) => String(a.slug || a.name || "").localeCompare(String(b.slug || b.name || "")));
  }
  return rows;
}

async function searchSkillsSh({ query = "", page = 1, pageSize = 24, cache, sort = "" }) {
  const q = String(query || "").trim();
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Number(pageSize) || 24);
  // The upstream search API rejects queries shorter than 2 characters; an empty box is a
  // legitimate state, so browse the (whole) catalogue instead.
  if (q.length < 2) return browseSkillsSh({ query: q, page: p, pageSize: size, cache, sort });
  // 上游没有 offset：只能一次取到第 p 页的深度，再在本地切出最后一屏。
  const depth = Math.min(200, size * p);
  const url = `https://www.skills.sh/api/search?q=${encodeURIComponent(q)}&limit=${depth}`;
  // 上游每次现算：同一查询短时内复用结果，重复搜索从 ~3s 降到 ~0ms。
  const searchKey = `skillssh:search:${q.toLowerCase()}:${depth}:${sort || ""}`;
  let data = cache ? await cache.get(searchKey, 5 * 60 * 1000) : undefined;
  if (!data) {
    data = JSON.parse(await fetchText(url, 40000));
    if (cache && Array.isArray(data.skills) && data.skills.length) await cache.put(searchKey, data);
  }
  const rows = Array.isArray(data.skills) ? data.skills : [];
  sortSkillsShRows(rows, sort);
  const items = rows.slice((p - 1) * size, p * size).map((raw) => {
    const sourceRepo = String(raw.source || raw.id || "").split("/").slice(0, 2).join("/");
    const slug = raw.skillId || raw.name || String(raw.id || "").split("/").pop();
    return {
      id: `skills.sh:${raw.id || `${sourceRepo}/${slug}`}`,
      slug,
      name: raw.name || slug,
      description: "",
      source: "skills.sh",
      sourceLabel: "skills.sh",
      owner: sourceRepo,
      homepage: `https://www.skills.sh/${sourceRepo}/${slug}`,
      upstreamUrl: sourceRepo,
      skillDir: "",
      installs: Number(raw.installs) || 0,
      installable: true,
    };
  });
  await withDeadline(
    (async () => {
      try {
        // The search API has no description field; the skill page's own meta text does.
        await enrichSkillsShFast(items, cache, 10);
        await enrichPageDescriptions(items.filter((item) => !item.description).slice(0, 10), cache, 6);
      } catch {
        // descriptions are best-effort
      }
    })(),
    DESCRIPTION_BUDGET_MS,
  );
  fillMissingDescriptions(items);
  const hasMore = rows.length >= depth;
  const total = hasMore ? Math.max(Number(data.count) || 0, depth + 1) : (p - 1) * size + rows.length;
  return { source: "skills.sh", items, total, hasMore };
}

/**
 * Parse a skills.sh page URL into its owner/repo + skill name without fetching the page.
 * The page URL shape is `https://www.skills.sh/<owner>/<repo>/<slug>` (see SKILLS_SH_URL_RE).
 * The install target is the `owner/repo` GitHub repo with skill dir `slug`, which matches
 * what the page's `npx skills add <repo> --skill <slug>` command resolves to, so when the
 * URL matches this shape we can skip the 25-second page fetch entirely. Returns null when
 * the URL does not match (caller should fall back to resolveSkillsShInstall).
 */
export function lookupSkillShRepo(url) {
  const match = SKILLS_SH_URL_RE.exec(String(url || ""));
  if (!match) return null;
  return { repo: `${match[1]}/${match[2]}`, skill: match[3] };
}

/**
 * Fast-path install resolution for skills.sh: first try the local URL parse (zero network),
 * then the on-disk resolved cache, and only fetch the page when both miss.
 */
export async function resolveSkillsShInstall(url, cache) {
  const direct = lookupSkillShRepo(url);
  if (direct) return direct;
  const key = `skills_sh_resolve_${String(url).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 160)}`;
  if (cache) {
    const cached = await cache.get(key, SKILLS_SH_CATALOG_TTL);
    if (cached && cached.repo && cached.skill !== undefined) return { repo: cached.repo, skill: cached.skill };
  }
  const page = await fetchText(url, 25000);
  const command = page.match(/npx\s+skills\s+add\s+(\S+)(?:\s+--skill\s+(\S+))?/);
  if (!command) throw new Error("skills.sh 页面没有给出安装命令，可能页面结构已变化");
  const repoUrl = command[1];
  const skill = String(command[2] || "").split("<")[0].split(/[\s"']/)[0].trim();
  const repo = repoUrl.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/$/, "");
  if (!/^[^/]+\/[^/]+$/.test(repo)) throw new Error(`无法从安装命令解析仓库：${repoUrl}`);
  const result = { repo, skill };
  if (cache) await cache.put(key, result);
  return result;
}

// ------------------------------------------------------------------ browse.sh
/** browse.sh exposes the whole catalogue with title, description, category and tags. */
async function searchBrowseSh({ query = "", page = 1, pageSize = 24, cache, sort = "" }) {
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Number(pageSize) || 24);
  let rows = cache ? await cache.get("browse_sh_api", 30 * 60 * 1000) : undefined;
  if (!rows) {
    const data = JSON.parse(await fetchText("https://browse.sh/api/skills", 25000));
    rows = Array.isArray(data.skills) ? data.skills : [];
    if (rows.length && cache) await cache.put("browse_sh_api", rows);
  }
  const q = String(query || "").trim().toLowerCase();
  const matched = [];
  for (const raw of rows) {
    const hay = `${raw.title || ""} ${raw.description || ""} ${raw.slug || ""} ${(raw.tags || []).join(" ")}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    matched.push({
      id: `browse.sh:${raw.slug}`,
      slug: raw.name || String(raw.slug || "").split("/").pop(),
      name: raw.title || raw.name || raw.slug,
      description: raw.description || "",
      category: raw.category || "",
      tags: raw.tags || [],
      source: "browse.sh",
      sourceLabel: "browse.sh",
      owner: raw.hostname || "",
      homepage: `https://browse.sh/skills/${raw.slug}`,
      upstreamUrl: "",
      skillDir: "",
      reference: raw.slug,
      // 上游字段叫 installCount（实测 459/479 条有值），面板排序与卡片统一读 installs。
      installs: Number(raw.installCount ?? raw.downloads ?? 0) || 0,
      updated: raw.updated || "",
      installable: true,
      note: "通过官方 browse CLI 安装（npx browse skills add）",
    });
  }
  // browse.sh 一次返回整份目录（约 480 条），本地切片即可真正翻页。
  // 排序在完整 matched 集合上做（不是窗口）：这就是真实全盘排序。
  // 479 条一次全给 → 本地排 = 真实全盘排（不是窗口近似）。
  // 上游原生字段：installCount、updated（实测 2026-05-19 等）。
  if (sort === "installCount") {
    matched.sort((a, b) => (Number(b.installs) || 0) - (Number(a.installs) || 0));
  } else if (sort === "updated") {
    matched.sort((a, b) => (Date.parse(b.updated || "") || 0) - (Date.parse(a.updated || "") || 0));
  } else if (sort === "name") {
    matched.sort((a, b) => String(a.name || a.slug || "").localeCompare(String(b.name || b.slug || "")));
  }
  const items = pageSlice(matched, p, size);
  // Web API 无结果且带查询词 → 用官方 browse CLI（真 JSON）复核；仅 API 故障/无结果时启用。
  if (items.length === 0 && q) {
    try {
      const isWin = process.platform === "win32";
      const cliPkg = "browse", cliArgs = ["skills", "find", q, "--json", "--limit", String(size)];
      const cmd = isWin
        ? [process.env.ComSpec || "cmd.exe", "/d", "/s", "/c", "npx -y " + cliPkg + " " + cliArgs.map((a) => JSON.stringify(a)).join(" ")]
        : ["npx", "-y", cliPkg, ...cliArgs];
      const text = await new Promise((resolve, reject) => {
        execFile(cmd[0], cmd.slice(1), { timeout: 120000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) reject(new Error("browse CLI 失败：" + String((stderr || err.message || "")).slice(0, 160)));
          else resolve(String(stdout || ""));
        });
      });
      const parsed = JSON.parse(text.slice(text.indexOf("{")));
      const cliRows = Array.isArray(parsed.skills) ? parsed.skills : [];
      if (cliRows.length) {
        const cliItems = cliRows.map((raw) => ({
          id: "browse.sh:" + raw.slug,
          slug: raw.name || String(raw.slug || "").split("/").pop(),
          name: raw.title || raw.name || raw.slug,
          description: raw.description || "",
          category: raw.category || "",
          tags: raw.tags || [],
          source: "browse.sh",
          sourceLabel: "browse.sh",
          owner: raw.hostname || "",
          homepage: "https://browse.sh/skills/" + raw.slug,
          upstreamUrl: "",
          skillDir: "",
          reference: raw.slug,
          installable: true,
          note: "通过官方 browse CLI 安装（npx browse skills add）；本次结果来自 CLI 备用通道",
        }));
        if (cache) await cache.put("browse_sh_api", items.length ? rows : cliRows);
        return { source: "browse.sh", items: cliItems, total: cliItems.length, hasMore: false, hint: "browse.sh Web API 无结果，结果来自官方 CLI" };
      }
    } catch (cliErr) {
      matched.hint = "browse.sh Web API 与官方 CLI 均无结果或不可达";
    }
  }
    return { source: "browse.sh", items, total: matched.length, hasMore: p * size < matched.length };
}

// 没带 cache 时（例如 agent 直接调 skill_market_search 工具）退回进程级临时目录缓存。
// 必须用 os.tmpdir()：process.env.TEMP 在某些进程（如 CI、无环境注入的调用）中是空的，
// 旧写法会退化成字面量 "undefined\\temp\\..." 并让 mkdtemp 直接 ENOENT。
const fallbackCache = makeCache(join(safeTempDir(), "dsh-market-cache"));


// 排序能力矩阵见 src/sort-capability.js（唯一事实源，实测得出）。

/** 该源的该项排序是否有真实数据支撑。 */

/**
 * 安装参考的统一口径：每个源在自己的 handler 里产出 installRef，
 * 客户端只读这一个字段，不再堆叠 per-source 三元表达式（旧的 7 层链极易静默失败）。
 *
 * 各源形态：
 *   skills.sh  owner="owner/repo"  + skillDir=slug
 *   clawhub    installRef 已是 "owner/slug"（CLI 直吃）
 *   github 系  upstreamUrl="owner/repo"（+ ref/skillDir 可选）
 *   modelscope id="modelscope:owner/name"
 */
export function installRefOf(item) {
  if (!item) return "";
  const source = String(item.source || "");
  if (item.installRef) return String(item.installRef);
  if (source === "skills.sh") return String(item.installRef || item.homepage || item.owner || "");
  if (source === "clawhub") return String(item.installRef || item.upstreamUrl || item.slug || "");
  if (source === "modelscope") return String(item.modelScopeIdent || String(item.id || "").replace(/^modelscope:/, ""));
  if (source === "skillhub") return String(item.upstreamUrl || item.slug || item.id || "");
  if (source === "browse.sh") return String(item.upstreamUrl || item.reference || item.slug || "");
  if (source === "lobehub") return String(item.reference || item.upstreamUrl || item.slug || "");
  return String(item.upstreamUrl || item.id || "");
}

export const supportsSort = capabilitySupports;
export { sortKeysFor };

/** 排序与展示使用同一个取值口径，避免「排了但看起来没排」。 */
export function sortKeyOf(item, sort) {
  if (!item) return 0;
  if (String(sort) === "installCount") return Number(item.installs) || 0;
  if (String(sort) === "name") return String(item.name || item.slug || "");
  return 0;
}

export const ALL_SOURCES = [
  "skills.sh",
  "clawhub",
  "skillsmp",
  "trusttools",
  "browse.sh",
  "lobehub",
  "skillhub",
  "modelscope",
];


const SOURCE_HANDLERS = {
  "skills.sh": searchSkillsSh,
  clawhub: searchClawHub,
  skillsmp: searchSkillsMp,
  trusttools: searchTrustTools,
  "browse.sh": searchBrowseSh,
  "lobehub": searchLobeHubSkills,
  skillhub: searchSkillHub,
  modelscope: searchModelScope,
};

/**
 * 并发拉取多个来源，并按 names 顺序折叠结果。
 *
 * 为什么要它：聚合搜索原来是 for (const name of wanted) { await handler(...) } —— 串行，
 * 总耗时等于各源之和；一个不可达源会把它自己的 20s fetch 超时全额加到用户等待上
 * （本机实测：8 源聚合 >20s，单源 skills.sh 7.1s / clawhub 2.1s / lobehub 4.8s）。
 * 并发后总耗时接近最慢的那一个源。
 *
 * budgetMs 给每个源单独设上限：超预算的源记为 degraded 并写明超时，不再拖住整次搜索。
 * results 与 degraded 都按 names 顺序输出 —— 并发完成先后不能影响展示顺序，
 * 否则同一条件搜两次会得到不同的列表。
 */
export async function fanOutSources({ names, run, budgetMs = 12000 }) {
  const list = Array.isArray(names) ? names : [];
  const settle = (name) => {
    const work = Promise.resolve().then(() => run(name)).then(
      (result) => ({ result }),
      (error) => ({ error: String(error && error.message ? error.message : error) }),
    );
    if (!(budgetMs > 0)) return work;
    let timer = null;
    const guard = new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), budgetMs); });
    return Promise.race([work, guard]).finally(() => clearTimeout(timer));
  };
  const settled = await Promise.all(list.map(settle));
  const results = [];
  const degraded = [];
  for (let i = 0; i < list.length; i++) {
    const name = list[i];
    const box = settled[i];
    if (box && box.timeout) {
      const message = '来源响应超时（预算 ' + Math.round(budgetMs / 1000) + 's），已跳过';
      degraded.push({ source: name, error: message });
      results.push({ name, ok: false, result: null, error: message });
      continue;
    }
    if (box && box.error) {
      degraded.push({ source: name, error: box.error });
      results.push({ name, ok: false, result: null, error: box.error });
      continue;
    }
    results.push({ name, ok: true, result: box ? box.result : null });
  }
  return { results, degraded };
}

export async function searchSkills({ query, source = "all", page = 1, pageSize = 24, cache = fallbackCache, sort = "", category = "", handlers = null, budgetMs = 12000 }) {
  // 注入 handlers 时（测试态）"all" 展开为注入的源集合：否则 fake handler 会被 8 个真实
  // 源淹没，测试照样打真实网络 —— 那测的就不是并发语义，而是上游当时的心情。
  const wanted = source === "all" ? (handlers && Object.keys(handlers).length ? Object.keys(handlers) : ALL_SOURCES) : [source];
  // 该源没有安装量数据时，忽略按安装数排序（保持上游顺序），而不是打乱它
  // 该源没有对应数据时，降级为「不排序」而不是打乱上游顺序。
  let effectiveSort = "";
  if (sort && supportsSort(source, sort)) effectiveSort = sort;
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Math.min(60, Number(pageSize) || 24));
  const items = [];
  const hints = [];
  let total = 0;
  let pagesSum = 0;
  let pagesUnknown = false;
  let hasMore = false;
  const picked = wanted.filter((name) => Boolean((handlers && handlers[name]) || SOURCE_HANDLERS[name]));
  // handlers 是测试注入点：fake handler 才能在没有网络、没有上游波动的情况下断言
  // 并发与顺序性质。生产路径 handlers 为 null，仍走 SOURCE_HANDLERS。
  const fan = await fanOutSources({
    names: picked,
    budgetMs,
    run: (name) => {
      const handler = (handlers && handlers[name]) || SOURCE_HANDLERS[name];
      return handler({ query, page: p, pageSize: size, cache, sort: effectiveSort, category });
    },
  });
  const degraded = fan.degraded;
  for (const entry of fan.results) {
    if (!entry.ok) continue;
    const name = entry.name;
    const result = entry.result;
    if (result && result.hint) hints.push(name + '：' + result.hint);
    const srcItems = result && Array.isArray(result.items) ? result.items : [];
    if (srcItems.length) items.push(...srcItems.map((it) => ({ ...it, installRef: installRefOf(it) })));
    const srcTotal = Number(result && result.total) || 0;
    total += srcTotal;
    // 页数判定：handler 给了数字就用它；没给但有真实 total 就用 total 反推；
    // 两者都没有（clawhub 无界流把 total/totalPages 都置 undefined）才算「未知」。
    const declared = result && typeof result.totalPages === "number" ? Number(result.totalPages) : null;
    const srcPages = declared !== null ? declared
      : srcTotal > 0 ? Math.ceil(srcTotal / size)
      : null;
    if (srcPages === null) pagesUnknown = true;
    else pagesSum += srcPages;
    if (result && result.hasMore) hasMore = true;
  }
  // 本地排序兜底：多数源上游不支持 sort 参数，按安装数/名称在本地排
  if (sort === "installCount") {
    items.sort((a, b) => (Number(b.installs) || 0) - (Number(a.installs) || 0));
  } else if (sort === "name") {
    items.sort((a, b) => String(a.name || a.slug || "").localeCompare(String(b.name || b.slug || "")));
  }
  // skills.sh entries get their description from the skill page; browse.sh ships one.
  try {
    const missing = items.filter((item) => item.source === "skills.sh" && !item.description);
    if (missing.length) await enrichSkillsShFast(missing, cache, 10);
  } catch {
    // best-effort: a failed description never blocks the list
  }
  // An empty browsing page is almost never "no matches" — it is an upstream that timed out
  // or refused us. Say so instead of showing a blank market, and name the sources that
  // failed so the user can tell "nothing here" from "could not reach it".
  const sourceErrors =
    items.length > 0 || String(query || "").trim()
      ? []
      : degraded.length
        ? degraded.map((entry) => `${entry.source} 不可达：${entry.error}`.slice(0, 200))
        : hints.length
          ? hints
          : ["所选市场暂时没有取到数据，可能是上游不可达或响应超时，请稍后重试"];
  // 反推兜底只在「本页确实有货、上游却没报总数」时成立。items=0 时补 (p-1)*size
  // 会凭空造数：trusttools 每页超时（items=0、total=0）时 total 竟随页码涨成 12/24 ——
  // 一个条目都没有却报「共 24 个」，属于计数与真实集合不符的口径缺陷。
  if (items.length > 0 && (!total || total < items.length)) total = hasMore ? p * size + 1 : (p - 1) * size + items.length;
  // 分类筛选：无 category 的源无法参与，如实告知而不是静默返回全量。
  const catNeedle = String(category || "").trim();
  const catSupported = items.some((item) => item.category);
  let visible = items;
  let categoryNote = "";
  let filteredOut = 0;
  if (catNeedle && catNeedle !== "all") {
    if (!catSupported) {
      categoryNote = "所选来源不提供分类信息，已忽略分类筛选";
    } else {
      visible = items.filter((item) => !item.category || item.category === catNeedle);
      filteredOut = items.length - visible.length;
      if (filteredOut > 0) {
        // 本地过滤只作用于当前页：上游的 total/pages 是按未过滤集合算的，
        // 继续沿用就是与实际不符的计数。重算为可见集合，并说明这是本地兜底过滤。
        total = visible.length + (p - 1) * size;
        pagesSum = Math.max(1, Math.ceil(total / size));
        pagesUnknown = false;
        hasMore = false;
        categoryNote = "分类为面板本地过滤（仅当前页），已过滤掉 " + filteredOut +
          " 项；分类过滤只作用于当前页，上游不提供过滤后的总数";
      }
    }
  }
  const pages = pagesUnknown && wanted.length === 1 ? undefined : Math.max(pagesSum, Math.ceil(total / size), 1);
  return {
    items: visible,
    categoryNote,
    filteredOut,
    page: p,
    pageSize: size,
    pages,
    totalPages: pages,
    total,
    hasMore,
    degraded,
    hints,
    sourceErrors,
  };
}

/**
 * Warm the catalogues that are expensive on a cold start (browse.sh ships ~480 entries,
 * skills.sh needs the ~2 MB sitemap, LobeHub's CLI search is a 30 s npx round-trip,
 * skillsmp is a paged upstream). Runs in the background so the first panel open is already populated.
 */
export async function warmMarketCache(cache = fallbackCache) {
  const results = await Promise.allSettled([
    searchBrowseSh({ query: "", page: 1, pageSize: 24, cache }),
    searchLobeHubSkills({ query: "", page: 1, pageSize: 24, cache }),
    searchModelScope({ query: "", page: 1, pageSize: 24 }),
    skillsShCatalog(cache),
    warmClawHubCatalog(cache),
  ]);
  return results.map((r) => (r.status === "fulfilled" ? (Array.isArray(r.value) ? r.value.length : (r.value.items || []).length) : 0));
}
