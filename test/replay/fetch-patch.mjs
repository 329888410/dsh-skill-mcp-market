// test/replay/fetch-patch.mjs — 截住「绕过 src/http.js 的裸 fetch」。
//
// 为什么单独一层：全仓有 14 处直接 fetch(...) 不经过 http.js（实测清单：
// src/github.js:33、src/cli-install.js:372、src/enrich.js:15 与 :99、
// src/extra-sources.js:34/:40/:1515/:1627、src/sources.js:26、src/skillhub.js:9/:28、
// src/skills.js:247、src/http.js:80/:300）。resolve 钩子管不到全局对象，
// 但 globalThis.fetch 的替换对它们全部有效（取证：probe-preload2.mjs
// 实测 `bare fetch => {"via":"PRELOAD-FETCH"}`）。
//
// 录制态刻意「录完再用录到的字节回给调用方」，而不是把真响应直接透传：
// 这样 record 与 replay 服务的是同一份字节，杜绝「录制成功、回放却不一样」的假绿。
import { requestKey, lookup, store, mode, replayDir, MissError, fakeResponse } from "./engine.mjs";

const realFetch = globalThis.fetch;

globalThis.fetch = async function replayableFetch(input, init) {
  const m = mode();
  if (m === "off") return realFetch(input, init);

  const url = typeof input === "string" || input instanceof URL ? String(input) : String(input && input.url);
  if (!/^https?:/i.test(url)) return realFetch(input, init); // data:/blob:/file: 不归回放管

  const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
  const rawBody = init && init.body != null ? String(init.body) : "";
  const dir = replayDir();
  const key = requestKey({ method, url, body: rawBody });

  if (m === "replay") {
    const rec = lookup({ dir, key });
    if (!rec) throw new MissError(key, `${method} ${url}`);
    if (rec.error) throw new Error(rec.error);
    return fakeResponse(rec, url);
  }

  try {
    const response = await realFetch(input, init);
    const text = await response.text();
    const headers = {};
    try {
      response.headers.forEach((value, name) => { headers[name] = value; });
    } catch { /* 替身头集合缺 forEach 时按空头处理 */ }
    store({
      dir,
      key,
      entry: { method, url, body: rawBody, status: response.status, headers, text },
    });
    return fakeResponse({ status: response.status, headers, text }, url);
  } catch (error) {
    store({
      dir,
      key,
      entry: { method, url, body: rawBody, error: String((error && error.message) || error).slice(0, 400) },
    });
    throw error;
  }
};

globalThis.__DSH_REPLAY_FETCH__ = true;
