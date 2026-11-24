// test/replay/hooks.mjs — 门提速方案 B 的 ESM 钩子：三处顶替，覆盖全部真网络通道。
//
// (1) src/http.js → http-replay.mjs（curl / python / node fetch 三条传输一起截）。
//     取证（.tmp-inspect/probe-nested2.mjs）：钩子能命中「生产模块内部的相对导入 ./http.js」
//     —— 替身数据被 src/lobehub-market.js:301 的 getJson 真读到，抛出的是生产逻辑错而非网络错。
//     ⇒ 生产代码零改动，不必给 14 处调用点穿 transport 参数（用户 21:45 方案 B 的原始设想）。
// (2) node:child_process → cp-replay.mjs，但只对 src 里 4 个用 npx/curl 打网络的模块。
// (3) globalThis.fetch → fetch-patch.mjs（14 处绕过 http.js 的裸 fetch，钩子管不到全局对象）。
//
// 内置模块说明符可被整体顶替是实测结论（probe-hooks2.mjs + probe-builtin-hook.mjs：
// `callback form => "STUB-EXECFILE"`）；早期 probe-preload.mjs 改 require 缓存里的
// cp.execFile 是**无效**的（ESM 命名导入输出 "REAL"），别再用那条路。
//
// 替身源码里注入 ENGINE_URL / REAL_URL 两个常量：注入源码的 URL 是 stub:///…，
// 相对说明符在那里无法解析，只能靠动态 import + 绝对 URL。
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const HTTP_STUB = "stub:///dsh-replay-http";
const CP_STUB = "stub:///dsh-replay-cp";
const REAL_HTTP_URL = pathToFileURL(join(HERE, "..", "..", "src", "http.js")).href;
const ENGINE_URL = pathToFileURL(join(HERE, "engine.mjs")).href;

// 需要被截子进程通道的源文件（绝对 file URL），按名字表生成，避免手写路径打错。
const CP_PARENTS = ["extra-sources.js", "sources.js", "lobehub-market.js", "cli-install.js"]
  .map((f) => pathToFileURL(join(HERE, "..", "..", "src", f)).href);

function stubSource(file, consts) {
  return `${consts}\n${readFileSync(join(HERE, file), "utf8")}`;
}

export async function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL || "";

  // 替身自己回真：必须放行，否则 真 src/http.js → 又被改写 → 无限递归。
  if (parent === HTTP_STUB || parent === CP_STUB) return nextResolve(specifier, context);

  if (specifier === "node:child_process" && CP_PARENTS.includes(parent)) {
    return { url: CP_STUB, shortCircuit: true };
  }

  const r = await nextResolve(specifier, context);
  if (r.url === REAL_HTTP_URL || /\/src\/http\.js$/.test(r.url)) {
    return { url: HTTP_STUB, shortCircuit: true };
  }
  return r;
}

export async function load(url, context, nextLoad) {
  if (url === HTTP_STUB) {
    return {
      format: "module",
      shortCircuit: true,
      source: stubSource("http-replay.mjs", `const ENGINE_URL = ${JSON.stringify(ENGINE_URL)};\nconst REAL_URL = ${JSON.stringify(REAL_HTTP_URL)};`),
    };
  }
  if (url === CP_STUB) {
    return {
      format: "module",
      shortCircuit: true,
      source: stubSource("cp-replay.mjs", `const ENGINE_URL = ${JSON.stringify(ENGINE_URL)};`),
    };
  }
  return nextLoad(url, context);
}
