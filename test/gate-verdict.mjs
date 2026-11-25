// gate-verdict.mjs — run-gate 的判定纯函数（契约的单一实现）。
//
// 为什么抽出来：run-gate 的「什么算绿」以前只写在循环体里，是口头约定。
// 0.5.132 的 CI 红灯（test-features 在 CI 上因 npx 不可用中途崩溃 → 无 summary 行）
// 证明这条契约必须可测：缺 summary 的套件绝不能被放行。抽成纯函数后
// test-gate-contract.mjs 能锁住全部判定分支，并用真 run-gate 证伪一次。

// 返回 { verdict, summary }。verdict 为 PASS 的唯一条件：未被杀、退出 0、
// 最后一行匹配「N passed, M failed[, K skipped]」且 M=0。其余全是红灯。
// misses（可选，回放层给）：本套件内未命中的请求条数。只要 >0 一律判 REPLAY-MISS，
// 优先于 PASS —— 实测空档案下 test-global-sort 把未命中降级成 skip 后仍打印
// 「4 passed, 0 failed, 3 skipped」退出 0，而录制态是「9 passed, 2 skipped」：
// 5 条判据静默蒸发却放行。门不能只听套件自己怎么汇报（本仓「绿不等于做了」）。
//
// SUSPEND-SUSPECT：整机睡眠会把定时器与子进程一起冻住，但 Date.now() 照走 ——
// 于是「被 perTimeout 杀死」这件事的实际墙钟可以远大于 perTimeout，而套件本身
// 几乎没推进。实测（2026-11-24 08:24）：test-sort-honesty 记成 TIMEOUT 1524s，
// 而 perTimeout=420s；Kernel-Power 事件 08:24:57 睡眠 / 08:50:21 唤醒，
// 窗口正好 1524 秒。那条红当时被当成套件真慢，据此建了一整套机制理论、白跑两版。
// 判据：确实被定时器杀了（killed）但 ms 明显超出 perTimeout + 宽限 ⇒ 归因写
// 「疑似整机睡眠」。仍算红灯（不替它放行），但要人先复跑，而不是先去改代码。
// 所以杀定时器命中但 ms 明显超出 perTimeout + 宽限 ⇒ 判 SUSPEND-SUSPECT：
// 仍算红灯（不能替它放行），但归因写「疑似机器睡眠」，让人先复跑而不是先去改代码。
export function gateVerdict({ code, killed, out, misses = 0, ms = 0, perTimeout = 0, suspendGraceMs = 60000 }) {
  const text = String(out || '');
  const counts = /\n(\d+) passed, (\d+) failed(?:, (\d+) skipped)?\s*$/.exec(text);
  const summary = counts
    ? counts[1] + ' passed, ' + counts[2] + ' failed' + (counts[3] ? ', ' + counts[3] + ' skipped' : '')
    : '(no summary line)';
  // ms 只有在「确实是被定时器杀的」时才解释得通：正常杀应在 perTimeout 后立即落地。
  if (killed && Number(perTimeout) > 0 && Number(ms) > Number(perTimeout) + Number(suspendGraceMs)) {
    return {
      verdict: 'SUSPEND-SUSPECT',
      summary: summary + ' · 墙钟 ' + Math.round(ms / 1000) + 's 超出超时 ' + Math.round(perTimeout / 1000) + 's，疑似整机睡眠',
    };
  }
  if (killed) return { verdict: 'TIMEOUT', summary };
  if (code !== 0) return { verdict: 'FAIL', summary };
  if (Number(misses) > 0) return { verdict: 'REPLAY-MISS', summary: summary + ' · 未命中 ' + misses + ' 条' };
  // 退出 0 却没有规范 summary = 套件中途崩了或没跑完，绝不能替它放行。
  if (!counts) return { verdict: 'NO-SUMMARY', summary };
  return { verdict: counts[2] === '0' ? 'PASS' : 'FAIL', summary };
}
