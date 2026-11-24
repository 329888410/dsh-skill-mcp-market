#!/usr/bin/env node
// test/replay/backfill.mjs — 档案收敛循环：冷缓存回放 → 有未命中就冷缓存重录该轮 → 再回放，
// 直到「门全绿且 0 未命中」或跑满 rounds。
//
// 为什么需要它（2026-11-25 00:36–00:46 实测）：链型上游（MCP registry 的 cursor 分页）的
// 下一页 URL 由上一页响应决定。手工补一条，下一轮回放就冒下一条 —— 我连补 marrow/inite/
// the-stall 三条，每轮换一条新的。根因是档案里混了**不同时刻、不同缓存冷热态**的链。
// 一条结构性保证：回放态的响应全部来自档案，所以「录的时候走过的链」= 「放的时候问的链」，
// 只要录与放的条件一致（同一份冷缓存）。循环就是在制造这个一致性。
//
// 四条硬约束（都是今天抓到的坑，不是想象）：
//  · 探针必须真的跑门。第一版我把探针写成 `node -e <补录脚本>`，于是「未命中 0 条」=
//    门根本没跑 ⇒ 假收敛。现在每轮校验 out 里有 [GATE] 行，没有就立即失败。
//  · 补录走门、不走手工 GET：PUT 带 body 的姿势是本仓被测点，手工重放会把它替测试写死。
//  · 每轮换新缓存目录。复用同一个 coldTmp 会让第二轮变热 ⇒ 覆盖面偏窄（热态只 miss 1 条、
//    冷态 24 条，00:45 实测）。
//  · 命令行参数不许静默忽略。见 parseConfig 上方注释（01:13 实跑成 68 套件的教训）。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { safeTempDir } from "../../src/home.js";

// 参数解析（纯函数，判据家 Test 12 锁它）。
// 为什么要单独锁：01:13 我给这个脚本传了 `--suites=… --rounds=4`，而它当时只读环境变量，
// 于是参数被**静默忽略**、实际跑成了 68 套件 × 6 轮的全门。这不是「多跑了」的小事：
// 一次静默失效会让操作者按自己以为的范围去判读结果（那次我差点把全门红因当成两套件的红因）。
// 规则：显式参数优先于 env；未知参数立即报错退出，绝不让它悄悄过去。
export function parseConfig(argv, env) {
  const out = {
    store: env.DSH_REPLAY_DIR || "",
    rounds: Number(env.DSH_REPLAY_BACKFILL_ROUNDS) || 6,
    suites: env.DSH_GATE_ONLY || "",
    timeoutMs: Number(env.DSH_GATE_TIMEOUT_MS) || 420000,
    unknown: [],
  };
  for (const a of argv) {
    const m = /^--(store|suites|rounds|timeout)=(.*)$/.exec(a);
    if (!m) { out.unknown.push(a); continue; }
    const [, k, v] = m;
    if (k === "rounds") out.rounds = Number(v) || out.rounds;
    else if (k === "timeout") out.timeoutMs = Number(v) || out.timeoutMs;
    else out[k] = v;
  }
  out.rounds = Math.max(1, Math.floor(out.rounds));
  out.timeoutMs = Math.max(30000, out.timeoutMs);
  return out;
}

// 门全绿才算这一轮可用（汇总行 N==M）。00:48 实测：`[GATE] 0/1 suites green` + 未命中 0 条，
// 若只看 miss 数就会把它当成 CONVERGED —— 那是第二层假收敛。
export function allGreen(out) {
  const m = String(out || "").match(/\[GATE\] (\d+)\/(\d+) suites green/);
  return Boolean(m) && m[1] === m[2];
}

// 红因原文：套件判定行 + FAIL/Error 行，否则「0 未命中」会把真红藏成收敛。
export function redDetail(out) {
  return String(out || "").split("\n").filter((l) =>
    /\[GATE\] test-.+\s(FAIL|TIMEOUT|NO-SUMMARY|REPLAY-MISS)/.test(l) || /\bFAIL\b/.test(l) || /Error|npm error/.test(l)
  ).slice(0, 14).map((l) => l.trim().slice(0, 170));
}

// 只有被直接执行时才跑循环：`import { parseConfig }` 触发 6 轮真门是不可接受的副作用。
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) run();

