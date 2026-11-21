// live-audit.mjs — 「无本插件 console 报错」的判定口径。
//
// 口径按【触发方】判定，不按报错文本里有没有我们的文件名。原因（2026-11-22 live 实测）：
// 点 clawhub 卡片的「详情」会稳定产生
//   Framing 'https://clawhub.ai/' violates the following Content Security Policy
//   directive: "frame-ancestors 'none'". The request has been blocked.
// 这条文本里没有 client.js、也没有 op 名，按「文本里有没有插件文件名」判定会永远漏掉它，
// 于是「点了拿不到内容」这类缺陷会长期落在判据缝隙里。
//
// 但只看「点击之后出现过」会过度归因：实测同一相位窗口里还混着宿主 GUI 自己轮询的
// GET /api/changes.summary → 404（点击前的窗口里也在刷）。所以定性看**签名的首次出现**：
// 首次就落在点击之后的才算本插件触发；点击前就在刷的属宿主周期噪声，豁免并计数。
//
// 分类：
//   PLUGIN           报错文本命中插件面（client.js 路径、RPC op 名、面板文案）；
//   TRIGGERED        该签名首次出现在「点击本插件按钮之后」的相位（phase 以 after: 开头）；
//   BASELINE         宿主自身基线噪声（与插件无关），豁免；
//   HOST-UNTRIGGERED 宿主侧且未由插件触发的错误，豁免但必须列出，便于人审。
export const PLUGIN_SURFACE = [
  /client\.js/i,
  /skills\.(search|detail|install|update|uninstall)/,
  /mcp\.(detail|raw\.(get|set)|probe|add|remove|status)/,
  /skillhub\.evaluation/,
  /市场面板|技能面板|SKILL技能|MCP连接器/,
];

const BASELINE = [/deepseek-account/];

export function classify(entry) {
  if (!entry || entry.level !== "error") return null;
  const text = String(entry.text || "");
  const phase = String(entry.phase || "idle");
  if (BASELINE.some((re) => re.test(text))) return "BASELINE";
  if (PLUGIN_SURFACE.some((re) => re.test(text))) return "PLUGIN";
  if (/^after:/.test(phase)) return "TRIGGERED";
  return "HOST-UNTRIGGERED";
}

// signature —— 归并同一类重复报错：只把数字换成占位符，于是同一接口不同 seq 或
// 不同页码的轮询报错算一条；不同端点仍是两条（宁可分裂，不可把两个缺陷并成一个）。
// 证伪记录：URL 剥离、会话 id 归一、空白归一三步已删除 —— 逐条注入证伪显示去掉
// 它们断言仍全绿（即装饰代码）；只有数字归一被真实观测文本的断言咬住。
export function signature(text) {
  return String(text || "")
    .replace(/\d+/g, "N")
    .trim()
    .slice(0, 140);
}

export function audit(entries) {
  const list = entries || [];
  const firstBySig = new Map();
  list.forEach((e, i) => {
    const s = signature(e && e.text);
    if (!firstBySig.has(s)) firstBySig.set(s, { e, i, s });
  });
  const rows = [...firstBySig.values()].map((x) => ({ ...x, kind: classify(x.e) })).filter((x) => x.kind);
  const bad = rows.filter((x) => x.kind === "PLUGIN" || x.kind === "TRIGGERED");
  const classified = list.filter((e) => classify(e)).length;
  return {
    bad,
    baseline: rows.filter((x) => x.kind === "BASELINE").length,
    host: rows.filter((x) => x.kind === "HOST-UNTRIGGERED").length,
    distinct: rows.length,
    repeats: classified - rows.length,
  };
}
