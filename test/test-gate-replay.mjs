#!/usr/bin/env node
// test/test-gate-replay.mjs — 门提速方案 B（录制/回放）的判据家。零真网络：上游用本地 http 服务器假扮。
//
// 为什么先立它（用户 21:45 定 B 为主刀，纪律=RED 先行）：提速的前提不是删断言，
// 而是把「真网络」换成「可重放的确定输入」，而**回放最容易犯的错是把上游形状漂移藏起来**
// ——本仓 CHANGELOG 自己写下过「『绿』不等于『做了』」，全回放的门正好是那个坑的反面。
// 所以这里的判据不是「跑得快」，而是四条诚实性：
//   ① 未录到的请求必须抛 REPLAY-MISS，绝不返回空数组/空对象（空 = 「该源没有数据」= 假绿）；
//   ② 请求身份必须含 query 与 body（否则「换分类/换页不重拉」类判据被同一条记录糊过去）；
//   ③ 失败也要落档并原样重现（「上游不可达时的诚实降级」这条判据不许在回放里消失）；
//   ④ 真网络门不许消失（DSH_REPLAY 未设时零参与），且本地动作（git/tar/sh）不许冻进档案。
//
// 判据 9 是门侧接线（run-gate 注入 --import + 契约同批改），实现未落 ⇒ 预期 RED。
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { safeTempDir } from "../src/home.js";
import * as engine from "./replay/engine.mjs";
import { parseConfig, allGreen, redDetail } from "./replay/backfill.mjs";

const W = fileURLToPath(new URL("..", import.meta.url));
const PRELOAD = pathToFileURL(join(W, "test", "replay", "preload.mjs")).href;
let passed = 0, failed = 0, skipped = 0;
const check = (n, ok, d = "") => { if (ok) { passed++; console.log("  \u2713 " + n); } else { failed++; console.log("  \u2717 " + n + (d ? "  [" + String(d).slice(0, 170) + "]" : "")); } };
const skip = (n, d = "") => { skipped++; console.log("  SKIP " + n + (d ? "  [" + String(d).slice(0, 90) + "]" : "")); };

// ---------------------------------------------------------------- 假上游
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += String(c); });
  req.on("end", () => {
    server.__hits.push(req.url + "|" + body);
    if (req.url.startsWith("/boom")) { res.writeHead(500); res.end("not json at all"); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, url: req.url, body, seq: server.__hits.length }));
  });
});
server.__hits = [];
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const storeDir = join(safeTempDir(), "dsh-replay-" + Date.now());
mkdirSync(storeDir, { recursive: true });

// 子进程跑一段脚本，带回它的 stdout/stderr。
// ⚠️ 必须异步：假上游服务器跑在**父进程**的事件循环里，用 spawnSync 会把父进程阻塞住，
// 子进程的请求永远排不到响应 ⇒ 首版 Test 2/5/8 全红、Test 4「因为错而绿」的假绿就是这个坑。
const run = (script, env, withPreload = true) => new Promise((resolve) => {
  // DSH_REPLAY_MISSLOG 显式改到私有文件：门用每套件一份账本，而本套件的子进程
  // **故意**打未录请求（Test 3 的 never-recorded=1 就是要证守卫生效）。若让它继承
  // 门塞进来的账本，这条故意 miss 会被门算成「本套件有未命中」⇒ 判据家自己在回放态
  // 必然假红（01:48/01:52 两次实测：`.miss-<pid>-test-gate-replay.mjs.log = 1`）。
  // 守卫的行为由 Test 3 自己断言，门的账本只该记「意外逃逸」的网络。
  const nodeEnv = { ...process.env, DSH_REPLAY_MISSLOG: join(storeDir, ".private-miss.log"), DSH_REPLAY_DIR: storeDir, ...env };
  if (withPreload) nodeEnv.NODE_OPTIONS = "--import=" + new URL("./replay/preload.mjs", import.meta.url).href;
  else delete nodeEnv.NODE_OPTIONS;
  const kb = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 120000);
  const p = spawn(process.execPath, ["-e", script], { cwd: W, env: nodeEnv });
  let stdout = "", stderr = "";
  p.stdout.on("data", (d) => { stdout += String(d); });
  p.stderr.on("data", (d) => { stderr += String(d); });
  p.on("close", (status) => { clearTimeout(kb); resolve({ status, stdout, stderr }); });
});