function run() {
  const W = path.resolve(import.meta.dirname, "..", "..");
  const PRELOAD = pathToFileURL(path.join(W, "test", "replay", "preload.mjs")).href;
  const GATE = path.join(W, "test", "run-gate.mjs");
  const CFG = parseConfig(process.argv.slice(2), process.env);
  if (CFG.unknown.length) {
    console.error("[BACKFILL] 未知参数：" + CFG.unknown.join(" ") + "（可用 --store --suites --rounds --timeout）");
    process.exit(2);
  }
  const store = CFG.store || path.join(W, "test", "replay", "store");
  const maxRounds = CFG.rounds;
  const gateOnly = CFG.suites;
  const perTimeout = String(CFG.timeoutMs);
  fs.mkdirSync(store, { recursive: true });

  const tmpRoot = path.join(safeTempDir(), "dsh-replay-backfill-" + process.pid);
  fs.mkdirSync(tmpRoot, { recursive: true });

  // 一次门运行：mode=record|1；每次全新的缓存目录（保证录与放条件逐字一致）。
  // 账本目录交给门（DSH_REPLAY_MISS_DIR）：上一版我自己在外面设 DSH_REPLAY_MISSLOG，
  // 被 run-gate 的每套件账本覆盖后又随 MISS_DIR 一起删掉 ⇒ 读到 0 条 = 假收敛。
  function runGate(mode) {
    const cacheDir = fs.mkdtempSync(path.join(tmpRoot, "cache-"));
    const missDir = fs.mkdtempSync(path.join(tmpRoot, "miss-"));
    const r = spawnSync(process.execPath, ["--import=" + PRELOAD, GATE], {
      cwd: W,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: Number(perTimeout) * 20,
      env: {
        ...process.env,
        DSH_REPLAY: mode,
        DSH_REPLAY_DIR: store,
        DSH_REPLAY_MISS_DIR: missDir,
        DSH_GATE_ONLY: gateOnly,
        DSH_GATE_TIMEOUT_MS: perTimeout,
        DSH_TMP: cacheDir,
      },
    });
    const out = String(r.stdout || "") + String(r.stderr || "");
    // 防假收敛：没有 [GATE] 汇总行 ⇒ 门没跑起来，本轮结论不可信。
    const summary = out.split("\n").filter((l) => /\[GATE\] \d+\/\d+ suites green/.test(l)).slice(-1)[0] || "";
    if (!summary) {
      console.log("[BACKFILL] 致命：回放探针里门没有跑（out 无 [GATE] 汇总行）\n" + out.split("\n").slice(-12).join("\n"));
      process.exit(2);
    }
    const urls = new Set();
    for (const f of fs.existsSync(missDir) ? fs.readdirSync(missDir) : []) {
      if (!f.startsWith(".miss-")) continue;
      for (const line of fs.readFileSync(path.join(missDir, f), "utf8").split("\n").filter(Boolean)) {
        try { const j = JSON.parse(line); if (j.url) urls.add(j.url); } catch { /* 半行丢弃 */ }
      }
    }
    fs.rmSync(missDir, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
    return { status: r.status, summary, green: allGreen(out), detail: redDetail(out), misses: [...urls] };
  }

  console.log("[BACKFILL] store=" + store + " suites=" + (gateOnly || "ALL") + " rounds<=" + maxRounds);

  let prev = -1, verdict = "NOT-CONVERGED", rounds = 0;
  for (let round = 1; round <= maxRounds; round++) {
    rounds = round;
    const probe = runGate("1");
    console.log("[BACKFILL] round " + round + " 回放：" + probe.summary.trim()
      + " · 未命中 " + probe.misses.length + " 条 · 门绿=" + probe.green);
    if (probe.misses.length === 0 && probe.green) { verdict = "CONVERGED"; break; }
    if (!probe.green) {
      console.log("[BACKFILL] 红因（非未命中类）：" + (probe.detail.length ? "" : "（没抓到 FAIL/Error 行）"));
      for (const l of probe.detail) console.log("[BACKFILL]   | " + l);
    }
    for (const u of probe.misses.slice(0, 8)) console.log("[BACKFILL]   MISS " + u.slice(0, 120));
    if (probe.misses.length === prev && probe.green) {
      console.log("[BACKFILL] 未命中条数不再下降（" + probe.misses.length + "）：多半是上游链本身在动或需要特定姿势，停止。");
      break;
    }
    prev = probe.misses.length;
    const rec = runGate("record");
    console.log("[BACKFILL] round " + round + " 重录：" + rec.summary.trim() + " 门绿=" + rec.green);
    if (!rec.green) console.log("[BACKFILL] 录制轮不绿 ⇒ 档案只能收到这里，红因：" + (rec.detail[0] || "?"));
  }

  const recs = fs.readdirSync(store).filter((f) => f.endsWith(".json"));
  const bytes = recs.reduce((a, f) => a + fs.statSync(path.join(store, f)).size, 0);
  console.log("[BACKFILL] rounds=" + rounds + " verdict=" + verdict + " records=" + recs.length + " bytes=" + bytes);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.exit(verdict === "CONVERGED" ? 0 : 1);
}
