// SkillHub community source adapter (public, unauthenticated JSON API).
const BASE = "https://api.skillhub.cn/api/skills";
const UA = { "User-Agent": "dsh-skill-mcp-market/0.1 (+skill market)", accept: "application/json" };

async function getJson(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: UA, signal: controller.signal });
    if (!response.ok) throw new Error(`SkillHub HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.code !== 0) throw new Error(`SkillHub error code ${payload?.code}`);
    return payload.data ?? {};
  } finally {
    clearTimeout(timer);
  }
}

function toItem(raw) {
  const namespace = raw.namespace || {};
  const canonical = namespace.canonicalName || raw.slug || "";
  const downloads = Number(raw.downloads ?? raw.installs ?? 0) || 0;
  // 面板排序与卡片「· N 次安装」统一读 item.installs；skillhub 上游字段叫 downloads，
  // 不映射则「按安装数」排序对它恒为 0、卡片也不显示安装量。
  const installs = downloads;
  const stars = Number(raw.stars ?? 0) || 0;
  return {
    id: `skillhub:${canonical || raw.slug}`,
    slug: raw.slug || namespace.publicSlug || canonical,
    name: raw.name || namespace.publicSlug || raw.slug,
    description: raw.description_zh || raw.description || "",
    category: raw.category || "",
    source: "skillhub",
    sourceLabel: "SkillHub（社区）",
    owner: raw.ownerName || namespace.displayName || "",
    iconUrl: raw.iconUrl || "",
    homepage: raw.homepage || "",
    upstreamUrl: raw.upstream_url || "",
    downloads,
    stars,
    installs,
    verified: Boolean(raw.verified),
    version: raw.version || "",
    installable: Boolean(canonical || raw.slug),
    namespace: canonical,
    reference: canonical || raw.slug || "",
  };
}

export async function searchSkills({ query = "", page = 1, pageSize = 20, category = "", cache, sort = "" } = {}) {
  const p = Math.max(1, page);
  const size = Math.min(50, Math.max(1, pageSize));
  // 排序模式下上游无 sort：从第 1 页取宽窗口，本地排序后再切页，否则跨页无序
  const sortMode = sort === "installCount" || sort === "name";
  const fetchPage = sortMode ? 1 : p;
  const fetchSize = sortMode ? 50 : size;
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (category) params.set("category", category);
  params.set("page", String(fetchPage));
  params.set("pageSize", String(fetchSize));
  // 同一查询 5 分钟内复用，避免重复打上游。
  const searchKey = `skillhub:search:${query.toLowerCase()}:${category}:${fetchPage}:${fetchSize}:${sort || ""}`;
  let data = cache ? await cache.get(searchKey, 5 * 60 * 1000) : undefined;
  if (!data) {
    data = await getJson(`${BASE}?${params.toString()}`);
    if (cache && (Array.isArray(data.skills) || Array.isArray(data.items))) await cache.put(searchKey, data);
  }
  const rows = Array.isArray(data.skills) ? data.skills : Array.isArray(data.items) ? data.items : [];
  if (sortMode) {
    if (sort === "installCount") {
      const k = (r) => Number(r.downloads ?? r.installCount ?? r.installs) || 0;
      rows.sort((a, b) => k(b) - k(a));
    } else {
      rows.sort((a, b) => String(a.name || a.slug || "").localeCompare(String(b.name || b.slug || "")));
    }
  }
  const pageRows = sortMode ? rows.slice((p - 1) * size, p * size) : rows;
  const items = pageRows.map(toItem);
  return {
    source: "skillhub",
    items,
    total: Number(data.total ?? items.length) || items.length,
    page: Number(data.page ?? page) || page,
    pageSize: items.length || pageSize,
    hasMore: items.length >= pageSize,
  };
}

export async function categories() {
  const data = await getJson(`${BASE}/categories`);
  const rows = Array.isArray(data) ? data : Array.isArray(data.categories) ? data.categories : [];
  return rows
    .map((row) => (typeof row === "string" ? { key: row, name: row } : { key: row.key || row.name, name: row.name || row.key }))
    .filter((row) => row.key);
}
