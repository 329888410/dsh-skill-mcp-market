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
  // 上游支持服务端全盘排序：sortBy=downloads（实测首条 dev-god≈12.1M，跨页全局单调）、stars、updated。
  // sortBy=name 上游返回空数组（bug），故 name 只能本地排。旧实现取 50 条窗口本地排 installCount，
  // 那是对 231,131 条全量的近似——禁止。
  const serverSort = sort === "installCount" ? "downloads" : sort === "stars" ? "stars" : sort === "updated" ? "updated" : "";
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (category) params.set("category", category);
  params.set("page", String(p));
  params.set("pageSize", String(size));
  if (serverSort) params.set("sortBy", serverSort);
  // 同一查询 5 分钟内复用，避免重复打上游。
  const searchKey = `skillhub:search:${query.toLowerCase()}:${category}:${p}:${size}:${sort || ""}`;
  let data = cache ? await cache.get(searchKey, 5 * 60 * 1000) : undefined;
  if (!data) {
    data = await getJson(`${BASE}?${params.toString()}`);
    if (cache && (Array.isArray(data.skills) || Array.isArray(data.items))) await cache.put(searchKey, data);
  }
  const rows = Array.isArray(data.skills) ? data.skills : Array.isArray(data.items) ? data.items : [];
  // 仅 name 本地排（上游 sortBy=name 返回空）；installCount/stars/updated 由服务端全盘排序
  if (sort === "name") {
    rows.sort((a, b) => String(a.name || a.slug || "").localeCompare(String(b.name || b.slug || "")));
  }
  const pageRows = rows;
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
