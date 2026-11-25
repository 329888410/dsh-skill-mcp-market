#!/usr/bin/env node
// test/replay/engine.mjs — 门提速方案 B 的录制/回放内核。
//
// 背景（用户 2026-11-24 口径，实测于 gate164-post.txt）：装后门 1064s 里 970s 花在
// 10 个真打上游的套件上（nocache 249 / paging 161 / features 138 / sort-options 129 /
// warmup 89 / sort-honesty 63 / warm-budget 49 / total-pages 49 / full-sort 48 /
// global-sort 35），其余 52 个套件合计 3s；而门每轮要跑两遍（提交前 + 装后）。
// 提速的前提不是删断言，而是把「真网络」换成「可重放的确定输入」。
//
// 反假绿铁律（本仓 CHANGELOG 自己写下的「绿不等于做了」，以及用户点名的
// 「回放会把上游形状漂移藏起来」）：
//   ① 回放态未命中 = 抛 REPLAY-MISS，绝不返回空数组/空对象。空响应等于宣称
//      「该源没有数据」，会让分页、分类、total 类判据全体假绿。
//   ② 录制态把失败也落档（错误文案原样回放），否则「上游不可达时的诚实降级」
//      这条判据在回放里就没人测了。
//   ③ 真网络门不许消失：DSH_REPLAY 未设时本模块完全不参与（preload 不注册钩子），
//      CI 与提交前的全量门照旧真打上游。
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export const SCHEMA = "dsh-replay-v1";

export function mode() {
  const m = process.env.DSH_REPLAY_MODE || process.env.DSH_REPLAY || "";
  if (m === "record") return "record";
  if (m === "1" || m === "replay") return "replay";
  return "off";
}

export function replayDir() {
  return process.env.DSH_REPLAY_DIR
    || join(process.env.DSH_REPLAY_ROOT || process.cwd(), "test", "replay", "store");
}

// query 值先解码再统一 percent-encode：同一个逻辑请求常有多种编码形态
// （cursor 这类不透明值里就带 / 和 : —— 套件把上游返回值原样拼进 URL，
// 而按文档姿势补录时是 %2F/%3A）。不做归一，两条形态在键上互不相通，
// 补录永远收敛不了（2026-11-25 00:36 实测：补一条游标页就冒下一条）。
function normalizeUrl(u) {
  try {
    const x = new URL(u);
    const pairs = [];
    x.searchParams.forEach((v, k) => pairs.push(k + "=" + v));
    pairs.sort();
    if (pairs.length) x.search = "?" + pairs.map((p) => { const i = p.indexOf("="); return encodeURIComponent(p.slice(0, i)) + "=" + encodeURIComponent(p.slice(i + 1)); }).join("&");
    else x.search = "";
    return x.href;
  } catch { return String(u); }
}
// 键 = 方法 + 归一化后的完整 URL（含 query）+ 请求体。query 必须整个进键：否则
// 「换分类/换页不重拉」这类判据会被同一条记录糊过去（0.5.163 的 cacheKey 教训同款）。
export function requestKey({ method = "GET", url, body = "" }) {
  const text = body == null ? "" : String(body);
  const h = createHash("sha256");
  h.update(`${String(method).toUpperCase()} ${normalizeUrl(url)}\n${text}`);
  return h.digest("hex").slice(0, 32);
}

export class MissError extends Error {
  constructor(key, url) {
    super(`REPLAY-MISS ${key} ${String(url).slice(0, 200)}`);
    this.code = "REPLAY_MISS";
    this.key = key;
    noteMiss(key, url);
  }
}

// 未命中也写一份「账本」，交给门去判红。
// 为什么不能只靠抛错：实测 test-global-sort.mjs 在空档案下抛 REPLAY-MISS 后，
// 套件自己的 try/catch 把它降级成 skip，照样打印「4 passed, 0 failed, 3 skipped」退出 0
// —— 录了 9 条断言的那轮是「9 passed, 2 skipped」，等于 5 条判据静默蒸发而门仍放行。
// 门的判定必须是「有没有未命中」，而不是「套件自己怎么说」（CHANGELOG「绿不等于做了」）。
export function noteMiss(key, url) {
  const log = process.env.DSH_REPLAY_MISSLOG;
  if (!log) return;
  try {
    appendFileSync(log, JSON.stringify({ key, url: String(url).slice(0, 300), at: Date.now() }) + "\n");
  } catch { /* 账本不可写不该改变被测行为 */ }
}