console.log("\nTest 1: 键含 query 与 body（否则换分类/换页被同一条记录糊过去）");
{
  const a = engine.requestKey({ method: "PUT", url: ORIGIN + "/api?PageNumber=1&Query=pdf", body: "{}" });
  const b = engine.requestKey({ method: "PUT", url: ORIGIN + "/api?PageNumber=2&Query=pdf", body: "{}" });
  const c = engine.requestKey({ method: "PUT", url: ORIGIN + "/api?PageNumber=1&Query=pdf", body: '{"category":"市场推广"}' });
  check("换页改键", a !== b, "a==b");
  check("换 body 改键", a !== c, "a==c");
  const d = engine.requestKey({ method: "PUT", url: ORIGIN + "/api?PageNumber=1&Query=pdf", body: "{}" });
  check("同请求同键（可重放）", a === d, a + "!=" + d);
}

console.log("\nTest 2: 录制态真打一次并落档；回放态零网络命中同一份字节");
{
  server.__hits.length = 0;
  const script = `
    import { getJson } from "./src/http.js";
    const r = await getJson("${ORIGIN}/api?PageNumber=1");
    console.log("JSON:" + JSON.stringify(r));
  `;
  const rec = await run(script, { DSH_REPLAY: "record" });
  const recOut = String(rec.stdout || "");
  check("record 子进程退出 0", (rec.status || 0) === 0, "status=" + rec.status + " " + String(rec.stderr || "").slice(0, 140));
  check("record 真打了上游一次", server.__hits.length === 1, "hits=" + server.__hits.length);
  const recJson = (recOut.match(/JSON:(.*)/) || [])[1];
  check("record 拿到响应", Boolean(recJson), recOut.slice(0, 120));

  server.__hits.length = 0;
  const rep = await run(script, { DSH_REPLAY: "1" });
  const repJson = (String(rep.stdout || "").match(/JSON:(.*)/) || [])[1];
  check("replay 子进程退出 0", (rep.status || 0) === 0, "status=" + rep.status + " " + String(rep.stderr || "").slice(0, 140));
  check("replay 零真网络", server.__hits.length === 0, "hits=" + server.__hits.length);
  check("replay 字节与 record 同值", repJson === recJson, "rec=" + String(recJson).slice(0, 60) + " rep=" + String(repJson).slice(0, 60));
}

console.log("\nTest 3: 未录到必须 REPLAY-MISS，绝不返回空（反假绿的核心一条）");
{
  server.__hits.length = 0;
  const script = `
    import { getJson } from "./src/http.js";
    try {
      const r = await getJson("${ORIGIN}/api?never-recorded=1");
      console.log("RETURNED:" + JSON.stringify(r));
    } catch (e) {
      // 消息里带「哪条请求没录到」才可诊断；截 40 字会把 URL 切掉（首版就这么假红过）
      console.log("THREW:" + (e.code || "") + ":" + String(e.message).slice(0, 240));
    }
  `;
  const r = await run(script, { DSH_REPLAY: "1" });
  const out = String(r.stdout || "");
  check("未录请求抛错而非返回空", /THREW:REPLAY_MISS/.test(out), out.trim().slice(0, 140));
  check("抛错里带请求身份（能定位哪条没录到）", /never-recorded=1/.test(out), out.trim().slice(0, 140));
  check("回放态没偷偷打上游", server.__hits.length === 0, "hits=" + server.__hits.length);
}

console.log("\nTest 4: 失败也落档，回放态重现同一句错误（诚实降级不许在回放里消失）");
{
  server.__hits.length = 0;
  const script = `
    import { getJson } from "./src/http.js";
    try { await getJson("${ORIGIN}/boom"); console.log("NO-ERROR"); }
    catch (e) { console.log("ERR:" + String(e.message).slice(0, 60)); }
  `;
  const rec = await run(script, { DSH_REPLAY: "record" });
  const recErr = ((String(rec.stdout || "").match(/ERR:(.*)/) || [])[1] || "").trim();
  check("record 态失败被录下", Boolean(recErr), String(rec.stdout || "").trim().slice(0, 120));
  server.__hits.length = 0;
  const rep = await run(script, { DSH_REPLAY: "1" });
  const repErr = ((String(rep.stdout || "").match(/ERR:(.*)/) || [])[1] || "").trim();
  check("replay 态错误文案一致", repErr === recErr && Boolean(repErr), "rec=" + recErr + " rep=" + repErr);
  check("replay 态零真网络", server.__hits.length === 0, "hits=" + server.__hits.length);
}

