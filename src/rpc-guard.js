// RPC 边界的鉴权与破坏性操作确认。
//
// 背景：/api/dsh-market/rpc 之前零校验，本机任意进程 POST 即拿到全部路径与会话列表（实测 200）。
//
// 鉴权模型——按 ARCHITECTURE.md「client 侧同源 fetch」的事实设计：
//   面板与 RPC 同源，浏览器会自动附带 Origin（POST）或 Referer。
//   第三方网页 / 无关脚本无法伪造本机 GUI 的 Origin，因此「来源必须是本机 GUI」是真边界。
//   端口每次启动都变，所以只校验 host 属于 loopback，协议为 http(s)。
//   注意：本机进程可以手工构造该头——这不是网络级认证，而是把「任何进程随意调用」
//   收敛到「必须声称来自本机 GUI」，足以挡住浏览器中的任意网页与误触脚本。
import { randomBytes, timingSafeEqual } from "node:crypto";

export const TOKEN_HEADER = "x-dsh-market-token";

/** 需要二次确认（body.confirm === true）才能执行的操作。 */
export const DESTRUCTIVE_OPS = new Set([
  "sessions.repair",
  "skills.uninstall",
  "mcp.uninstall",
  "skills.trashEmpty",
]);

function tokenEquals(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length) return false;
  try { return timingSafeEqual(left, right); } catch { return false; }
}

/** 请求是否来自本机 GUI 页面（Origin/Referer 属于 loopback）。 */
export function isTrustedOrigin(originOrReferer) {
  const value = String(originOrReferer || "").trim();
  if (!value) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

export function makeRpcGuard() {
  const token = randomBytes(32).toString("hex");
  return {
    token,
    /**
     * 请求准入判定：来源必须是本机 GUI。
     * 若调用方额外带了 token（页面可选的加固），则与 token 一并校验。
     */
    check(req) {
      const headers = (req && req.headers) || {};
      const origin = headers.origin || headers.Origin;
      const referer = headers.referer || headers.Referer;
      if (!isTrustedOrigin(origin) && !isTrustedOrigin(referer)) {
        return { ok: false, status: 403, error: "forbidden: request must come from the local GUI" };
      }
      return { ok: true };
    },
    /** 校验可选 token（客户端若携带则必须匹配）。 */
    checkToken(req) {
      const headers = (req && req.headers) || {};
      const provided = headers[TOKEN_HEADER] || headers[TOKEN_HEADER.toUpperCase()];
      if (!provided) return { ok: true };
      if (!tokenEquals(provided, token)) return { ok: false, status: 401, error: "unauthorized: invalid market token" };
      return { ok: true };
    },
    /** 破坏性操作必须显式 confirm:true。 */
    checkDestructive(op, body) {
      if (!DESTRUCTIVE_OPS.has(String(op || ""))) return { ok: true };
      // sessions.repair 的 dryRun 是只读预演，不落盘，不需要确认
      if (String(op) === "sessions.repair" && body && body.dryRun === true) return { ok: true };
      if (body && body.confirm === true) return { ok: true };
      return { ok: false, status: 400, error: `${op} 需要二次确认（confirm:true）` };
    },
  };
}