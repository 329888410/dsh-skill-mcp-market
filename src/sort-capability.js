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
//   skillhub     sortBy=downloads|stars|updated 服务端全盘（实测单调）；sortBy=name 返回空（上游bug）
//                → name 本地排
//   modelscope   无任何服务端 sort（实测 9 种参数名全部被忽略）；全量拉取（上游深度上限≈45k）
//                后本地排 DownloadCount/SourceStar/GmtCreate/GmtModify/Name

export const SORT_KEYS = ["installCount", "stars", "newest", "updated", "trending", "name"];

const CAPABILITIES = {
  "skills.sh": ["installCount", "name"],
  "clawhub": ["installCount", "stars", "newest", "updated", "trending", "name"],
  "skillsmp": ["name"],
  "trusttools": ["installCount", "name"],
  "browse.sh": ["installCount", "updated", "name"],
  "lobehub": ["installCount", "stars", "newest", "updated", "name"],
  "skillhub": ["installCount", "stars", "updated", "name"],
  "modelscope": ["installCount", "stars", "newest", "updated", "name"],
};

/** 该源是否支持该排序（false = 保持上游默认序，绝不近似或乱排）。 */
export function supportsSort(source, sort) {
  const key = String(sort || "");
  if (!key || key === "default") return true;
  if (String(source || "") === "all") return true; // 聚合：对合并集按字段排，各 handler 自判
  const list = CAPABILITIES[String(source || "")];
  return Array.isArray(list) && list.includes(key);
}

/** 该源支持的排序键（供 UI 生成下拉；面板侧另有内联矩阵，由测试锁定两处一致）。 */
export function sortKeysFor(source) {
  const list = CAPABILITIES[String(source || "")];
  return Array.isArray(list) ? list.slice() : ["name"];
}