console.log("\nTest 5: 绕过 http.js 的裸 fetch 也被截（实测 14 处，钩子管不到全局对象）");
{
  server.__hits.length = 0;
  const script = `
    const r = await fetch("${ORIGIN}/bare?x=1");
    console.log("BARE:" + JSON.stringify(await r.json()));
  `;
  const rec = await run(script, { DSH_REPLAY: "record" });
  check("裸 fetch 录制成功", (rec.status || 0) === 0 && /BARE:/.test(String(rec.stdout || "")), String(rec.stderr || "").slice(0, 140));
  const n = server.__hits.length;
  server.__hits.length = 0;
  const rep = await run(script, { DSH_REPLAY: "1" });
  check("裸 fetch 回放零网络", server.__hits.length === 0 && n === 1, "recHits=" + n + " repHits=" + server.__hits.length);
  check("裸 fetch 回放的 Response 可用（ok/json）", /"ok":true/.test(String(rep.stdout || "")), String(rep.stdout || "").trim().slice(0, 120));
}

console.log("\nTest 6: 本地动作不许冻进档案（git/tar/sh 必须放行回真）");
{
  check("npx 判定为网络", engine.isNetworkCli("npx", ["-y", "@lobehub/market-cli", "search"]) === true, "npx");
  check("curl 判定为网络", engine.isNetworkCli("curl.exe", ["-s", ORIGIN]) === true, "curl");
  check("cmd.exe 里包 npx 也判定为网络", engine.isNetworkCli("cmd.exe", ["/d", "/s", "/c", 'npx -y "browse" skills find']) === true, "cmd+npx");
  check("git 不判为网络", engine.isNetworkCli("git", ["ls-remote", "origin", "master"]) === false, "git");
  check("tar 不判为网络", engine.isNetworkCli("tar", ["-xzf", "a.tgz"]) === false, "tar");
  check("sh 不判为网络", engine.isNetworkCli("sh", ["-c", "printf x >> ~/.profile"]) === false, "sh");
  check("node 不判为网络", engine.isNetworkCli(process.execPath, ["test/x.mjs"]) === false, "node");
}

console.log("\nTest 7: 替身导出面与真模块逐字对齐（少一个名字=链接期崩=没有汇总行的红）");
{
  const realSrc = readFileSync(join(W, "src", "http.js"), "utf8");
  const realNames = [...realSrc.matchAll(/export async function (\w+)|export function (\w+)/g)].map((m) => m[1] || m[2]).sort();
  check("真模块导出六个通道", realNames.length === 6, realNames.join(","));
  const probe = await run(`
    import * as h from "./src/http.js";
    console.log("EXPORTS:" + Object.keys(h).sort().join(","));
  `, { DSH_REPLAY: "1" });
  const got = ((String(probe.stdout || "").match(/EXPORTS:(.*)/) || [])[1] || "").trim().split(",").filter(Boolean);
  check("回放态导出名与真模块全等", got.join(",") === realNames.join(","), "got=" + got.join(",") + " want=" + realNames.join(","));
}

console.log("\nTest 8: DSH_REPLAY 未设时零参与（真网络门不许消失）");
{
  server.__hits.length = 0;
  const script = `
    import { getJson } from "./src/http.js";
    const r = await getJson("${ORIGIN}/api?off=1");
    console.log("OFF:" + JSON.stringify(r).slice(0, 40));
  `;
  const off = await run(script, { DSH_REPLAY: "" }, false);
  check("off 态真打上游", server.__hits.length === 1, "hits=" + server.__hits.length);
  check("off 态拿到响应", /OFF:.*"ok":true/.test(String(off.stdout || "")), String(off.stdout || "").trim().slice(0, 120));
  // mode 必须问**子进程**，不能问父进程自身：门在回放态把 DSH_REPLAY=1 传给了每个套件，
  // 于是「父进程 engine.mode()==='off'」这条在 DSH_REPLAY=1 下跑门时必然假红（01:32 实测）。
  // 真正要证的是「没带 DSH_REPLAY 的子进程视自己为 off」，与本套件的其它判据同一姿势。
  const modeProbe = spawnSync(process.execPath, ["-e", "import('./test/replay/engine.mjs').then(m=>console.log('MODE:'+m.mode()))"], {
    cwd: W, encoding: "utf8", timeout: 60000,
    env: { ...process.env, DSH_REPLAY: "", DSH_REPLAY_MODE: "" },
  });
  check("子进程不带 DSH_REPLAY 时 mode=off", /MODE:off/.test(String(modeProbe.stdout || "")), String(modeProbe.stdout || "").trim().slice(0, 80));
}

