// test/gate-pool.mjs — 门并发层的纯函数（方案 C）。
// 与 gate-verdict.mjs 同款约定：零副作用、可被 test-gate-contract 直接喂假数据断言。
//
// 为什么默认 1（串行）：真网络态并发会污染计时类判据——test-warm-budget 断言预算内
// 完成、test-search-latency-recovery 断言上游延迟，多条套件同时打上游时 CPU/网络
// 争抢会把「慢但正常」推过阈值，制造假 TIMEOUT（run-gate 注释里 420s 的来历就是
// 「慢但正常不能误判」）。并发留给回放态与本地提速：DSH_GATE_PARALLEL=4~8。
// CI 与发布链不设该变量 ⇒ 行为与串行版逐字一致。

export function poolLimit(raw, total) {
  const n = Math.max(1, Math.min(8, Number(raw) || 1));
  return Math.min(n, Math.max(1, Number(total) || 1));
}

// runPool：limit 条泳道消费 items；results[i] 恒对应 items[i]（完成顺序不影响归属）。
// worker 必须自己消化异常（门的 runOne 用 close 事件 resolve，永不 reject）；
// 这里刻意不做取消传播——半途 reject 会把还在跑的泳道留成孤儿进程，比卡住更糟。
export async function runPool(items, worker, limit) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Math.min(poolLimit(limit, items.length), items.length);
  const lane = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: lanes }, lane));
  return results;
}
