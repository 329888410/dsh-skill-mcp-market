// RPC 边界的破坏性操作确认。
//
// 历史与教训（务必如实记录，防止未来重蹈覆辙）：
//   0.5.95 曾把「Origin/Referer 属于 loopback」当作安全边界，实测两个方向都错：
//     1) Electron 面板的 fetch 不带 Origin（宿主调试日志实测 162 条全部 origin:null），
//        导致面板自己被 403 拦死——整个市场打不开；
//     2) 本机任意进程可伪造 Origin: http://127.0.0.1:x 直接绕过（实测 200）。
//   既挡不住攻击者又误伤自己人，故 Origin 校验已彻底移除，不再以「安全边界」名义存在。
//
// 现策略（按实际威胁模型分层）：
//   - HTTP 面（面板通道）：只读 op 直接放行；破坏性 op 必须 confirm:true；
//     可执行任意命令（mcp.install 的 command 模式）与改写会话（sessions.repair）
//     在 index.js 的 HTTP_BLOCKED_OPS / command 拒绝中挡掉。
//   - 真正的进程级隔离需要宿主提供私有通道，插件侧无法伪造出不可猜的凭据
//     （宿主未向页面注入任何 token，已查证）。

/** 需要二次确认（body.confirm === true）才能执行的操作。 */
export const DESTRUCTIVE_OPS = new Set([
  "sessions.repair",
  "skills.uninstall",
  "mcp.uninstall",
  "skills.trashEmpty",
]);

export function makeRpcGuard() {
  return {
    /**
     * 准入判定：恒通过。保留本函数是为了调用点结构不变（index.js 仍先 check 再 dispatch），
     * 未来若宿主提供私有凭据通道，在这里接上即可。
     */
    check() {
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