export function missCount(logPath) {
  if (!logPath || !existsSync(logPath)) return 0;
  try {
    return readFileSync(logPath, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

function fileFor(dir, key) {
  return join(dir, `${key}.json`);
}

export function lookup({ dir, key }) {
  const p = fileFor(dir, key);
  if (!existsSync(p)) return null;
  try {
    const rec = JSON.parse(readFileSync(p, "utf8"));
    // 档案损坏或 schema 不符一律按未命中处理：宁可 REPLAY-MISS，不可半读。
    return rec && rec.schema === SCHEMA ? rec : null;
  } catch {
    return null;
  }
}

export function store({ dir, key, entry }) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(fileFor(dir, key), JSON.stringify({ schema: SCHEMA, ...entry }));
  return fileFor(dir, key);
}

/** 一次「取文本」的录制/回放。real() 是真网络路径，off 态直接走它。 */
export async function textViaCache({ method = "GET", url, body = "", real }) {
  const m = mode();
  if (m === "off") return real();
  const dir = replayDir();
  const key = requestKey({ method, url, body });
  if (m === "replay") {
    const rec = lookup({ dir, key });
    if (!rec) throw new MissError(key, url);
    if (rec.error) throw new Error(rec.error);
    return rec.text;
  }
  try {
    const text = await real();
    store({ dir, key, entry: { method, url, body: String(body || ""), text } });
    return text;
  } catch (error) {
    // 失败也是被测事实：回放态要能重现同一句降级文案，不许只录成功。
    store({
      dir,
      key,
      entry: { method, url, body: String(body || ""), error: String((error && error.message) || error).slice(0, 400) },
    });
    throw error;
  }
}

/** JSON 通道的录制/回放：档案里存序列化文本，回放时 parse，保证与真网络同一条解析路径。 */
export async function jsonViaCache({ method = "GET", url, body = "", real }) {
  const m = mode();
  if (m === "off") return real();
  const dir = replayDir();
  const key = requestKey({ method, url, body });
  if (m === "replay") {
    const rec = lookup({ dir, key });
    if (!rec) throw new MissError(key, url);
    if (rec.error) throw new Error(rec.error);
    return JSON.parse(rec.text);
  }
  try {
    const value = await real();
    store({ dir, key, entry: { method, url, body: String(body || ""), text: JSON.stringify(value) } });
    return value;
  } catch (error) {
    store({
      dir,
      key,
      entry: { method, url, body: String(body || ""), error: String((error && error.message) || error).slice(0, 400) },
    });
    throw error;
  }
}

/** 二进制落盘通道（pythonDownload 用于仓库归档）。 */
export async function fileViaCache({ url, target, real }) {
  const m = mode();
  if (m === "off") return real();
  const dir = replayDir();
  const key = requestKey({ method: "GET", url, body: "" });
  if (m === "replay") {
    const rec = lookup({ dir, key });
    if (!rec) throw new MissError(key, url);
    if (rec.error) throw new Error(rec.error);
    writeFileSync(target, Buffer.from(rec.base64 || "", "base64"));
    return target;
  }
  try {
    await real();
    store({ dir, key, entry: { method: "GET", url, base64: readFileSync(target).toString("base64") } });
    return target;
  } catch (error) {
    store({ dir, key, entry: { method: "GET", url, error: String((error && error.message) || error).slice(0, 400) } });
    throw error;
  }
}

// 只截「真打网络的子进程」：npx/npm/curl。git、tar、sh 是本地动作，
// 录进档案会把「刚改完的仓库状态」冻成旧答案（test-profile-sync 那类源码锁会假绿）。
export function isNetworkCli(file, args) {
  const f = String(file || "").toLowerCase().replace(/\\/g, "/");
  const a = (args || []).map((x) => String(x).toLowerCase());
  const joined = a.join(" ");
  if (/\/?curl(\.exe)?$/.test(f) || f === "curl" || f === "curl.exe") return true;
  if (/\/?npx(\.cmd)?$/.test(f) || f === "npx" || f === "npx.cmd") return true;
  if (/\/?npm(\.cmd)?$/.test(f) || f === "npm" || f === "npm.cmd") return true;
  // Windows 姿势：cmd.exe /d /s /c "npx -y …"，网络动作藏在最后一段命令行里。
  return /(^|\s)(npx|npm|curl)(\s|$|\.)/.test(joined);
}

/** 子进程通道的录制/回放；键是整条 argv（CLI 的 argv 就是它的请求身份）。 */
export async function cliViaCache({ file, args, options, real, realSync }) {
  if (!isNetworkCli(file, args)) return real();
  const m = mode();
  if (m === "off") return real();
  const dir = replayDir();
  const url = `${String(file)} ${JSON.stringify(args || [])}`;
  const key = requestKey({ method: "CLI", url, body: "" });
  if (m === "replay") {
    const rec = lookup({ dir, key });
    if (!rec) throw new MissError(key, url);
    if (rec.error) throw new Error(rec.error);
    return { stdout: rec.stdout || "", stderr: rec.stderr || "" };
  }
  try {
    const r = await real();
    store({ dir, key, entry: { method: "CLI", url, stdout: String((r && r.stdout) || ""), stderr: String((r && r.stderr) || "") } });
    return r;
  } catch (error) {
    store({ dir, key, entry: { method: "CLI", url, error: String((error && error.message) || error).slice(0, 400) } });
    throw error;
  }
}

/** 回放态的 Response 替身：只实现生产真用到的面（ok/status/headers.get/text/json）。 */
export function fakeResponse(rec, url) {
  const text = typeof rec.text === "string" ? rec.text : "";
  const status = typeof rec.status === "number" ? rec.status : 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    url,
    headers: {
      get(name) {
        const map = rec.headers || {};
        const hit = Object.keys(map).find((k) => k.toLowerCase() === String(name).toLowerCase());
        return hit ? map[hit] : null;
      },
    },
    async text() { return text; },
    async json() { return JSON.parse(text); },
    body: null,
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(text); },
  };
}

export function countRecords(dir) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith(".json")).length;
}

export function storeBytes(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".json")) n += readFileSync(join(dir, f)).length;
  }
  return n;
}