console.log("\nTest 9: 门侧接线（run-gate 注入 --import，且契约同批改）");
{
  const gateSrc = readFileSync(join(W, "test", "run-gate.mjs"), "utf8");
  check("run-gate 读 DSH_REPLAY 并注入 --import", /DSH_REPLAY/.test(gateSrc) && /--import/.test(gateSrc), "run-gate.mjs 里未见 DSH_REPLAY/--import");
  check("注入走 spawn 参数而非 NODE_OPTIONS 继承（实验 6 证伪过继承自欺）", /execPath,\s*\[[^\]]*--import/.test(gateSrc) || /replayArgs/.test(gateSrc), "未见显式 --import 参数注入");
  const contractSrc = readFileSync(join(W, "test", "test-gate-contract.mjs"), "utf8");
  check("契约锁住「回放态未命中让门变红」", /REPLAY[-_]MISS|REPLAY_MISS/.test(contractSrc), "test-gate-contract 未锁这条");
  const pkg = JSON.parse(readFileSync(join(W, "package.json"), "utf8"));
  check("本套件已登记进 test:chain", /test-gate-replay\.mjs/.test(pkg.scripts["test:chain"] || ""), "未登记 ⇒ 门不会跑它");
}

console.log("\nTest 10: 门侧端到端 —— 空档案回放必须让门真红（不许因套件自报 skip 而放行）");
{
  const emptyDir = join(storeDir, "..", "dsh-replay-empty-" + Date.now());
  mkdirSync(emptyDir, { recursive: true });
  const gate = await new Promise((resolve) => {
    const p = spawn(process.execPath, ["test/run-gate.mjs"], {
      cwd: W,
      env: {
        ...process.env,
        DSH_REPLAY: "1",
        DSH_REPLAY_DIR: emptyDir,
        DSH_GATE_ONLY: "test-global-sort.mjs",
        DSH_GATE_TIMEOUT_MS: "120000",
        // 账本目录显式指定并隔离：不设时 run-gate 用 `.miss-<父pid>-<套件>.log`，
        // 而父进程就是本套件 ⇒ 文件名与我 Test 11 那份撞车，01:48 实测外层读到
        // `.miss-25296-test-global-sort.mjs.log = 3`（Test 10 的 miss 记在 Test 11 账里）。
        DSH_REPLAY_MISS_DIR: emptyDir + "-miss",
      },
    });
    let out = "";
    p.stdout.on("data", (d) => { out += String(d); });
    p.stderr.on("data", (d) => { out += String(d); });
    p.on("close", (status) => resolve({ status, out }));
  });
  check("门判 REPLAY-MISS 而非 PASS", /REPLAY-MISS/.test(gate.out), gate.out.split("\n").slice(0, 4).join(" | ").slice(0, 160));
  check("门退出码非 0（发布被拦）", (gate.status || 0) !== 0, "status=" + gate.status);
  check("红灯里有 publish blocked", /publish blocked/.test(gate.out), '');
  try { rmSync(emptyDir, { recursive: true, force: true }); rmSync(emptyDir + "-miss", { recursive: true, force: true }); } catch {}
}

console.log("\nTest 12: 编排器参数不许静默忽略（01:13 我传 --suites/--rounds 被吞，实跑成 68 套件）");
{
  const env = { DSH_GATE_ONLY: "from-env.mjs", DSH_REPLAY_BACKFILL_ROUNDS: "6", DSH_GATE_TIMEOUT_MS: "420000" };
  const d = parseConfig([], env);
  check("无参数时回退 env", d.suites === "from-env.mjs" && d.rounds === 6, JSON.stringify(d));
  const o = parseConfig(["--suites=a.mjs,b.mjs", "--rounds=2", "--store=X"], env);
  check("显式参数优先于 env", o.suites === "a.mjs,b.mjs" && o.rounds === 2 && o.store === "X", JSON.stringify(o));
  const u = parseConfig(["--suites=a.mjs", "--seuits=a.mjs"], env);
  check("拼错的参数进 unknown（不静默）", u.unknown.length === 1 && u.unknown[0] === "--seuits=a.mjs", JSON.stringify(u.unknown));
  const bad = parseConfig(["--rounds=0", "--timeout=1"], env);
  check("rounds/timeout 有下界", bad.rounds >= 1 && bad.timeoutMs >= 30000, JSON.stringify(bad));
  const g = allGreen("[GATE] 10/10 suites green");
  const g2 = allGreen("[GATE] 6/10 suites green");
  check("allGreen 要 N===M（00:48 的 0/1 假收敛）", g === true && g2 === false, g + "/" + g2);
  check("allGreen 无汇总行时为假", allGreen("node: something") === false, "should be false");
  const r = redDetail("[GATE] test-x.mjs FAIL 3s 2 passed, 1 failed\nnoise\n[GATE] 5/6 suites green");
  check("redDetail 抓到红套件行", r.some((l) => /test-x\.mjs FAIL/.test(l)), JSON.stringify(r));
}

