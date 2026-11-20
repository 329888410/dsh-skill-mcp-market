// MCP connector manager: definitions on disk, live mounts through the shipped dsh-mcp-client plugin.
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, watch } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { ensureDir, writeJson } from "./home.js";
import { importShipped, pluginFrom, SHIPPED } from "./shipped.js";

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

export function normalizeServerName(raw) {
  const base = String(raw || "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return NAME_RE.test(base) ? base : "";
}

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function resolvePlaceholders(value) {
  if (typeof value !== "string") return value;
  return value.replace(PLACEHOLDER, (_, key) => process.env[key] ?? "");
}

function resolveMap(map) {
  const out = {};
  for (const [key, value] of Object.entries(map || {})) {
    const resolved = resolvePlaceholders(String(value));
    if (resolved !== "") out[key] = resolved;
  }
  return out;
}

export function missingEnv(def) {
  const missing = [];
  const scan = (value) => {
    const text = String(value ?? "");
    for (const match of text.matchAll(PLACEHOLDER)) {
      if (!process.env[match[1]]) missing.push(match[1]);
    }
  };
  for (const value of Object.values(def.env || {})) scan(value);
  for (const value of Object.values(def.headers || {})) scan(value);
  for (const arg of def.args || []) scan(arg);
  for (const name of def.envRequired || []) {
    if (!(name in (def.env || {})) && !process.env[name]) missing.push(name);
  }
  return [...new Set(missing)];
}

/**
 * detail() 对环境变量引用的掩码字面量。它绝不能被写回定义文件——那会把真实值
 * 替换成一句中文说明，连接器随即启动失败（可静默发生的数据损坏）。
 */
export const MASK_LITERAL = "***（来自环境变量）";

/** 重连默认值与参照实现（Fishquito7/dsh-skill-mcp-panel src/mcp/model.ts）一致。 */
export const DEFAULT_RECONNECT = { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 };

export function toClientConfig(def) {
  const common = {
    serverName: def.serverName,
    failOnStartupError: false,
    toolCallTimeoutMs: Number(def.toolCallTimeoutMs) > 0 ? Number(def.toolCallTimeoutMs) : 60000,
    // 定义里的 reconnect 逐键覆盖默认值（enabled:false 由用户整块关闭，spread 原样生效）
    reconnect: { ...DEFAULT_RECONNECT, ...(def.reconnect && typeof def.reconnect === "object" ? def.reconnect : {}) },
  };
  if (def.transport === "streamable-http") {
    return { ...common, transport: "streamable-http", url: resolvePlaceholders(def.url || ""), headers: resolveMap(def.headers) };
  }
  return {
    ...common,
    transport: "stdio",
    command: resolvePlaceholders(def.command || ""),
    args: (def.args || []).map((arg) => resolvePlaceholders(String(arg))),
    env: resolveMap(def.env),
    ...(def.cwd ? { cwd: resolvePlaceholders(def.cwd) } : {}),
  };
}

export function createMcpManager({ ctx, dirs, shippedRoot, log }) {
  const mounted = new Map();
  const watchers = [];
  let disposed = false;

  const logInfo = (message) => log?.("info", message);
  const logWarn = (message) => log?.("warn", message);

  // 解析失败的定义文件：以前被 catch 静默跳过，用户手改坏一个 JSON 后连接器凭空消失，
  // 界面上没有任何痕迹。现在收集起来（文件名 + 原因），由 mcp.list 一并上报给面板。
  let brokenDefs = [];

  async function readDefs() {
    const defs = new Map();
    brokenDefs = [];
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      let names = [];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const file of names) {
        if (!file.endsWith(".json") || file.startsWith(".")) continue;
        try {
          const raw = JSON.parse(await readFile(join(dir, file), "utf8"));
          const serverName = normalizeServerName(raw.serverName || file.replace(/\.json$/, ""));
          if (!serverName) continue;
          defs.set(serverName, { ...raw, serverName, filePath: join(dir, file), dir });
        } catch (error) {
          // 坏定义跳过其余条目继续，但必须留下可见痕迹（面板据此提示用户）
          brokenDefs.push({ file, dir, error: String(error && error.message ? error.message : error) });
        }
      }
    }
    return defs;
  }

  // 连接状态探测。主路读我们自己持有的 fiber（cordis Fiber.state，数字枚举），
  // 补充路走 ctx.loader.entries() 的 entry.fiber.state（loader 在 app.asar 内但源码可静态审计，
  // FiberState 取值与字段名均已实测确认）；两路都拿不到才回退 unknown——绝不猜一个假 phase。
  // cordis 的 FiberState 是数字 const enum（src/fiber.ts:147；编译产物实测 this.state = 2），
  // 公开字段是 fiber.state 而不是 fiber.status —— 0.5.115 读 status 导致 phase 恒为 unknown。
  //   0 PENDING → loading   1 LOADING → loading   2 ACTIVE  → active
  //   3 FAILED  → failed    4 DISPOSED → unloaded  5 UNLOADING → unloaded
  function normalizePhase(raw) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      if (raw === 2) return "active";
      if (raw === 3) return "failed";
      if (raw === 4 || raw === 5) return "unloaded";
      if (raw === 0 || raw === 1) return "loading";
      return "";
    }
    const s = String(raw ?? "").toLowerCase();
    if (!s) return "";
    if (/fail|error|reject|crash/.test(s)) return "failed";
    if (/dispos|unmount|remov|unload/.test(s)) return "unloaded";
    if (/activating|loading|pending|starting|init|mounting/.test(s)) return "loading";
    if (/active|ready|mounted|online/.test(s)) return "active";
    return "";
  }

  function fiberPhaseOf(serverName) {
    const entry = mounted.get(serverName);
    if (!entry) return { phase: "unloaded", detail: "" };
    const fiber = entry.fiber;
    const direct = normalizePhase(fiber && fiber.state);
    // detail 尽力取：Fiber 的错误记在私有 _error 上（src/fiber.ts:208），公开面只有 state，
    // 所以这里通常为空——空 detail 不影响 phase 的正确性，绝不拿它编造原因。
    const detail = String((fiber && (fiber.error?.message || fiber.reason)) || "");
    if (direct) return { phase: direct, detail };
    try {
      const loader = ctx && typeof ctx.loader?.entries === "function" ? ctx.loader : null;
      if (loader) {
        const tag = `market-mcp-${serverName}`;
        for (const e of loader.entries()) {
          if (!e) continue;
          const hit = String(e.id || "").includes(tag) || String(e.config?.serverName || "") === serverName;
          if (!hit) continue;
          // Entry（cordis-plugin-loader src/config/entry.ts:43）暴露 fiber?: Fiber，
          // 没有自己的 state/status 字段——旧写法读 e.state 永远拿不到值。
          const p = normalizePhase(e.fiber ? e.fiber.state : undefined);
          if (p) return { phase: p, detail: String(e.error?.message || e.error || detail || "") };
        }
      }
    } catch { /* loader 不可用：落到回退 */ }
    return { phase: "unknown", detail };
  }

  /** 最近一次 readDefs 发现的坏定义（list/detail/status 都会先跑 readDefs）。 */
  function broken() {
    return brokenDefs.slice();
  }

  /**
   * 读取定义文件原文。表单覆盖不到的字段（toolCallTimeoutMs、reconnect、cwd、
   * 用户手写任意键）只能从这里改。**不做 JSON.parse→stringify 往返**：那会重排键序、
   * 丢注释位、并被 save() 补上 installedAt，等于另一种语义。
   * hasSecrets 是安全提示：detail 把 env 的 ${VAR} 掩成「***（来自环境变量）」，
   * 而原文视图必然暴露明文值，所以调用方要先警告再展示。
   */
  /**
   * 拒绝把掩码字面量写回定义（env/headers）。纯函数、无副作用，必须在任何写盘之前调用。
   * maskLiteral 作为参数并带默认值：测试可以用 new Function 独立求值本函数，
   * 不必把整个 createMcpManager 跑起来（CI 环境没有宿主 asar，跑不起来）。
   * maskLiteral 的默认值必须与 MASK_LITERAL 一致（有测试锁两者相等）。
   */
  function assertNoMaskLiteral(patch, maskLiteral = "***（来自环境变量）") {
    if (patch === null || typeof patch !== 'object') return;
    for (const field of ['env', 'headers']) {
      const map = patch[field];
      if (map === null || typeof map !== 'object') continue;
      for (const [key, value] of Object.entries(map)) {
        if (String(value ?? '') === maskLiteral) {
          throw new Error(`${field}.${key} 是 detail 的掩码值，不能写回定义（会毁掉真实的环境变量引用）；请填入真实值，或保持该键不变`);
        }
      }
    }
  }

  async function rawGet(serverName) {
    const name = normalizeServerName(serverName);
    const defs = await readDefs();
    const def = defs.get(name);
    if (!def) throw new Error(`没有名为 ${name} 的 MCP 定义`);
    const text = await readFile(def.filePath, "utf8");
    let hasSecrets = false;
    try {
      const parsed = JSON.parse(text);
      hasSecrets = Object.values(parsed.env || {}).some((v) => {
        const s = String(v ?? "");
        return s.length > 0 && !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(s);
      });
    } catch {
      // 坏 JSON 正是原文编辑要救的场景：照常返回原文，让 UI 显示并让用户修。
      hasSecrets = false;
    }
    return { serverName: name, text, filePath: def.filePath, hasSecrets };
  }

  /**
   * 写回原文。三条判据（缺一不可）：
   *  - diff 而非 presence：原文必然含 command/args（它们是定义的一部分）。
   *    照搬 mcp.update 的「字段存在就拒」会让只改 title 的编辑也失败；
   *    真判据是「与当前定义相比是否真的变了」。
   *  - serverName 不得改：改名等于写进另一个文件（甚至越界），那是重命名不是编辑。
   *  - 保字节：直接 writeFile(text)，不走 save() 的规范化。
   * 校验通过才落盘；任何拒绝路径都不写文件。
   */
  async function rawSet(serverName, text) {
    const name = normalizeServerName(serverName);
    const defs = await readDefs();
    const def = defs.get(name);
    if (!def) throw new Error(`没有名为 ${name} 的 MCP 定义`);
    const raw = String(text ?? "");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`原文不是合法 JSON：${String(error && error.message ? error.message : error)}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("原文必须是一个 JSON 对象（连接器定义）");
    }
    const nextName = normalizeServerName(parsed.serverName || "");
    if (!nextName) throw new Error("原文缺少合法的 serverName");
    if (nextName !== name) {
      throw new Error(`serverName 必须保持 ${name}；改名请新建连接器再卸载旧的`);
    }
    // command/args 的改动判定交给 dispatch 层的 confirm 闸门（needsConfirmFor），
    // 这里不再永久拒绝 —— 那是把误操作防护错当成安全边界（实测磁盘写入即可绕过）。
    assertNoMaskLiteral(parsed);
    await writeFile(def.filePath, raw.endsWith("\n") ? raw : raw + "\n", "utf8");
    // 「保存成功」与「连接成功」是两件事，必须分开报：原文编辑完全可以写出一个
    // 合法但连不上的配置（比如 args 指向不存在的脚本），那时应该告诉用户
    // 「已保存，但连接失败」，而不是回滚、抛错，或假装连上了。
    const result = { ok: true, saved: true, serverName: name, connected: false, pending: false, tools: [], connectError: "" };
    try {
      const fresh = await readDefs();
      const saved = fresh.get(name);
      if (!saved) { result.connectError = "写入后无法重新读取定义，请检查文件内容"; return result; }
      unmount(name);
      await mount(saved);
      const probe = await probeTools(name, 2000);
      result.connected = probe.ok === true;
      result.pending = probe.pending === true;
      result.tools = probe.tools || [];
      result.connectError = probe.ok ? "" : String(probe.error || "");
    } catch (error) {
      // 重连失败不回滚文件：用户改的是定义，定义已经按原文落盘。
      result.connectError = String(error && error.message ? error.message : error);
    }
    return result;
  }

  async function status(serverName) {
    const defs = await readDefs();
    const rows = [...defs.values()];
    const view = (def) => {
      const p = fiberPhaseOf(def.serverName);
      return { serverName: def.serverName, phase: p.phase, detail: p.detail, mounted: mounted.has(def.serverName), enabled: def.enabled !== false, tools: toolNamesFor(def.serverName) };
    };
    if (serverName) {
      const name = normalizeServerName(serverName);
      const def = defs.get(name);
      if (!def) throw new Error(`没有名为 ${name} 的 MCP 定义`);
      return view(def);
    }
    return { items: rows.map(view) };
  }

  function toolNamesFor(serverName) {
    const prefix = `mcp__${serverName}__`;
    try {
      return ctx.tools
        .definitions()
        .map((definition) => definition.name)
        .filter((name) => name.startsWith(prefix));
    } catch {
      return [];
    }
  }

  /**
   * 某个连接器已注册工具的名称 + 描述 + 参数 schema。
   * 数据全在宿主 definition 上（ToolSchema: name/description/parameters；
   * dsh-mcp-client 把上游 inputSchema 原样放进 parameters），因此这是纯读，
   * 不需要任何上游请求，也不会触发连接。
   */
  function toolDetailsFor(serverName) {
    const prefix = `mcp__${serverName}__`;
    try {
      return ctx.tools
        .definitions()
        .filter((definition) => definition && typeof definition.name === "string" && definition.name.startsWith(prefix))
        .map((definition) => ({
          name: definition.name,
          description: String(definition.description || ""),
          parameters: definition.parameters && typeof definition.parameters === "object" ? definition.parameters : null,
        }));
    } catch {
      return [];
    }
  }

  async function mount(def) {
    if (mounted.has(def.serverName)) return { ok: true, alreadyMounted: true, tools: toolNamesFor(def.serverName) };
    const missing = missingEnv(def);
    if (missing.length > 0) {
      return { ok: false, serverName: def.serverName, error: "missing environment values", missing };
    }
    const namespace = await importShipped(SHIPPED.mcpClient, shippedRoot);
    const fiber = ctx.plugin(pluginFrom(namespace, `market-mcp-${def.serverName}`), toClientConfig(def));
    mounted.set(def.serverName, { fiber, def });
    logInfo(`mounted MCP server "${def.serverName}"`);
    return { ok: true, serverName: def.serverName, mounted: true };
  }

  function unmount(serverName) {
    const entry = mounted.get(serverName);
    if (!entry) return false;
    try {
      entry.fiber?.dispose?.();
    } catch (error) {
      logWarn(`disposing MCP server "${serverName}" failed: ${String(error?.message || error)}`);
    }
    mounted.delete(serverName);
    return true;
  }

  async function list() {
    const defs = await readDefs();
    return [...defs.values()].map((def) => ({
      serverName: def.serverName,
      title: def.title || def.serverName,
      description: def.description || "",
      transport: def.transport || "stdio",
      command: def.command || "",
      args: def.args || [],
      url: def.url || "",
      enabled: def.enabled !== false,
      mounted: mounted.has(def.serverName),
      phase: fiberPhaseOf(def.serverName).phase,
      phaseDetail: fiberPhaseOf(def.serverName).detail,
      tools: toolNamesFor(def.serverName),
      envKeys: [...Object.keys(def.env || {}), ...(def.envRequired || [])],
      source: def.source || "manual",
      slug: def.slug || "",
      path: def.filePath,
      installedAt: def.installedAt || "",
    }));
  }

  async function save(def) {
    const dir = def.dir || dirs[0];
    if (!dir) throw new Error("no MCP directory is configured");
    await ensureDir(dir);
    const serverName = normalizeServerName(def.serverName);
    if (!serverName) throw new Error("serverName must match [A-Za-z0-9_-]{1,32}");
    const payload = { ...def, serverName, installedAt: def.installedAt || new Date().toISOString() };
    delete payload.filePath;
    delete payload.dir;
    await writeJson(join(dir, `${serverName}.json`), payload);
    return { ...payload, dir, filePath: join(dir, `${serverName}.json`) };
  }

  async function reconcile() {
    if (disposed) return;
    const defs = await readDefs();
    for (const [name] of [...mounted]) {
      const def = defs.get(name);
      if (!def || def.enabled === false) unmount(name);
    }
    for (const def of defs.values()) {
      if (def.enabled === false) continue;
      if (mounted.has(def.serverName)) continue;
      const result = await mount(def);
      if (!result.ok) logWarn(`MCP server "${def.serverName}" not mounted: ${result.error}`);
    }
  }

  async function install(def) {
    const saved = await save(def);
    if (saved.enabled === false) return { ok: true, serverName: saved.serverName, enabled: false };
    unmount(saved.serverName);
    const result = await mount({ ...saved, filePath: saved.filePath, dir: saved.dir });
    return { ...result, serverName: saved.serverName };
  }

  async function uninstall(serverName) {
    const name = normalizeServerName(serverName);
    unmount(name);
    const removed = [];
    for (const dir of dirs) {
      const file = join(dir, `${name}.json`);
      if (!existsSync(file)) continue;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const trash = join(dir, ".trash", `${name}-${stamp}.json`);
      await ensureDir(join(dir, ".trash"));
      try {
        const text = await readFile(file, "utf8");
        await writeJson(trash, JSON.parse(text));
      } catch {
        // keep going: the definition file is removed regardless
      }
      await rm(file, { force: true });
      removed.push(file);
    }
    return { ok: removed.length > 0, serverName: name, removed };
  }

  async function setEnabled(serverName, enabled) {
    const name = normalizeServerName(serverName);
    const defs = await readDefs();
    const def = defs.get(name);
    if (!def) throw new Error(`no MCP definition named "${name}"`);
    const saved = await save({ ...def, enabled: Boolean(enabled) });
    if (enabled) {
      unmount(name);
      await mount({ ...saved, filePath: saved.filePath, dir: saved.dir });
    } else {
      unmount(name);
    }
    return { ok: true, serverName: name, enabled: Boolean(enabled) };
  }

  async function detail(serverName) {
    const name = normalizeServerName(serverName);
    const defs = await readDefs();
    const def = defs.get(name);
    if (!def) throw new Error(`没有名为 ${name} 的 MCP 定义`);
    const mask = (map) => {
      const out = {};
      for (const [key, value] of Object.entries(map || {})) {
        // 掩码值统一取自 MASK_LITERAL：detail 生成端与 assertNoMaskLiteral 校验端必须是同一个串，
        // 否则「掩码被写回」的防线会静默失效（改了展示文案却忘了改校验）。
        out[key] = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(String(value)) ? MASK_LITERAL : String(value);
      }
      return out;
    };
    return {
      serverName: name,
      title: def.title || name,
      description: def.description || "",
      transport: def.transport || "stdio",
      command: def.command || "",
      args: def.args || [],
      url: def.url || "",
      env: mask(def.env),
      headers: mask(def.headers),
      cwd: def.cwd || "",
      enabled: def.enabled !== false,
      // 表单高级区需要：这两个不是敏感值（超时与重连参数），随 detail 一起给。
      toolCallTimeoutMs: def.toolCallTimeoutMs,
      reconnect: def.reconnect,
      mounted: mounted.has(name),
      tools: toolNamesFor(name),
      toolDetails: toolDetailsFor(name),
      source: def.source || "manual",
      slug: def.slug || "",
      homepage: def.homepage || "",
      path: def.filePath,
    };
  }

  async function update(serverName, patch) {
    const name = normalizeServerName(serverName);
    const defs = await readDefs();
    const def = defs.get(name);
    if (!def) throw new Error(`没有名为 ${name} 的 MCP 定义`);
    // 掩码值先拦下：detail 只把变量引用掩掉，表单原样回传会毁掉引用。
    assertNoMaskLiteral(patch);
    const next = { ...def, ...patch, serverName: name };
    // env/headers 用合并语义：patch 里出现的键才改动，未出现的键保持原值。
    // 旧的整体替换会悄悄删掉用户没填的变量，这里兜住。
    if (patch.env !== undefined) next.env = { ...(def.env || {}), ...patch.env };
    if (Array.isArray(patch.envUnset)) { for (const key of patch.envUnset) delete next.env[String(key)]; }
    if (patch.headers !== undefined) next.headers = { ...(def.headers || {}), ...patch.headers };
    if (Array.isArray(patch.headersUnset)) { for (const key of patch.headersUnset) delete next.headers[String(key)]; }
    delete next.envUnset;
    delete next.headersUnset;
    delete next.filePath;
    delete next.dir;
    const saved = await save(next);
    unmount(name);
    await mount({ ...saved, filePath: saved.filePath, dir: saved.dir });
    const probe = await probeTools(name, 2000);
    return { ok: probe.ok, pending: probe.pending === true, serverName: name, tools: probe.tools, error: probe.ok ? undefined : probe.error };
  }

  // 探针预算只是「快速确认」，不是终局判定：npx 型连接器首次运行要先下载包
  // （实测 playwright-mcp 冷启动 ~94s），8s 内没工具不代表失败。返回 pending=true
  // 让调用方继续轮询 mcp.list，由实时状态做最终结论。
  async function probeTools(name, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const tools = toolNamesFor(name);
      if (tools.length > 0) return { ok: true, tools };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return {
      ok: false,
      pending: true,
      tools: [],
      error: mounted.has(name)
        ? "已挂载，服务器还在启动中（npx 型连接器首次运行需先下载依赖）"
        : "MCP 客户端未挂载",
    };
  }

  async function probe(serverName, timeoutMs = 8000) {
    const name = normalizeServerName(serverName);
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const tools = toolNamesFor(name);
      if (tools.length > 0) return { ok: true, serverName: name, tools, waitedMs: Date.now() - started };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return {
      ok: false,
      serverName: name,
      tools: [],
      waitedMs: Date.now() - started,
      pending: true,
      error: mounted.has(name)
        ? "已挂载，服务器还在启动中（npx 型连接器首次运行需先下载依赖）"
        : "MCP 客户端未挂载",
    };
  }

  // ------------------------------------------------------------- MCP 回收站
  // uninstall() 把定义移到 <dir>/.trash/<serverName>-<stamp>.json。这里提供列出/恢复/清空。
  // 不复用 skills.js 的 listTrash/restoreFromTrash：它们的 TRASH_NAME 正则只认 .md 后缀，
  // 对 .json 条目解析失败，且恢复时强加 .md 后缀 —— readDefs 只认 .json，恢复即丢失。
  const TRASH_FILE = /^(.*)-(\d{4}-\d{2}-\d{2}T[0-9-]+Z)\.json$/;
  const trashRoots = () => dirs.map((dir) => join(dir, ".trash"));

  async function trashList() {
    const items = [];
    for (const root of trashRoots()) {
      if (!existsSync(root)) continue;
      let names = [];
      try {
        names = await readdir(root);
      } catch {
        continue;
      }
      for (const file of names) {
        if (!file.endsWith(".json") || file.startsWith(".")) continue;
        const full = join(root, file);
        const match = TRASH_FILE.exec(file);
        let parsed = null;
        try {
          parsed = JSON.parse(await readFile(full, "utf8"));
        } catch {
          parsed = null;
        }
        items.push({
          name: file,
          path: full,
          trashRoot: root,
          kind: "file",
          serverName: match ? match[1] : file.replace(/\.json$/, ""),
          deletedAt: match ? match[2] : "",
          title: parsed?.title || "",
          transport: parsed?.transport || "",
          bytes: Buffer.byteLength(JSON.stringify(parsed ?? {}), "utf8"),
        });
      }
    }
    items.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
    return { items, total: items.length };
  }

  async function trashRestore({ path: entryPath } = {}) {
    const full = String(entryPath || "");
    if (!full || !existsSync(full)) throw new Error("回收站条目不存在");
    const parent = resolve(dirname(full));
    const root = trashRoots().find((r) => resolve(r) === parent);
    if (!root) throw new Error("只能恢复 MCP 回收站（<目录>/.trash）内的条目");
    const base = basename(full);
    const match = TRASH_FILE.exec(base);
    if (!match) throw new Error("回收站条目名不合法");
    const dir = dirname(root);
    const serverName = match[1];
    let target = join(dir, `${serverName}.json`);
    let finalName = serverName;
    if (existsSync(target)) {
      // 同名冲突：另存为别名，并把定义里的 serverName 一起改掉，
      // 否则两个文件同名会被 readDefs 按 key 合并、静默遮蔽一个。
      for (let index = 2; index < 1000; index += 1) {
        const candidate = join(dir, `${serverName}-${index}.json`);
        if (!existsSync(candidate)) {
          target = candidate;
          finalName = `${serverName}-${index}`;
          break;
        }
      }
    }
    let raw = {};
    try {
      raw = JSON.parse(await readFile(full, "utf8"));
    } catch {
      throw new Error("回收站条目内容不是合法 JSON");
    }
    raw.serverName = finalName;
    delete raw.filePath;
    delete raw.dir;
    await ensureDir(dir);
    await writeJson(target, raw);
    await rm(full, { force: true });
    // 恢复后立刻 reconcile：watch(dir) 非 recursive，.trash 内的变化不会触发回调，
    // 只靠 watcher 会让「恢复完成」与「连接器上线」之间出现无人负责的窗口。
    await reconcile().catch((error) => logWarn(`MCP reconcile after restore failed: ${String(error?.message || error)}`));
    return { ok: true, serverName: finalName, restoredTo: target, aliased: finalName !== serverName };
  }

  async function trashEmpty() {
    let removed = 0;
    for (const root of trashRoots()) {
      if (!existsSync(root)) continue;
      let names = [];
      try {
        names = await readdir(root);
      } catch {
        continue;
      }
      for (const file of names) {
        if (!file.endsWith(".json")) continue;
        try {
          await rm(join(root, file), { force: true });
          removed += 1;
        } catch {
          // 单个条目删不掉不影响其余
        }
      }
    }
    return { ok: true, removed };
  }

  function startWatching() {
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      try {
        const watcher = watch(dir, { persistent: false }, () => {
          clearTimeout(startWatching.timer);
          startWatching.timer = setTimeout(() => {
            reconcile().catch((error) => logWarn(`MCP rescan failed: ${String(error?.message || error)}`));
          }, 300);
        });
        watcher.on?.("error", () => {});
        watchers.push(watcher);
      } catch (error) {
        logWarn(`cannot watch ${dir}: ${String(error?.message || error)}`);
      }
    }
  }

  async function init() {
    for (const dir of dirs) await ensureDir(dir);
    await reconcile();
    startWatching();
  }

  function dispose() {
    disposed = true;
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
    }
    watchers.length = 0;
    for (const name of [...mounted.keys()]) unmount(name);
  }

  return { init, dispose, list, install, uninstall, setEnabled, probe, detail, update, reconcile, mount, unmount, toolNamesFor, readDefs, trashList, trashRestore, trashEmpty, status, broken, rawGet, rawSet };
}
