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
  const downloads = Number(raw.downloads ?? 0) || 0;
  // installs 与 downloads 是两个不同的上游字段，各取各的。实测 self-improving-agent
  // installs=86140 / downloads=1736606 —— 旧代码写 installs = downloads，于是卡片上的
  // 「· N 次安装」显示的是下载数（差 20 倍），「按安装数」也在按下载数排。
  // 上游 installs 缺失或为 0 时保持 0：面板 item.installs ? … : null 会不显示这一项，
  // 宁可不显示也不显示错数（60 条样本里仅 18 条有真实 installs，回落会造成大面积错值）。
  const installs = Number(raw.installs ?? 0) || 0;
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
  // 排序一律交给服务端全盘排（实测 sortBy=installs 跨页单调：30 条 86140…8444）。
  // 三个曾经写错的键：
  //   installCount → installs（旧代码映射到 downloads，于是「按安装数」拿到的是下载榜：
  //     实测两榜首条不同，installs→self-improving-agent、downloads→dev-god）；
  //   updated → updated_at（文档字段名带 _at；sortBy=updated 会被上游当成未知名）；
  //   name → 上游实测返回 code:400 空列表，只能本地排（不发 sortBy=name）。
  const serverSort = sort === "installCount" ? "installs" : sort === "stars" ? "stars" : sort === "updated" ? "updated_at" : "";
  const params = new URLSearchParams();
  // 关键词参数名必须是 keyword：实测 q=pdf 返回 total=233498（≈全量 233,498，等于没搜），
  // keyword=pdf 返回 5614。旧代码传 q，所以 SkillHub 的搜索一直无效，只因仍返回条目而看着像成功。
  if (query) params.set("keyword", query);
  if (category) params.set("category", category);
  params.set("page", String(p));
  params.set("pageSize", String(size));
  if (serverSort) {
    params.set("sortBy", serverSort);
    params.set("order", "desc"); // 上游默认虽为 desc，显式写出以免依赖默认值
  }
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
// 曾有的 categories() 已删除：它请求 /api/skills/categories（实测 405 Method Not Allowed），
// 且全仓无任何调用方 —— 面板的分类 chip 来自当前页条目的 category 字段（client.js:1563）。
// 真正的端点是 /api/v1/categories（13 个一级分类），但它的响应是 {count,items}、**没有 code 字段**，
// 不能走上面的 getJson（它要求 code===0）。将来若要把上游分类接进面板，必须另开一条不校验
// code 的取数路径；在那之前不做半吊子接入，也不用别的字段凑分类。