console.log("\nTest 13: 假 npx 夹具在回放态必须放行回真（CLI 档案通道不得截走零网络的 shim）");
{
  // 02:05 全门回放实测：lobehub 套件自带假 npx（PATH 首位目录放 npx.cmd+cli.cjs，argv 落盘自证），
  // 这条 npx 根本不碰网络，却被 cp-replay 当成网络动作从档案取答案 ⇒ 「CLI 真收到 --category」
  // 读到 argv=null，9 条判据全红。修法=认这对孪生夹具文件，命中就放行回真 execFile。
  // ⚠️ 判据必须从生产模块打进去：hooks 只把 CP_PARENTS 白名单（extra-sources/sources/
  // lobehub-market/cli-install）的 node:child_process 换成替身，`node -e` 直接 import
  // child_process 走的是真模块——首版这么写，关掉 fixtureShimActive 的变异照样绿（空判据）。
  if (process.platform !== "win32") {
    skip("假 npx 夹具仅在 win32 有意义", "process.platform=" + process.platform);
  } else {
    // 夹具目录放 worktree（纯 ASCII）而非 safeTempDir：这台机器的临时目录含中文用户名，
    // npx.cmd 里写的是 UTF-8 路径、cmd.exe 按 OEM 码页读批处理 ⇒ 子 node 报
    // ERR_MODULE_NOT_FOUND（02:47 实测，与夹具识别逻辑无关）。本判据要测的是
    // 「夹具态 execFile 是否放行回真」，不该被路径编码绑住。真实套件自己写自己读、
    // 同进程同码页，所以它在 safeTempDir 下能跑通。
    const shimDir = join(W, "test", ".t13-shim-" + process.pid);
    mkdirSync(shimDir, { recursive: true });
    const argvOut = join(shimDir, "argv.json");
    const nodeBin = process.execPath;
    writeFileSync(join(shimDir, "cli.cjs"),
      'const fs=require("fs");fs.writeFileSync(process.env.LH_ARGV_OUT,JSON.stringify(process.argv.slice(2)));process.stdout.write("{\\"categories\\":[]}")', "utf8");
    writeFileSync(join(shimDir, "npx.cmd"), '@echo off' + "\r\n" + '"' + nodeBin + '" "' + join(shimDir, "cli.cjs") + '" %*' + "\r\n", "utf8");
    // 从生产入口 searchLobeHubMarket（其 runCli 的 execFile 会被 hooks 重定向到 cp-replay）打进：
    // 空档案 + 夹具在 PATH ⇒ 放行回真则 argv.json 落盘；替身若截走则 REPLAY-MISS、argv.json 不生成。
    const script = `
      import { searchLobeHubMarket } from "./src/lobehub-market.js";
      import { makeCache } from "./src/sources.js";
      try {
        const r = await searchLobeHubMarket({ query: "agent", cache: makeCache(process.env.LH_CACHE) });
        console.log("RES=" + JSON.stringify(r && r.items ? r.items.length : r).slice(0, 60));
      } catch (e) { console.log("ERR=" + JSON.stringify({ code: e && e.code, msg: String(e && e.message).slice(0, 700) })); }
    `;
    const rep = await run(script, {
      DSH_REPLAY: "1",
      PATH: shimDir + ";" + process.env.PATH,
      LH_ARGV_OUT: argvOut,
      LH_CACHE: join(safeTempDir(), "dsh-lh-cache-" + process.pid),
    });
    const wrote = existsSync(argvOut) ? readFileSync(argvOut, "utf8") : "";
    check("夹具态生产 CLI 调用放行回真（argv 落盘含 --q agent）", wrote.includes("--q") && wrote.includes("agent"),
      "argv.json=" + (wrote ? wrote.slice(0, 120) : "(无)") + " stdout=" + String(rep.stdout || "").trim().slice(0, 700) + " err=" + String(rep.stderr || "").slice(0, 200));
    const missed = /REPLAY-MISS|REPLAY_MISS/.test(String(rep.stdout || "") + String(rep.stderr || ""));
    check("夹具态没有 REPLAY-MISS 逃逸（不该被档案截）", !missed, String(rep.stdout || rep.stderr || "").slice(0, 120));
    server.__hits.length = 0;
    try { rmSync(shimDir, { recursive: true, force: true }); } catch {}
  }
}

