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
export function gateVerdict({ code, killed, out, misses = 0 }) {
  const text = String(out || '');
  const counts = /\n(\d+) passed, (\d+) failed(?:, (\d+) skipped)?\s*$/.exec(text);
  const summary = counts
    ? counts[1] + ' passed, ' + counts[2] + ' failed' + (counts[3] ? ', ' + counts[3] + ' skipped' : '')
    : '(no summary line)';
  if (killed) return { verdict: 'TIMEOUT', summary };
  if (code !== 0) return { verdict: 'FAIL', summary };
  if (Number(misses) > 0) return { verdict: 'REPLAY-MISS', summary: summary + ' · 未命中 ' + misses + ' 条' };
  // 退出 0 却没有规范 summary = 套件中途崩了或没跑完，绝不能替它放行。
  if (!counts) return { verdict: 'NO-SUMMARY', summary };
  return { verdict: counts[2] === '0' ? 'PASS' : 'FAIL', summary };
}
