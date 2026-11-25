// test/replay/preload.mjs — 门提速方案 B 的预加载入口（NODE_OPTIONS=--import=…）。
//
// 为什么走预加载而不是改 14 处生产调用：取证（2026-11-24）证明
// ① resolve/load 钩子能命中「生产模块内部的相对导入 ./http.js」（实验 probe-nested2.mjs：
//    替身数据被 src/lobehub-market.js:301 的 getJson 真读到，抛出的是生产逻辑错而非网络错）；
// ② 替换 globalThis.fetch 能截住绕过 http.js 的裸 fetch（实验 probe-preload2.mjs）。
// 于是单一注入点覆盖 curl / python / node fetch 三条传输 + 14 处裸 fetch，生产代码零改动。
//
// 三种模式（env DSH_REPLAY）：
//   未设/off     → 完全惰性，什么都不做（默认门照旧真打上游）
//   record       → 真打上游，同时把响应写进档案
//   1 / replay   → 只读档案；未命中抛 REPLAY-MISS，绝不返回空（空 = 「该源没有数据」= 假绿）
import { register } from "node:module";

const MODE = process.env.DSH_REPLAY || "";
if (MODE === "record" || MODE === "1" || MODE === "replay") {
  process.env.DSH_REPLAY_MODE = MODE === "record" ? "record" : "replay";
  register(new URL("./hooks.mjs", import.meta.url).href);
  // 裸 fetch 走 globalThis 补丁（钩子管不到全局对象）。
  await import("./fetch-patch.mjs");
}