server.close();
try { rmSync(storeDir, { recursive: true, force: true }); } catch {}

console.log("\nTest 11: 账本可被外层编排者读取（run-gate 不得把外层指定的账本删掉）");
{
  // 00:48 实测的假收敛：backfill 在门外自己设 DSH_REPLAY_MISSLOG ⇒ 被 run-gate 的
  // 每套件账本覆盖，门末又删整个 MISS_DIR ⇒ 外层永远读到 0 条。契约锁 run-gate 的
  // 源码形态；这条锁行为：外层给 DSH_REPLAY_MISS_DIR ⇒ 门跑完账本仍在、且有内容。
  const missRoot = join(safeTempDir(), "dsh-replay-missout-" + Date.now());
  mkdirSync(missRoot, { recursive: true });
  const r = spawnSync(process.execPath, ["--import=" + PRELOAD, join(W, "test", "run-gate.mjs")], {
    cwd: W, encoding: "utf8", timeout: 120000,
    env: {
      ...process.env,
      DSH_REPLAY: "1", DSH_REPLAY_DIR: storeDir, DSH_REPLAY_MISS_DIR: missRoot,
      DSH_GATE_ONLY: "test-global-sort.mjs", DSH_GATE_TIMEOUT_MS: "300000",
      DSH_TMP: storeDir,   // 门内的套件会往缓存写东西；把 DSH_TMP 也钉进临时区
    },
  });
  const logs = existsSync(missRoot) ? readdirSync(missRoot).filter((f) => f.startsWith(".miss-")) : [];
  check("门跑完外层账本目录仍在", existsSync(missRoot), "被门删了");
  check("外层账本有内容（未命中真的记了账）", logs.length > 0, "账本空=" + logs.length);
  server.__hits.length = 0;
  try { rmSync(missRoot, { recursive: true, force: true }); } catch {}
}

console.log("\nTest 14: 显式传 env 的子进程调用必须带 ...process.env（否则 NODE_OPTIONS 在孙进程里丢，回放注入静默失效）");
{
  // 注入链是这样传的：门给子进程塞 NODE_OPTIONS=--import=preload，子进程再 spawn npx/curl/python。
  // 只要生产里有一处 env 不带 ...process.env，这一层就断在那儿 ⇒ 那个孙进程走真网络，
  // 而档案以为它被截住了（01:32 全门那轮的「假零网络」风险正是同一形状）。
  // 03:29 扫过 src/*.js + index.js：五处显式 env 全部合规
  // （cli-install.js:40、http.js:172/:202/:277、lobehub-market.js:61），这条锁的是「以后别改坏」。
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name.endsWith(".js")) files.push(join(d, e.name));
    }
  };
  walk(join(W, "src"));
  files.push(join(W, "index.js"));
  const offenders = [];
  const compliant = [];
  for (const f of files) {
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!/env\s*:\s*\{/.test(line)) return;
      const window = lines.slice(Math.max(0, i - 12), i + 1).join(" ");
      if (!/execFile\(|spawn\(|spawnSync\(|fork\(|exec\(/.test(window)) return;
      if (/\.\.\.process\.env/.test(line)) compliant.push(relative(W, f) + ":" + (i + 1));
      else offenders.push(relative(W, f) + ":" + (i + 1) + " " + line.trim().slice(0, 90));
    });
  }
  check("零处显式 env 丢 process.env", offenders.length === 0, offenders.join(" | "));
  // 扫描本身要有效：现在必须真扫到那几处（扫到 0 处 = 判据是空的，02:38 的教训）。
  check("扫描确实命中显式 env 调用点（非空判据）", compliant.length >= 5, "命中=" + compliant.length + " [" + compliant.join(", ") + "]");
}

console.log("\n" + passed + " passed, " + failed + " failed, " + skipped + " skipped");
process.exit(failed ? 1 : 0);
