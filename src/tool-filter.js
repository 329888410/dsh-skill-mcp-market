// 工具级禁用（差距清单 Task B）。宿主机制已实测核实：
//  - ctx.tools.restrict({deny}) 只接受 scoped ctx（agent.ctx）；全局调用抛错
//    （@deepseek-ai/dsh-tools src/index.ts:165），返回精确 disposer。
//  - restrict 命名未知工具会抛错 → 施加前与 view().restrictableNames 求交集。
//  - agent 枚举：ctx.get('agents').list()。刻意用动态 get 而非静态 inject：
//    服务缺失时本功能整体降级为 no-op，插件绝不会被一个可选功能拖挂。
// 语义参照 Fishquito7/dsh-skill-mcp-panel src/tool-filter.ts（agent/created 施加、
// 签名比对去重、dispose 清账），持久化用我们自己的 market 目录。
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** 按服务器合并 deny：删掉旧的前缀项、加入新项，其余服务器/手工项原样保留。 */
export function replaceServerDeny(current, serverName, nextList) {
  const prefix = `mcp__${serverName}__`;
  const kept = (Array.isArray(current) ? current : []).filter((name) => !String(name).startsWith(prefix));
  const added = (Array.isArray(nextList) ? nextList : []).map(String);
  return [...new Set([...kept, ...added])];
}

export function createToolFilter({ ctx, file, log }) {
  const mounted = new Map(); // agentId -> { holder }
  const deny = new Set();
  let started = false;
  let disposed = false;
  const off = [];

  const warn = (message) => { try { log("warn", message); } catch { /* ignore */ } };

  async function load() {
    try {
      const raw = JSON.parse(await readFile(file, "utf8"));
      deny.clear();
      for (const name of Array.isArray(raw.deny) ? raw.deny : []) deny.add(String(name));
    } catch {
      // 文件不存在/坏 JSON：按无禁用起步，坏文件留给 setDeny 覆盖
      deny.clear();
    }
    return [...deny];
  }

  function persist() {
    const body = JSON.stringify({ deny: [...deny] }, null, 2) + "\n";
    return (async () => {
      try {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, body, "utf8");
        return true;
      } catch (error) {
        warn(`写入工具禁用清单失败：${String(error?.message || error)}`);
        return false;
      }
    })();
  }

  // 挂进 agent scope 的临时插件：apply 在 scoped ctx 上执行，restrict 在那时可用。
  function pluginFor(initial) {
    let activeDeny = initial.slice();
    const holder = { setDeny: () => {}, sync: () => {} };
    const plugin = {
      name: "dsh-market:tool-filter",
      inject: ["tools"],
      apply(c) {
        let undo;
        let applied = null;
        let live = true;
        const sync = () => {
          if (!live) return;
          let known;
          try {
            known = new Set(c.tools.view(undefined).restrictableNames);
          } catch (error) {
            warn(`读取可限制工具列表失败：${String(error?.message || error)}`);
            return;
          }
          const usable = activeDeny.filter((name) => known.has(name));
          const signature = usable.slice().sort().join("\u0000");
          if (signature === applied) return;
          if (undo !== undefined) {
            try { undo(); } catch (error) { warn(`撤销上一轮限制失败：${String(error?.message || error)}`); }
            undo = undefined;
            applied = null;
          }
          if (usable.length === 0) {
            applied = "";
            return;
          }
          try {
            undo = c.tools.restrict({ deny: usable });
            applied = signature;
          } catch (error) {
            warn(`施加工具限制失败：${String(error?.message || error)}`);
            undo = undefined;
            applied = null;
          }
        };
        holder.sync = sync;
        holder.setDeny = (next) => {
          activeDeny = next.slice();
          sync();
        };
        sync();
        return () => {
          live = false;
          if (undo !== undefined) {
            try { undo(); } catch { /* ignore */ }
            undo = undefined;
          }
        };
      },
    };
    return { plugin, holder };
  }

  function listAgents() {
    try {
      const agents = ctx.get("agents");
      const rows = agents && typeof agents.list === "function" ? agents.list() : undefined;
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  function applyTo(agent) {
    if (disposed || !agent || typeof agent !== "object") return;
    const id = typeof agent.id === "string" ? agent.id : undefined;
    if (id === undefined) return;
    const effective = [...deny];
    const existing = mounted.get(id);
    if (existing !== undefined) {
      if (effective.length === 0) {
        mounted.delete(id);
        try { existing.fiber?.dispose?.(); } catch { /* ignore */ }
      } else {
        existing.holder.setDeny(effective);
      }
      return;
    }
    if (effective.length === 0) return;
    const scopeCtx = agent.ctx;
    if (!scopeCtx || typeof scopeCtx.plugin !== "function") return;
    try {
      const { plugin, holder } = pluginFor(effective);
      const fiber = scopeCtx.plugin(plugin);
      mounted.set(id, { fiber, holder });
    } catch (error) {
      warn(`挂载工具过滤插件失败（agent ${id}）：${String(error?.message || error)}`);
    }
  }

  function reapply() {
    for (const agent of listAgents()) applyTo(agent);
    // 生效数 = 当前挂着过滤器的 agent 数（真实计数，不是 listAgents 的总数）
    return mounted.size;
  }

  /** 当前实际挂着过滤器的 agent 数。 */
  function mountedCount() {
    return mounted.size;
  }

  function start() {
    if (started || disposed) return;
    started = true;
    try {
      off.push(ctx.on("agent/created", (payload) => applyTo(payload?.agent)));
      off.push(ctx.on("agent/disposed", (payload) => {
        const id = payload?.agent?.id;
        if (typeof id === "string") mounted.delete(id);
      }));
    } catch (error) {
      warn(`订阅 agent 事件失败：${String(error?.message || error)}`);
    }
    reapply();
  }

  async function setDeny(next) {
    deny.clear();
    for (const name of Array.isArray(next) ? next : []) deny.add(String(name));
    const saved = await persist();
    reapply();
    return { ok: true, deny: [...deny], applied: mounted.size, saved };
  }

  async function mergeServerDeny(serverName, nextList) {
    const merged = replaceServerDeny([...deny], serverName, nextList);
    return setDeny(merged);
  }

  function getDeny() {
    return [...deny];
  }

  function deniedFor(serverName) {
    const prefix = `mcp__${serverName}__`;
    return [...deny].filter((name) => name.startsWith(prefix));
  }

  function dispose() {
    disposed = true;
    for (const offFn of off.splice(0)) {
      try { offFn(); } catch { /* ignore */ }
    }
    for (const [, entry] of mounted) {
      try { entry.fiber?.dispose?.(); } catch { /* ignore */ }
    }
    mounted.clear();
  }

  return { load, start, dispose, setDeny, mergeServerDeny, getDeny, deniedFor, reapply, mountedCount, listAgents };
}
