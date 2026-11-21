// 排序能力矩阵 —— 唯一事实源（server 侧）。
//
// 每一格都来自 2026-11-18/19 的实测（同批次对比法：先取默认序基线，再逐值对比名字序列，
// 并验证返回字段单调性；避开「下载量计数器漂移」造成的假阳性）。改任何一格之前先重新实测。
//
//   skills.sh    search API 行带 installs（实测 4,431,266 首条）→ installCount/name
//   clawhub      browse 端点 sort=downloads|stars|newest|updated|trending|name 全部服务端全盘排序
//                （实测单调）；sort=installs 不单调 → 用 downloads 代替；search 端点仅本地
//   skillsmp     API 被 Cloudflare 挡（走 python 降级），CLI --sort 只有 stars|recent；
//                本地只对已取回的 rows 排 name → 仅 name
//   trusttools   GET sort_by=install_count 服务端全盘（446,924 首条）；sort_by=stars 被忽略、
//                newest/updated/trending/name 返回 EMPTY（上游坏）→ installCount/name(窗口本地)
//   browse.sh    一次返回全量 479 条，installCount/updated/name 本地全量排 = 真实全盘
//   lobehub      CLI --sort 原生 createdAt|stars|installCount|name|relevance|ratingAverage|
//                commentCount|updatedAt（实测 installCount 跨页全局单调）
//   skillhub     sortBy=installs|stars|updated_at 服务端全盘（实测 installs 跨页单调：
//                30 条 86140…8444）；installCount 必须映射到 installs 而非 downloads
//                （两榜首条不同：installs→self-improving-agent、downloads→dev-god）。
//                sortBy=name 上游直接 code:400 → name 本地排。
//   modelscope   无任何服务端 sort（实测 9 种参数名全部被忽略）；全量拉取（上游深度上限≈45k）
//                后本地排 DownloadCount/SourceStar/GmtCreate/GmtModify/Name

// downloadCount 是独立键：它与 installCount 在上游是两个不同字段（skillhub/clawhub/modelscope
// 实测都有各自的 downloads/DownloadCount 与 installs），混成一个键就必然有源的名称与字段不符。
export const SORT_KEYS = ["installCount", "downloadCount", "stars", "newest", "updated", "trending", "name"];

// 名称 → 真实字段（用户 2026-11-21 拍板：各源的排序方法按真实情况命名，名称必须与实现一致）：
//   installCount  → 该源行上真有「安装数」字段并用它排：skills.sh(installs)、trusttools(sort_by=install_count /
//                 install_count)、browse.sh(installCount)、lobehub(--sort installCount)、skillhub(sortBy=installs)
//   downloadCount → 排的是下载数：clawhub(browse sort=downloads、search getter r.downloads)、
//                 modelscope(本地 getter r.DownloadCount)、skillhub(sortBy=downloads)
// clawhub 旧格写成 installCount 属名实不符：实测同一行 stats.installs=18,549 与 stats.downloads=494,474
//   clawhub      browse 端点 sort=downloads|stars|newest|updated|trending|name 全部服务端全盘排序
//                （实测单调）；sort=installs 跨页**不单调**（实测 p1min=0 < p2max=892，字段稀疏：
//                60 条样本仅 18 条有值）→ 不宣称 installCount，键名如实叫 downloadCount；
//                search 端点 URL 不认 sort，本地 getter 同样只有 downloads 可用。
const CAPABILITIES = {
  "skills.sh": ["installCount", "name"],
  // clawhub：browse 路径 sort=downloads/stars/newest/updated/trending/name 全部服务端全盘排序（实测单调）；
  // search（带查询）路径 trending 无字段支撑（score 是相关性分桶、rolling60DayInstalls 稀疏近零），
  // 其余键由 handler 的本地 getter 覆盖（stars/newest 取自 native.skill.*，updated 取顶层 updatedAt）。
  "clawhub": ["downloadCount", "stars", "newest", "updated", "trending", "name"],
  "skillsmp": ["name"],
  "trusttools": ["installCount", "name"],
  "browse.sh": ["installCount", "updated", "name"],
  "lobehub": ["installCount", "stars", "newest", "updated", "name"],
  // skillhub：installs 与 downloads 都是上游真实字段（实测 self-improving-agent 86,140 / 1,736,606，
  // 两榜首条也不同）→ 两个键都给，各自透传对应 sortBy。
  "skillhub": ["installCount", "downloadCount", "stars", "updated", "name"],
  "modelscope": ["downloadCount", "stars", "newest", "updated", "name"],
};

/** 该源是否支持该排序（false = 保持上游默认序，绝不近似或乱排）。 */
export function supportsSort(source, sort) {
  const key = String(sort || "");
  if (!key || key === "default") return true;
  if (String(source || "") === "all") return true; // 聚合：对合并集按字段排，各 handler 自判
  const list = CAPABILITIES[String(source || "")];
  return Array.isArray(list) && list.includes(key);
}

/**
 * 该源支持的排序键（供 UI 生成下拉；能力表只存在于服务端，面板经 settings.get 读取）。
 * options.hasQuery=true 时按「带查询」路径收紧——两条路径的上游能力不同（实测）：
 *   clawhub search 端点不认 sort，trending 在 search 行上无任何字段支撑
 *   （score 是相关性分桶、metrics.rolling60DayInstalls 稀疏近零）→ 带查询时不给 trending。
 *   browse 路径 6 键全部服务端全盘排序，trending 成立。
 */
export function sortKeysFor(source, options = {}) {
  const list = CAPABILITIES[String(source || "")];
  let keys = Array.isArray(list) ? list.slice() : ["name"];
  if (options.hasQuery && String(source || "") === "clawhub") keys = keys.filter((k) => k !== "trending");
  return keys;
}

/**
 * MCP 两个市场的排序能力，与技能源分开建模（线路事实不同）：
 *   registry  — index.js 的 registry 分支根本不读 options.sort（searchMcpRegistryPage 无 sort 参数），
 *               卡片也没有 installs/rating 字段 → 服务端不排、本地也无字段可排 → 诚实为空。
 *               用户 2026-11-19 拍板：registry 只显示「默认顺序」，不给会「选了没反应」的假选项。
 *   lobehub   — MCP 侧走 @lobehub/market-cli mcp search --sort（lobehub-market.js:143，仅带查询时透传），
 *               行字段有 installCount/ratingAvg/ratingCount/createdAt/updatedAt；无查询时本地兜底
 *               （lobehub-market.js:172-177）只认 installCount/ratingAverage/createdAt。
 *               取交集里真正生效的两个键：installCount、ratingAverage。
 */
const MCP_CAPABILITIES = {
  "registry": [],
  "lobehub": ["installCount", "ratingAverage"],
};

/**
 * MCP 源支持的排序键（供面板生成 MCP 下拉）。
 * hasQuery 同样改变能力：lobehub 的 --sort 只在带查询时透传上游
 * （lobehub-market.js:143 if (sort && hasQuery)），无查询时 CLI 拒收 --sort、
 * 本地兜底只重排当前页 → 跨页无序，诚实起见无查询时 lobehub 也不给排序项。
 */
export function sortKeysForMcp(source, options = {}) {
  const list = MCP_CAPABILITIES[String(source || "")];
  let keys = Array.isArray(list) ? list.slice() : [];
  if (!options.hasQuery && String(source || "") === "lobehub") keys = [];
  return keys;
}
