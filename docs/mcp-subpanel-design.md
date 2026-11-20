# 「管理 → MCP 连接器」子面板设计方案

> 参照实现：Fishquito7/dsh-skill-mcp-panel（src/mcp/model.ts、status.ts、rows.ts、tool-filter.ts、oauth.ts、client.ts 385KB）。
> 本方案基于 dsh-market 0.5.114 的现状：管理 tab（SKILL/MCP 双子页签）、mcp.list/search/install/uninstall/toggle/detail/update/trash/restore/trashEmpty 十个 op（注意：probe 语义目前只存在于 mcp.install 返回值的 pending 字段里，
> 没有独立的 mcp.probe op——src/mcp.js 有 probe 方法但未暴露，这是 P0 要补的第一件事）；
> 安装进度条（waitForTools 600ms 轮询/120s）、回收站区（恢复/清空）、结果提示排在刷新之后（0.5.106）。
> 关键架构事实：两条安装路径最终都落到同一个 `@deepseek-ai/dsh-mcp-client` 实例——插件路径是 composition 的
> dsh-mcp-client 行（如 @local/rea-mcp），市场路径是 JSON 定义 + `ctx.plugin(mcpClient, toClientConfig(def))` 动态 fiber。
> 本面板只管 JSON 定义平面，绝不写 cordis.patch.yml（那是参照面板的做法，会把宿主组合层变成面板的存储，风险不可控）。

---

## 一、现状差距分析（对照参照面板，逐条给证据）

| 能力 | 参照面板 | dsh-market 现状 | 差距来源 |
|---|---|---|---|
| 连接状态灯 | loader entry phase（pending/loading/active/failed/unloading，status.ts FIBER_PHASE） | 只有 mounted 布尔 + tools 数 | 我们没读 ctx.loader |
| 编辑表单 | 全字段（command/args/env/headers/url/cwd/toolCallTimeoutMs/重连四参数），env null=删除语义 | 抽屉表单**已存在**（client.js detail drawer：命令/URL/参数+saveMcpEdit），但只能从搜索 tab 的市场抽屉打开，已装连接器无入口 | UI 入口缺失（非表单缺失） |
| 测试连接 | probe 独立实例、不碰 live fiber | src/mcp.js 有 probe 方法（pending 语义）**但 index.js 从未暴露成 op**；面板只在安装流程里用 probeTools | op 缺失 |
| 工具级禁用 | tool-filter.json 四层策略（global/workspace/session/subagent），从模型工具表真删 schema | 无 | 宿主级概念，需 ctx.tools 干预，本插件无此通道 |
| OAuth | 完整调度器（start/poll/refresh/disconnect） | 无 | 宿主凭据体系外，成本高 |
| 凭据模板 | ${credential:REF} 展开 | 无（只有 ${VAR} 占位 resolvePlaceholders） | 宿主 credentials provider 未注入我们 ctx |
| 分组/多工作区 | groups.ts、scope.ts | 无 | 参照面板管理的是 patch 行，平面不同 |
| 回收站 | 无 | 有（mcp.trash/restore/trashEmpty，同名冲突自动别名） | 我们独有 |
| 安装进度 | 写 patch 后 waitForLoaderState 3s | registry/lobehub 市场 + pending 探测 + 120s 进度条 | 各有优势 |

## 二、设计原则（红线）

1. **定义平面唯一**：面板的一切写入只落 `<mcpDir>/<serverName>.json`；cordis.patch.yml 不是本面板的存储，
   读都不读（参照面板写 patch 行，我们不跟——patch 是宿主组合层，误写会让整个 profile 起不来）。
2. **状态只读**：loader phase 通过新增 `mcp.status` op 在服务端读 `ctx.loader.entries()`（status.ts 的 FIBER_PHASE
   映射照抄语义：0 pending/1 loading/2 active/3 failed/4 null/5 unloading），面板不做跨进程猜测。
3. **诚实降级**：每个新字段先探能力再渲染（与 sortCapabilities 同思路）——mcp.status 失败时状态灯退化为
   mounted 布尔，绝不显示假状态。
4. **TDZ 纪律**：所有新 effect 必须排在其依赖的 const 定义之后（test-tdz-order 整文件 lint 已锁）。
5. **结果提示排在刷新之后**（0.5.106 锁）：新表单的保存/测试反馈同样遵守。

## 三、分期设计

### P0（纯 UI + 已有 op，零服务端改动，client.js 热更新免重启）

- **每行状态区重构**：`● active（n 工具）/ ◐ loading / ✗ failed（原因）/ ○ 未挂载（缺 env: KEY…）`。
  P0 阶段数据源 = mcp.list 现有字段（enabled/mounted/tools/error 摘要），缺 env 的行现在就是静默不挂载，
  要把 missingEnv 的键名透出来（mcp.list 已带 envKeys，前端可判）。
- **编辑表单（最大功能差 #1）**：行内「编辑」→ 抽屉表单：
  - 可改：title/description/url/headers/env/toolCallTimeoutMs/enabled；
  - **command/args 只读展示**（面板通道拒绝任意命令执行是既定安全边界，与 mcp.install 拒 body.command 一致；
    要改命令 → 提示走 agent 工具 mcp_market_install 或卸载重装）；
  - env 行编辑用「key + value + 删除勾选」三列，null=删除语义照抄参照面板 model.ts 注释；
  - `${NAME}` 占位符写法原样保留（我们已有 resolvePlaceholders，语义等价参照面板的 ENV_REF_RE）；
  - 保存走已有 mcp.update → 成功后 reconcile 重挂载 + 结果提示排在刷新后。
