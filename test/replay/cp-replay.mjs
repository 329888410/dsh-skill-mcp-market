// test/replay/cp-replay.mjs — node:child_process 的包装层（只给 src 里 4 个用 npx/curl 打网络的模块）。
//
// 为什么还要这一层：src/http.js 被整体顶替后 curl/python 通道已断，但还有 4 处直接 execFile
// 打网络、不经过 http.js（实测：src/extra-sources.js:18 cliRun 走 `npx -y pkg`、
// src/sources.js:439 `npx -y browse`、src/lobehub-market.js:53 runCli 走
// `npx -y @lobehub/market-cli`、src/cli-install.js:32 npxRun 与 :382 curl）。
// 判定只认 argv（engine.isNetworkCli），git/tar/sh 一律放行回真：本地动作冻进档案
// 会把「刚改完的仓库状态」变成旧答案。
//
// 本文件由 hooks.mjs 以源码字符串注入，URL 是 stub:///…，所以相对说明符必须走
// 注入的 ENGINE_URL 动态 import；`node:child_process` 是内置说明符，静态 import 可行
// （hooks.resolve 对 parentURL===CP_STUB 一律放行，不会自截成环）。
import * as realCp from "node:child_process";

const engine = await import(ENGINE_URL);

function splitArgs(args) {
  const cb = args.find((a) => typeof a === "function") || null;
  const list = args.filter((a) => typeof a !== "function");
  const file = list[0];
  const argv = Array.isArray(list[1]) ? list[1] : [];
  const opts = list.slice(Array.isArray(list[1]) ? 2 : 1).find((r) => r && typeof r === "object") || {};
  return { file, argv, opts, cb };
}

export function execFile(...args) {
  const { file, argv, opts, cb } = splitArgs(args);
  if (engine.mode() === "off" || !cb || !engine.isNetworkCli(file, argv)) {
    return realCp.execFile(file, argv, opts, cb);
  }
  let done = false;
  const handle = {
    get killed() { return done; },
    kill() { return true; },
    stdin: null,
  };
  engine
    .cliViaCache({
      file,
      args: argv,
      options: opts,
      real: () => new Promise((resolve, reject) => {
        realCp.execFile(file, argv, opts, (error, stdout, stderr) => {
          if (error) reject(error);
          else resolve({ stdout, stderr });
        });
      }),
    })
    .then(
      (r) => {
        done = true;
        cb(null, String((r && r.stdout) || ""), String((r && r.stderr) || ""));
      },
      (error) => {
        done = true;
        cb(error, "", String((error && error.message) || error));
      },
    );
  return handle;
}

export function execFileSync(file, argv, ...rest) {
  if (engine.mode() === "off" || !engine.isNetworkCli(file, Array.isArray(argv) ? argv : [])) {
    return realCp.execFileSync(file, argv, ...rest);
  }
  // 同步通道没有异步档案位：直接抛 REPLAY-MISS 形态的错，让判据显式红，不做半回放。
  throw new engine.MissError(engine.requestKey({ method: "CLI", url: `${file} ${JSON.stringify(argv || [])}` }), `execFileSync ${file}`);
}

export const spawn = realCp.spawn;
export const spawnSync = realCp.spawnSync;
export const fork = realCp.fork;
export const ChildProcess = realCp.ChildProcess;
export default realCp;
