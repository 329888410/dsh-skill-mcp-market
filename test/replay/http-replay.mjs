// test/replay/http-replay.mjs — src/http.js 的回放替身。
//
// 由 hooks.mjs 的 load 钩子以「源码字符串」形式注入，因此本文件的 URL 是 stub:///…，
// **不能用静态相对 import**（相对说明符需要一个可解析的真实 parent URL）。
// 依赖一律走动态 import + 钩子注入的绝对 URL 常量：ENGINE_URL / REAL_URL。
//
// 导出面必须与真模块逐字对齐：curlText / getJson / pythonText / pythonDownload /
// getJsonEscalating / postJsonEscalating。少一个名字，生产侧的命名导入就在链接期崩，
// 拿不到判据文本（本仓 0.5.164 的「链接期崩溃 = 没有汇总行的红」教训同款）。
//
// 录制态只存「最终结果」，不存 python→curl→fetch 的逐次尝试：升级顺序是被测行为，
// 但它属于真网络门的职责（DSH_REPLAY 未设时走真模块），档案要的是可重放的确定输入。
const engine = await import(ENGINE_URL);
const real = await import(REAL_URL);

export async function curlText(url, options = {}) {
  return engine.textViaCache({ method: "GET", url, real: () => real.curlText(url, options) });
}

export async function getJson(url, options = {}) {
  return engine.jsonViaCache({ method: "GET", url, real: () => real.getJson(url, options) });
}

export async function pythonText(url, options = {}) {
  return engine.textViaCache({ method: "GET", url, real: () => real.pythonText(url, options) });
}

export async function pythonDownload(url, target, options = {}) {
  return engine.fileViaCache({ url, target, real: () => real.pythonDownload(url, target, options) });
}

export async function getJsonEscalating(url, options = {}) {
  return engine.jsonViaCache({ method: "GET", url, real: () => real.getJsonEscalating(url, options) });
}

export async function postJsonEscalating(url, body, options = {}) {
  return engine.jsonViaCache({
    method: "POST",
    url,
    body: JSON.stringify(body ?? {}),
    real: () => real.postJsonEscalating(url, body, options),
  });
}