- **测试连接按钮**：行内「测试」→ **新增 `mcp.probe` op**（封装 src/mcp.js 已有的 probe 方法，pending 语义与
  mcp.install 一致；注册进 rpc-guard 与三份白名单）。结果区显示：
  `✓ 连接成功，发现 n 个工具（x 秒）/ ⏳ 服务器还在启动（npx 冷下载）/ ✗ 失败：<error>`；
  复用 waitForTools 的轮询骨架，上限 120s，按钮期间禁用防重复。
- **工具清单展开**：行点击展开 tools 数组（mcp.detail 已有），>30 个工具时折叠 + 搜索框（纯前端）。

### P1（新增 2 个 op，服务端小改，需重启生效）

- **mcp.status op**（新）：返回 `{ serverName, phase, error?, tools }`，phase 取 loader entry 状态映射；
  注册进 rpc-guard 白名单 + 三份测试白名单（漂移锁会抓）。这是状态灯从「布尔」升级到「生命周期」的唯一正路。
- **重连参数暴露**：定义 JSON 增加 reconnect{initialDelayMs,maxDelayMs,maxAttempts}（toClientConfig 现在硬编码
  enabled:true，参照面板 DEFAULT_RECONNECT 是 500/30000/10——我们取同默认值，编辑表单高级区可改）。
- **toolCallTimeoutMs 进表单**（已有字段，只是没 UI；参照面板默认 60000 与我们一致）。

### P2（明确不做，写明理由）

- **工具级禁用**（参照 tool-filter.ts）：~~本插件没有合法的中间层~~ —— **此判断已被后续取证推翻**（2026-11-20）。
  宿主 `@deepseek-ai/dsh-tools` 提供官方机制 `ctx.tools.restrict(filter)`：按 agent 作用域施加 allow/deny 掩码，
  掩码相交、被隐藏的工具连 schema token 一起省掉（README 原文），返回精确 disposer。约束是它**要求 scoped
  context**（`agent.ctx`）——在全局 ctx 上调用会直接抛错（src/index.ts:165），所以正路是 `inject: ['agents']`
  后用 `ctx.agents.list()/get(sessionId)` 拿到每个 agent 再对其 `agent.ctx.tools.restrict(...)` 施加，
  参照面板的 applyTo/reapply 就是这个形状（tool-filter.ts:394-435）。
  **结论修正**：不是「不可做」，而是「超出 P0–P1 范围」——它需要新的持久化（deny 列表存储）、
  会话级覆盖与子代理例外三层语义，以及 restrictableNames 校验（命名未知工具会抛错）。列为 P2，按上述机制实现。
- **OAuth**：参照面板 oauth.ts 35KB + scheduler 12KB，依赖宿主凭据体系（${credential:REF} 的 provider）。
  我们 ctx 未注入 credentials。**结论：不做**；需要 OAuth 的连接器引导用户走宿主文档路径。
- **分组/多工作区作用域**：参照面板管理 patch 行所以有 scope 概念；我们的定义平面是 profile 全局
  （mcpDirs 本身已是多目录分层）。**结论：不做**，避免两个平面双写。

## 四、数据契约（新增/变更字段）

```jsonc
// <mcpDir>/<serverName>.json —— 新增两个可选字段（旧定义缺省即兼容）
{
  "serverName": "…", "transport": "stdio|streamable-http",
  "command": "…", "args": ["…"], "env": { "K": "${V}" },
  "url": "…", "headers": { "Authorization": "Bearer ${T}" },
  "toolCallTimeoutMs": 60000,
  "reconnect": { "enabled": true, "initialDelayMs": 500, "maxDelayMs": 30000, "maxAttempts": 10 },
  "disabled": false
}
```

mcp.status 返回：`{ ok:true, items:[{ serverName, phase:"pending|loading|active|failed|unloading", tools:[…], error? }] }`

## 五、测试计划（TDD，先 RED 后 GREEN）

- P0-1 编辑表单：test-mcp-edit-form.mjs —— 抽屉字段完备性（command/args 必须 disabled 属性）、env null=删除、
  保存后 mcp.update 调用序（先 update 后 reconcile）、结果提示排在刷新后（复用 Test 8 模式）、TDZ 锁自动覆盖。
- P0-2 测试连接：test-mcp-probe-button.mjs —— probe pending 渲染 ⏳ 而非 ✗（防 0.5.103 假阴性回归）、
  按钮防重复、120s 上限文案。
- P1-1 mcp.status：test-mcp-status.mjs —— phase 映射表逐值断言（6 态）、白名单三处同步（漂移锁）、
  op 不新增 DESTRUCTIVE（只读）。
- 回归基线：现有 25 套件必须全绿才发布；CI 门运行器归因已就绪。

## 六、工作量与顺序

| 期 | 内容 | 规模 | 需重启 | 依赖 |
|---|---|---|---|---|
| P0 | 编辑表单 + 工具展开 + 状态区重构 | client.js ~250 行 + 2 测试套件 | 否 | 无 |
| P0.5 | mcp.probe op + 测试连接按钮 | index.js ~12 行 + client.js ~60 行 + 白名单×3 + 1 测试 | 是 | P0 |
| P1 | mcp.status + reconnect 字段 | src/mcp.js ~60 行 + index.js ~15 行 + 白名单×3 + 1 测试套件 | 是 | P0 |
| P2 | 不做（文档立场） | — | — | — |

## 七、与参照面板的哲学差异（一句话）

参照面板把 cordis.patch.yml 当数据库（功能强、但面板崩了宿主起不来）；本面板把 JSON 定义目录当数据库
（故障域隔离在插件内，回收站/别名/热重载都是这个平面的红利）。方案吸收它所有能落在本平面的能力
（编辑语义、null=删除、重连四参、loader phase 状态机、pending 探测），拒绝一切需要越界写宿主组合层的能力
（工具过滤、OAuth、分组作用域），并把「不做」写成有证据的立场而不是遗漏。
