# Changelog

## 0.5.101

- **按官方原生能力扩展排序：新增 按星级 / 最新 / 最近更新 / 热门（TDD 197 项）**
  - 实测能力矩阵（同批次对比法 + 字段单调性双重验证，避开下载量计数器漂移造成的假阳性）：
    - clawhub browse `sort=`：downloads / stars / newest / updated / trending / name 均为服务端全盘排序；**installs 不单调**（数据质量差）→ 用 downloads 代替
    - skillhub `sortBy=`：downloads / stars / updated 服务端全盘；`sortBy=name` 上游返回空数组（bug）→ name 本地排
    - lobehub CLI `--sort`：createdAt / stars / installCount / name / relevance / ratingAverage / commentCount / updatedAt 原生支持
    - trusttools：仅 `sort_by=install_count` 有效；stars 被忽略、newest/updated/trending/name 返回 EMPTY → 诚实不支持
    - modelscope：无任何服务端 sort（实测 9 种参数名全被忽略）→ 全量拉取（上游深度上限≈45k）后本地排 DownloadCount / SourceStar / GmtCreate / GmtModify
    - browse.sh：一次全给 479 条 → 本地排 installCount / updated / name 即真实全盘
    - skillsmp：API 被 Cloudflare 挡、CLI 仅 stars|recent → 诚实声明只支持 name
  - 新增 `src/sort-capability.js` 作为能力矩阵唯一事实源（server 侧），dispatcher 的 supportsSort 改为委托它；删除旧的 INSTALL_COUNT_CAPABLE 单键表。
  - `sortRawRows` 泛化为 getters 映射（键→字段），排序键与卡片展示字段一一对应；clawhub 卡片补 stars/createdAt/updatedAt，browse.sh 补 updated。
  - UI 下拉改为按能力矩阵生成：默认顺序 + 该源支持的排序项（按安装数/按星级/最新/最近更新/热门/按名称）；不支持的键不下发，消除「选了没反应」。
  - 修复本轮引入的回归：msDepthHint 声明被误插到 trusttools 函数内，导致 modelscope 抛 ReferenceError 静默返回 0 条（test-paging 抓到）。
  - 测试：新增 test-full-sort(24)、test-sort-options(24)；全套 **197 项全绿**（16 套件，另 2 项因上游不可达 skip）。

## 0.5.100

- **恢复面板「修复会话」+ 清除 164 行死代码（TDD，离线 100 项全绿）**
  - **0.5.98 的功能破坏（本批修复）**：当时把 `sessions.repair` 加入 `HTTP_BLOCKED_OPS` 整体封禁，但面板正是它唯一的合法调用方——「修复会话」按钮（含 dryRun 预演）整个失效。防护应分层：该 op 已有 confirm 闸门 + dryRun 豁免，封禁多余且有害。`HTTP_BLOCKED_OPS` 清空；新增 `test-rpc-surface.mjs`(6) 锁住不变量：**面板调用的任何 op 都不得被服务端封禁**，防止再次「安全修复破坏功能」。
  - **死代码清除**：`sources.js` 删除 LobeHub MCP 遗留集群（searchLobeHubMcp / lobehubMcpConfig / extractMcpServers / decodeHtml / ENTITIES / lobehubSlugs / SKILLS_SH_INSTALL_RESOLVED_KEY，-100 行，纯删除零新增）；`skills.js` 删除精选目录遗留（curatedSkills / searchFromSources / CATALOG_FILE / catalogCache / HERE / fileURLToPath import，-64 行——catalog 目录本就不存在、files[] 也不打包它，curatedSkills 永远返回空数组）。每个符号删除前均经全仓引用扫描确认零调用方。
  - **误导性注释修正**：路由处「请求必须来自本机 GUI 页面」与恒通过的 check() 矛盾（0.5.99 遗留），改为如实描述当前分层防护。
  - 验证：9 个离线套件 100 项全绿；skillhub/modelscope/trusttools 直连探测确认删除未误伤（trusttools 为上游故障，非代码问题）；index.js 加载正常。

## 0.5.99

- **清理批次：移除生产调试日志与死代码，sessions.scan 节流（TDD 141 项）**
  - **P0 调试日志**：诊断 Origin 问题时加入的「每请求写一行 dsh-rpc-headers.log」忘了删，随 0.5.96–0.5.98 发布到 npm（实测 162 行/9KB 且持续增长）。已删除写入语句与 `appendFileSync` import。`test-cleanup` 断言全仓不再出现该字符串，防复发。
  - **P0 frame.check 删除**：面板从未调用过它（client.js 零引用），却提供任意 URL 服务端 fetch + redirect:follow 的 SSRF 面（实测可探测本机端口状态）。`case "frame.check"`、`checkFrameable`、README 宣传段落一并移除。
  - **P1 rpc-guard 死代码清理**：`token`/`checkToken`/`TOKEN_HEADER`/`isTrustedOrigin` 无任何生产调用方，但曾有 32 项 CI 断言为其护航——给死代码上闸门比没测试更危险。文件重写为只保留 `check()`（恒通过，注释说明原因与历史）与 `checkDestructive()`（真正生效的 confirm 契约）。头注释如实记录 0.5.95 的教训（面板不带 Origin 被误伤 / 本机进程可伪造绕过，实测证据）。
  - **P1 sessions.scan 节流**：无鉴权 HTTP 面上的深扫每次 ~1.5s，可被本机进程滥用作侦察+拖慢宿主。浅扫结果缓存 30 秒（命中返回 `cached:true`），所有扫描经 single-flight 串行化，并发请求共享同一次扫描。面板显式点击不受影响。
  - **P1 CHANGELOG 勘误**：0.5.95 的「RPC 来源准入」已被实测推翻且弄坏过面板，CHANGELOG 中补记勘误，防止误读版本历史。
  - 测试：新增 `test-cleanup`(14)；`test-rpc-guard` 重写为只测生效契约(23)；全套 **141 项全绿、13 套件**。

## 0.5.98

- **P0/P1 修复：临时目录兜底、原位恢复、真实目录上报（TDD 136 项）**
  - **临时目录退化（P0）**：`os.tmpdir()` 依赖 TEMP/TMP/TMPDIR，三者全空时（实测本环境）Windows 拼出字面量 `undefined\temp`，导致上传/预览/解压/缓存全部 ENOENT。上一版只改了 sources.js 一处；本次新增 `home.safeTempDir()`（校验→逐级回退→`~/.dsh/tmp` 兜底→确保存在），并替换全部 **9 处**生产调用（index.js 4、extra-sources.js 3、github.js 1、sources.js 1），补齐 4 个文件的 import。`test-safe-temp` Test 3 断言全仓不再有裸 `tmpdir()`。
  - **恢复落点错误（P0）**：`restoreFromTrash` 按 `originalDir(=根)+slug` 恢复，把 `@owner/slug` 的技能复原成扁平 `根/slug`——位置错且之后按两层扫描找不到。现在优先按 sidecar 的 `originalPath` 原位恢复，冲突去重也留在原父目录。实测：卸载→恢复→再列出，路径全程正确。
  - **列表/详情目录字段（#5）**：`listInstalledSkills` 的 `dir` 原为扫描根目录，面板直接显示它、`market.openDir` 又 `join(dir, slug)` 二次拼接，@owner 技能会指向不存在的路径。现在 `dir` = 技能自身目录（`dirname(SKILL.md)`），并新增 `root` 字段保留扫描根；`market.openDir` 改为直接用 `item.dir`。与 `installSkill` 返回的 `dir`（本就是技能目录）语义统一。
  - 端到端实测：listed→uninstall→trash→restore→relist→openDir 六步全部正确；install 结果 dir 与 list 一致。
  - 测试：新增 `test-safe-temp`(15)；全套 **136 项全绿**，CI 发布闸门包含全部 12 个套件。

## 0.5.97

- **修复「看得见却删不掉」：@owner/slug 两层布局在卸载/详情/开关上全部失效（TDD 121 项）**
  - 症状：面板显示 `lgd-skill-review` 已安装，点卸载返回 `{"ok":false,"removed":[]}`，界面无任何反应。
  - 根因：clawhub CLI 装到 `<root>/@<owner>/<slug>/`，而 **4 处**各自只枚举一层路径：
    - `uninstallSkill` → 卸载永远匹配不到
    - `resolveSkillFile` → 「关闭」开关、`skills.detail` 全部失效（连带 `skillFileToggleable`）
    - `readSkillBody`（provider.js）→ 详情页对 @owner 技能返回「未找到」
  - 0.5.96 只修了 `listInstalledSkills`（列表可见），删除路径没同步——于是变成「看得见、删不掉」的自相矛盾状态。
  - 修法：四处统一按「一层 `<root>/<slug>/` + 两层 `<root>/@<owner>/<slug>/`」枚举；`resolveSkillFile` 改为 async 并同步 await 全部调用方（index.js 两处、test-new-features 一处）。
  - 实测：`uninstallSkill('lgd-skill-review')` → `{"ok":true,"removed":["...@zhaoxinghua09-cell\\lgd-skill-review"]}`，列表随即清空，条目进回收站可恢复。
  - 测试：新增 `test-uninstall-nested`(12)，覆盖列表 / 详情 / 开关 / 卸载四个入口。

## 0.5.96

- **功能修复：TrustTools 搜索失效、安装目录看不见、分类筛选、安装链路（TDD 109 项）**
  - **TrustTools 搜索从未生效**（P0）：上游参数是 `search`，代码一直发 `q`（被忽略，永远返回默认列表）。实测 `q=playwright`→feishu-*，`search=playwright`→e2e 相关。已改正。
  - **安装成功的技能永远进不了「已安装」**（P0）：clawhub CLI 装到 `<root>/@<owner>/<slug>/` 两层，而 `listInstalledSkills` 只扫一层。现在对 `@` 前缀目录下探一层；实测装完后可见。
  - **分类筛选是假的**（P0）：`searchSkills` 从未接受 `category`，客户端只在当前页本地过滤。现在签名接收 category，在返回前按 category 过滤；源无分类数据时返回 `categoryNote` 如实告知而非静默返回全量。
  - **切源不重置分类**（P0）：切源沿用旧 category 会在筛选落到服务端后变成空列表。现在切源同步 `setCategory('all')`。
  - **排序下拉与能力不符**（P1）：无安装量数据的源（skillsmp / browse.sh / skills.sh）如实标注「默认顺序」。
  - **安装参考统一**（P1）：新增 `installRefOf()`，dispatcher 为每条结果盖章 `installRef`；客户端 7 层三元简化为单字段 + 兜底。
  - **skills.sh 安装链路修复**（P1，连带发现 3 个真 bug）：
    - `curl -s` 缺 `-f`：404 返回空串被当成「文件存在」，导致 `findSkillDirFor` 选中不存在的 `skills/engineering/<slug>`。已加 `-f`，并对空响应体判为失败。
    - 空 `ref` 拼出 `repo//path` 与 `repo@`：jsDelivr 返回 400/404。现在空 ref 归一化为 HEAD / 省略 `@`。
    - `fallbackCache` 用 `process.env.TEMP`：无环境注入时退化成字面量 `undefined\temp` 并让 `mkdtemp` ENOENT。改用 `os.tmpdir()`。
  - 测试：新增 `test-func-fixes`(9)；`test-sort-honesty` 消除目录预热的竞态；全套 **109 项全绿**。

## 0.5.95

> **勘误（0.5.98 补记）**：本版宣称的「RPC 来源准入」经实测推翻——面板 fetch 不带 Origin（宿主调试日志
> 162 条全部 origin:null），导致面板被自己的 403 拦死；而本机任意进程又可伪造 Origin 绕过。
> 同版还把调试日志留在生产代码里。0.5.98 移除该闸门与调试日志，教训详见 0.5.98 CHANGELOG。
- **P0 安全：RPC 来源准入 + 破坏性操作二次确认；P1：假排序修正 + 扫描闸门**
  - **RPC 零鉴权**（P0）：`/api/dsh-market/rpc` 此前无任何校验，实测本机任意进程 POST 即返回 `settings.get` 全部路径与 `sessions.scan` 全部会话列表（HTTP 200）。新增 `src/rpc-guard.js`：请求必须来自本机 GUI（Origin/Referer 属于 loopback）。已实测浏览器同源 POST **必然携带 Origin**，第三方网页与无关进程无法伪造。无来源 → **403**。
  - **破坏性操作无确认**（P0）：`sessions.repair` / `skills.uninstall` / `mcp.uninstall` 直接执行。现统一要求 `confirm:true`（与既有的 `skills.trashEmpty` 约定一致）；`sessions.repair` 的 `dryRun` 为只读预演，豁免确认。面板侧已同步传参，并有测试锁定该契约。
  - **skills.sh 假排序**（P1，上一版我自己引入）：该源无安装量数据，按「安装数」排序会把上游顺序打乱成第三种顺序。新增 `supportsSort()` 能力声明：不支持的源降级为「不排序」，保持上游原序。
  - **排序键与展示同源**（P1）：新增 `sortKeyOf()`，排序与卡片展示共用同一取值口径。
  - **目录共享污染**（P1，修复中发现）：`sortSkillsShRows` 就地排序，无查询时 `matched === catalog`，会改写模块缓存——这是「排完序后默认顺序也变了」的真实根因。改为排序副本（`matched.slice()`）。
  - **安全扫描改为默认拦截**（P1）：`verify.js` 有 11 条 high 规则，但此前只报告不拦截。新增 `shouldBlockInstall()`：高危默认拒装，`force:true` 才放行，`force` 时仍返回发现。
  - 测试：新增 `test-rpc-guard`(32)、`test-scan-block`(6)、`test-sort-honesty`(9)；全套 **106 项全绿**，`npm test` 扩至 9 个套件并作为 CI 发布闸门。

## 0.5.94

- **让 CI 闸门真正可跑：测试去掉 Windows/网络耦合**
  - 0.5.93 的 publish 在 CI 上被测试闸门拦下（`Run tests → failure`，Publish 被 skip）。根因是两个测试只在 Windows 上成立：
    - `test-security.mjs` 的根目录写成 `path.join('C:','tmp',...)`，在 ubuntu 上退化为相对路径，绝对路径断言必失败。改用 `os.tmpdir()`。
    - `test-profile-sync.mjs` 硬编码 `D:\DeepSeek Harness WorkSpace\dsh-market`，CI 上没有该目录。改为只认环境变量或 `~/dsh-market`，缺失即跳过。
  - `test-global-sort.mjs` 重写为两条腿：**合成数据验证切片契约**（始终运行、零网络）+ **真实上游可选验证**（连不上则 SKIP），不再让 CI 因网络抖动失败。
  - 本地 desktop profile 已实测可运行：`index.js` 可导入、`src/sources.js` 真实搜索出结果、翻页无重叠、路径穿越被拦、POSIX 转义生效。

## 0.5.93

- **排序彻底修好：8 个源全部跨页全局单调（TDD，21 项断言）**
  - 0.5.92 只修了 modelscope/skills.sh 的窗口；实测 trusttools、skillhub、lobehub 仍跨页错乱（各自上游分页窗口不同）。
  - 统一契约：排序模式下**固定从第 1 页取宽窗口 → 本地全局排序 → 切出第 p 页**，窗口不随页码变化。
    - trusttools / skillhub / lobehub / modelscope / skills.sh 均按此实现；lobehub 排序模式不再依赖 CLI `--sort`。
  - 缓存 key 必须含**请求页 p**（此前第 2 页复用第 1 页的整窗缓存，实测 p2 与 p1 完全重叠 24 条）。
  - 验证：`trusttools 63023<=63102`、`skillhub 3746<=4387`、`modelscope 6199<=6512`，全部单调。

## 0.5.92

- **P0 安全修复：slug 路径穿越 + POSIX 命令注入；P0 正确性：跨页排序；P0 工程：CI 测试闸门**
  - **跨页排序**（实测 bug）：dispatcher 在 handler **切页之后**排序，导致每页各自有序、页与页无序（trusttools 第1页 max=55794，第2页 max=60406）。改为 handler 在切页之前排序；modelscope/skills.sh 取固定窗口后全局排序再切页；dispatcher 仅对多源聚合再排一次。
  - **slug 路径穿越**（P0）：`kebab(slug) || slug` 对纯符号名回退到原始值，`slug=".."` 可让安装写出 skills 根目录。新增 `safeInstallSlug` / `resolveInsideRoot`；纯中文名改为保留原字符（不再被误拒）。
  - **POSIX 命令注入**（P0）：`env.js` 的 Unix 分支只转义双引号，值被写入 `~/.profile` 后会在下次登录展开 `$(...)`。新增 `buildPosixExportLine`，单引号包裹并把 `'` 转义为 `'\''`。
  - **CI 闸门**（P0）：`package.json` 增加 `npm test`，publish 工作流在发布前执行测试。此前 25 个版本零测试，分页/排序改坏多次都进了 npm。
  - **测试可移植**：`test-profile-sync.mjs` 不再写死用户名路径，改用 `os.homedir()` + 环境变量，缺路径时跳过。
  - 新增测试：`test-global-sort.mjs`（7）、`test-security.mjs`（11）；全套 44 项全绿。

## 0.5.91

- **分页总页数改为诚实语义：无界流不再谎报下界（TDD）**
  - 新证据：clawhub 的 browse 目录实测 **30,150 条且游标仍未耗尽**（缓存一度涨到 30MB）。上游从不返回 total，所以「精确总页数」对它根本不可能——它和 MCP 官方注册表是同一类。
  - 根因：handler 用「已抓到的行数」反推页数，把 25 条说成「共 2 页」；dispatcher 又把「没设置 totalPages」和「明确未知」混为一谈，一度让 trusttools（579,074 条）也变成未知。
  - 修法：`state.done` 才报精确 `totalPages`，否则 `total/totalPages = undefined`；dispatcher 按「声明数字 > 真实 total 反推 > 未知」三级判定；`warmClawHubCatalog` 加**有界预算**（默认 1200 行）终止爬取。
  - 效果：clawhub / MCP 注册表 → 窗口式 ±5 +「可继续加载」；skills.sh 1667 页、trusttools 48257 页、skillhub 19187 页等 → 精确页码 + 省略号。
  - 测试：`test-total-pages.mjs` 8 项、`test-warm-budget.mjs` 5 项、`test-dead-all.mjs` 6 项、`test-paging.mjs` 全绿。

## 0.5.90

- **修复分页总页数：dispatcher 现在透传各源的目录感知 totalPages（TDD）**
  - 根因：dispatcher 丢弃 handler 的 `totalPages`，用被下限钳制的 `total` 反推页数——clawhub 缓存了 3016 条目录，首页却显示「共 2 页」。修法：逐源累加 `pagesSum`，`pages = max(pagesSum, ceil(total/size), 1)`。
  - 清理「全部来源」失效残留：chip 数组不含 'all'，`key === 'all' ? '全部来源'` 分支不可达，已删；`LOAD_MORE_CAPABLE` 导出无任何引用，已删。保留 `ALL_SOURCES` 与 dispatcher 的 `source:"all"` 路径——那是 MCP 工具 `skill_market_search` 的默认聚合，是活的。
  - 修复 desktop profile 陈旧：12 个文件停留在 0.5.66 之前（吸顶头部与省略号分页器丢失），现已与工作树逐字节同步，`test/test-profile-sync.mjs` 守护。
  - 测试：`test-total-pages.mjs`（7 项）、`test-dead-all.mjs`（6 项）、`test-profile-sync.mjs`（7 项）、`test-paging.mjs` 全绿。

## 0.5.89

- **clawhub 预热改为串行容错版（3 次连续失败才停）**
  - 根因：0.5.88 的 3 路并发预热在 Node 24 下触发 clawhub API 限流，python urllib 全挂 → 0 条。
  - 修法：改回串行（每次 1 个 API 调用），单次失败等 3 秒重试，连续 3 次失败才停。全量 ~50 页 ≈ 5-8 分钟。
  - TDD：`test/test-warmup.mjs` 4 个测试（rows>500 / totalPages>1 / 精确总页数 / 完成时间<10min）。

## 0.5.88

- **clawhub 并行预热：3 路并发 cursor 遍历，全量目录 ~5 分钟（原 50 分钟）**
  - 根因：0.5.87 串行遍历 ~50 次 API 调用（4-10s/次），全量需 50 分钟；用户等不到预热完成就翻页 → 总页数始终为下界。
  - 修法：`warmClawHubCatalog` 改为 3 路并发（每路连续取 3 页），实测 7.4 条/秒，全量 ~2400 条约 5 分钟。
  - 同时修复了 null cursor 被误判为 done 的 bug（`!start` 应为 `start === undefined`）。
  - 效果：Host 重启后 ~5 分钟预热完成，clawhub 总页数变为精确值（如「共 98 页」）。

## 0.5.87

- **clawhub 全量预热：Host 启动时后台遍历全部 cursor（~50 条/页 × ~50 页 ≈ 2400 条，约 10-15 分钟），完成后缓存 6 小时**
  - 根因：0.5.86 的 `warmClawHubCatalog` 只预热 3000 条上限 + setTimeout 60s 后再继续，实际只预热了 ~1500 条，翻页时 cursor 未耗尽 → 总页数仍是下界。
  - 修法：去掉 3000 上限和 setTimeout，`extendClawHubCatalog(cache, 99999)` 一次遍历到 cursor 耗尽；`warmMarketCache` 是 `Promise.allSettled`，不阻塞其他源。
  - 效果：Host 重启后 ~10-15 分钟预热完成，clawhub 总页数变为精确值（如「共 98 页」），翻页即时切片。

## 0.5.86

- **clawhub 后台预热全量目录，首页秒开、翻页有真实总页数**
  - 根因：全量 cursor 遍历（~2400 条 × 50/页）需 ~50 分钟，不能阻塞首页。
  - 修法：首页只取 150 条（~10 秒）即时显示；Host 启动时 `warmMarketCache` 后台并发预热 clawhub 全量目录（60 次 API 调用），完成后缓存 6 小时。用户翻页时直接切片，总页数精确。
  - 效果：clawhub 第 1 页 → 秒开 + 「共约 N 页」；预热完成后 → 精确「共 98 页」。

## 0.5.85

- **clawhub 首页预载全量目录（3000条），真实总页数**
  - 根因：之前 `need = min(600, size × page)` 导致首页只累积 1-2 个 cursor 页（~25 条），总页数恒为 1-2。
  - 修法：`page === 1` 时 `need = 3000`（约 125 页 × 24 条），首次打开面板约 30-60 秒加载全量；翻页时按当前深度 +5 页预载。
  - 效果：clawhub 第 1 页 → `共 98 页`，分页器 `1 2 3 4 5 6 … 98`。

## 0.5.84

- **分页器窗口加宽至 ±5 页（已知总数时）+ 所有源返回 totalPages**
  - 根因：0.5.83 的省略号窗口半径写死 ±2，加上首页 cursor 只累积到当前页深度，导致所有源的分页导航只显示 1-2-3 共 3 个页码。
  - 修法：`client.js` 已知总页数时半径改为 ±5（`span = n === 0 ? 2 : 5`）；`src/sources.js` dispatcher 和 `src/extra-sources.js` 所有处理器补上 `totalPages` 字段。
  - 效果：clawhub 第 99 页 / 共 98 页 → `1 … 94 95 96 97 98`；skills.sh 第 1 页 / 共 834 页 → `1 2 3 4 5 6 … 834`。

## 0.5.83

- **clawhub 支持总页数统计**（cursor 耗尽时精确，未耗尽时下界）
  - browse（空查询）：`extendClawHubCatalog` 累加 cursor，耗尽时 `totalPages = ceil(rows/size)` 精确值；未耗尽时显示下界（「共约」）。
  - search（带关键词）：`merged.length < wanted` 时 `totalPages` 精确；`hasMore` 时不显示总页数。
  - 前端 `skillsTotalPages` 默认改为 0（未知），pager 据此走窗口式而非全页码。
  - 效果：clawhub browse 翻到最后一页时显示精确总页数；中间页显示「共约 第 X / Y 页」。

## 0.5.82

- **技能市场分页恢复全页码显示；MCP 注册表保持窗口式页码**
  - 真因：0.5.43 起 `pager` 统一改为窗口式（前后各 5 页），但用户要求**技能市场显示全部页码**（因为可数），**MCP 官方注册表才用窗口式**（因为无法统计总数）。
  - 修法：`pager` 新增第 7 参 `windowed`（默认 true）。技能 tab 传 `windowed=false`（已知总页数时显示 1..N 全部页码）；MCP tab 传 `windowed=true`（窗口式 ±5 页）。
  - 效果：技能市场第 11 页 → 显示 1-13 全部页码按钮；MCP 注册表第 11 页 → 显示 6-16 窗口式页码。

## 0.5.81

- **补交 index.js 的 `sort: body.sort` 透传**（0.5.80 同步时遗漏，导致重启后排序仍不生效）
  - 0.5.80 的 `git add -A` 只提交了 4 个文件（client.js / CHANGELOG / package.json / sources.js），index.js 的 `sort: body.sort` 改动在 work 副本里存在但未进入 commit，profile 副本里也缺失。
  - 本次将 work / profile / D 三处 index.js 统一为含 `sort: body.sort` 的版本，三处逐字节一致。
  - 需重启 Host 生效（Host 启动时从磁盘加载 index.js）。

## 0.5.80

- **修复：切换排序后不重新拉取**（导致 LobeHub「按安装数」显示的是默认顺序的个位数安装量）
  - 真因：`searchSkills` 的 `useCallback` 依赖是 `[]`（空数组），切排序后**不会重新触发搜索**，页面仍显示上次（默认顺序）的结果；缓存 key 也不含排序，旧缓存被复用。
  - 修法：① 缓存 key 加 `effSort`；② 新增 `useEffect` 监听 `sort` 变化，变化时清空列表并重新 `searchSkills`；③ `searchMcps` 同理（MCP tab 切排序时已有的 onChange 会调 `searchMcps`，但缓存 key 也加了 sort）。
  - 实测：切到「按安装数」后 LobeHub 立即返回 pptx(4080)/pdf(3458)/skill-vetter(3208)…严格降序；切回「按名称」按字母排。

- **去掉「多源聚合不排序」的错误限制**
  - 真因：0.5.79 的本地排序兜底加了 `wanted.length === 1` 条件，但面板 UI **没有聚合 tab**（只有单源切换），`wanted.length` 永远是 1，这个条件形同虚设——真正的 bug 是缓存不失效 + 不重新拉取。
  - 修法：去掉 `wanted.length === 1` 条件，单源时本地排序始终生效；多源聚合（如果将来加）再单独处理。

## 0.5.79

- **全部源「按安装数/按名称」排序本地兜底**
  - 真因：只有 LobeHub 源把 `sort` 传给了上游 CLI（`--sort installCount`），其余 7 个源（skills.sh / clawhub / skillsmp / trusttools / browse.sh / skillhub / modelscope）虽然签名里加了 `sort` 参数，但函数体从未使用它，上游 API 也不支持 sort，导致「按安装数」对这些源**实际没排**（trusttools 13/7/6/6/169、skillhub 1239/741/55/190/165、modelscope 4372/23030/7526/1454/7983 都乱序）。
  - 修法：`searchSkills` 聚合后加本地排序兜底——单源时 `sort==='installCount'` 按 `item.installs` 降序、`sort==='name'` 按名称升序；多源聚合时不排序（跨源安装量不可比）。
  - 实测：8/8 源全部降序正确（trusttools 169/63/35/21/13、skillhub 501556/88092/76860/58443/3351、modelscope 23030/16908/9463/7983/7526）。

## 0.5.78

- **修复 LobeHub「按安装数」排序不生效**（排在前面的安装量只有个位数）
  - 真因：`searchLobeHubSkills` 没有把 `sort` 参数传给 LobeHub CLI，导致无论选「按安装数」还是「按名称」，上游都返回 API 原始顺序（与安装量无关）。
  - 修法：全链路透传 `sort`：client（`sort==='default'` 映射为 `installCount`）→ `index.js` `skills.search` → `searchSkills` → `searchLobeHubSkills` → CLI `--sort installCount`。
  - 实测：修复后 LobeHub 浏览页（无查询词）+ sort=installCount 返回 pptx(4080)、pdf(3459)、skill-vetter(3208)… 严格降序；带查询词时 CLI 的 `--sort` 也生效（playwright-cli 1012 排第一）。
- **补回 0.5.75 的 MCP 卡片详情增强**（mcp view → manifest fallback + 详情抽屉信息块）
  - 0.5.75 的 commit 只提交了 CHANGELOG + package.json，实际代码改动丢失。本次重新写入 `viewLobeHubMcp` + `mcp.detail` 扩展 + 客户端详情抽屉信息块。

## 0.5.77

- **补齐 clawhub / LobeHub / modelscope 源的安装量映射**（卡片「· N 次安装」与「按安装数」排序对全部源生效）
  - 面板排序与卡片统一读 `item.installs`，但各源上游字段名不同：clawhub 叫 `downloads`、LobeHub 叫 `installCount`、modelscope 叫 `DownloadCount`，此前只映射了 0.5.76 的 skillhub，导致这三个源卡片仍不显示安装量、「按安装数」排序对它们按 0 排。
  - 本次三处全部补上 `installs` 映射。实测 LobeHub 卡片现在带真实数值（如 creo 系列 installCount=2）。
  - 说明：clawhub 个别卡片安装量可能显示 0，是该条目上游本身没有 `downloads`/`rolling60DayInstalls` 数据（如新发布技能），非映射缺失。

## 0.5.76

- **修复 skillhub 源「按安装数」排序恒为 0、卡片不显示安装量**
  - 真因：面板的排序与卡片「· N 次安装」统一读 `item.installs`，但 skillhub 上游字段叫 `downloads`，`toItem` 只映射了 `downloads`/`stars` 没映射 `installs`，于是该源所有卡片 `installs=undefined`——「按安装数」排序全部按 0 比，等于没排；卡片也不打印安装数（与截图一致）。
  - 修法：`skillhub.js` 的 `toItem` 补 `installs = downloads` 并写入返回对象。
  - 实测：修复后 skillhub 卡片带真实安装量（如 biaoshu-bailian 743497、ai-ppt-generate 7533），「按安装数」排序按真实数值生效。

## 0.5.75

- **MCP 卡片详情接入 LobeHub `mcp view` 详细字段**
  - 新增 `src/lobehub-market.js` 的 `viewLobeHubMcp(identifier, { cache })`：调用官方 CLI `mcp view <id> --output json` 拉取评分/安装量/分类/环境变量/主页等详细字段；CLI 鉴权失败（invalid_token）时自动回退到 `lobehubManifestDefinition` 读公开 manifest，详情永不为空。
  - `mcp.detail` RPC 扩展：`body.source === 'lobehub'` 时合并 CLI view 字段，返回 `detailSource`（`lobehub-cli` / `lobehub-manifest` / `local`）。
  - 客户端 MCP 详情抽屉新增信息块：描述、评分、安装量、分类、需环境变量、主页（可点击），并标注详情来源。
- **说明**：`mcp view` 实测在本机因 CLI 设备注册态（`invalid_token`）而回退到 manifest 路径，功能仍可用；一旦 CLI 重新 `register` 成功，详细字段自动生效，无需再改代码。

## 0.5.74

- **技能目录输入框：多目录改为逐行渲染**（修复 skills 与 custom-skills 粘成一行）
  - 真因：skillDraft 是换行拼接的多目录字符串，塞进单个 <input>，换行符在单行输入框里被吞，两个目录视觉上连成一行（数据本身正确，保存按行拆无误，纯显示问题）。
  - 修法：setPathRows 把目录串按行拆开，每个目录独占一行一个输入框，逐行可编辑、改完整块写回。MCP 目录同理。
- **clawhub / browse.sh 增加 Web API 故障时自动降级到官方 CLI 的备用通道**
  - 实测数据（本机热缓存）：clawhub Web 3.5s / CLI 44s；browse.sh Web 10.3s / CLI 16.2s。CLI 慢 3-10 倍且需 npx，所以只在 Web API 全挂或返回 0 条时启用，正常路径速度不受影响。
  - clawhub 用 clawhub search <q> --limit N（表格文本按列解析）；browse.sh 用 browse skills find <q> --json（真 JSON，结构化最可靠）。
  - 结果带 hint 标注 来自官方 CLI（较慢），让用户知道走的是备用通道。

## 0.5.73

- **已安装技能卡片的「禁用模型调用」改名为「关闭」**（启用/关闭 对称；面板级按钮仍为「在本面板隐藏」，tooltip 不变）。

## 0.5.72

- **滚动时「类型标签栏」与「分类标签栏」也固定住了**（Excel 冻结前几行效果）：
  - 真因：源 chip 行与分类 chip 行原来渲染在**会滚动的 body 内部**，随内容滚走；0.5.70 只固定了 Tab 栏与搜索栏。
  - 修法：把源/分类两组 chip 提取成 `filterBar`，渲染顺序变为 `head（Tab 栏）→ searchBar（搜索栏）→ filterBar（类型+分类栏）→ body（唯一滚动区）`——前三行都在滚动容器之外，滚动时全部常驻；body 里只剩卡片网格与状态行。
  - 实测（GUI 内）：Tab y=10、搜索框 y=60、源 chip y=106，下滚 1600px 后三者坐标分毫不变。

## 0.5.71

- **八源搜索传输链重排 + 搜索级缓存（先测后用，全部有实测数据支撑）**
  - 同机同 URL 三传输实测：`fetch` 0.8–3.5s、`curl` 2.5–20s（browse.sh 直接超时失败）、`python` 1.2–17.6s。原实现把 **python 排在第一位**，是 trusttools 反复 `python POST 失败` 的直接原因。
  - `getJsonEscalating` / `postJsonEscalating` 默认改为 **fetch → curl → python**；新增 `pythonFirst` 开关，只给 skillsmp 用（实测该站 fetch 403，唯有 CPython urllib 能过）。
  - 新增搜索级缓存（5 分钟）：skills.sh / clawhub / skillhub / modelscope。此前只有 trusttools / skillsmp / lobehub / browse.sh 有缓存。
  - 修掉自己引入的两个 bug（都被实测抓到）：clawhub 缓存块插在 `const q` 之前触发 TDZ（`Cannot access 'q' before initialization`）；modelscope 提前 return 未写缓存。
  - **改后实测（query=github）**：skills.sh 10.3s / clawhub 4.3s / skillsmp 1.4s / trusttools 2.6s / browse.sh 4.0s / lobehub 4.2s / skillhub 2.2s / modelscope 1.9s —— **8/8 全部有结果且源纯**（改前 trusttools 恒为 0 条并报错）。
  - 重复搜索（同查询）后端命中缓存后为 **0ms**（trusttools/skillsmp/lobehub/skillhub/modelscope 实测 0ms；skills.sh 剩 1.8s 是描述补全，不是搜索）。
- 插件启动时已有的 `warmMarketCache`（browse.sh / lobehub / modelscope / skills.sh 目录）继续生效，冷启动首屏不会再等满一轮。

## 0.5.70

- **修复「搜索结果显示所有源聚合、不按选中源过滤」的真正根因**：
  - 真因一：`searchSkills` 里 `const src = (options && options.source) || 'all'` —— 调用方不传 source 时**回落到 'all'** 而不是当前选中的源。回车与「搜索」按钮正是这种调用（`searchSkills(query)`，不带 options），所以只要不是点源 chip、而是**在搜索框里回车**，就必然退化成八源聚合。这也是用户截图里"clawhub + skillsmp 混排"的直接来源。
  - 真因二：`searchSkills`/`searchMcps` 的 `useCallback` 依赖是 `[]`，直接读 `source`/`category` 会**闭包住首帧的值**（永远是初始值），即便写了回落也拿不到当前选择。
  - 修法：新增 `liveRef`（每帧同步 `{source, category, size, mcpSource, mcpCategory, mcpSort}`），回调内改读 `liveRef.current`；回车与「搜索」按钮显式传 `{ source, size, category }`；MCP 侧同样处理。
  - 实测：选中 clawhub 后仅点源 chip 或在搜索框回车，列表都只剩该源卡片（切到 trusttools 时 24 张 clawhub 卡片全部清空）。
- 已知遗留（非本次引入）：**trusttools 源当前不可达** —— 面板会显示 `trusttools 不可达：python POST 失败…`。其传输优先走 python，宿主进程内 `findPython()` 探测失败时会退到裸 `python` 并报错；需要单独修传输链（已记录，未在本次改动内）。

## 0.5.69

- **修复「向下滚动后搜索栏与 Tab 标签栏消失」的真正根因**：
  - 真因：`S.panel` 上的 `overflow: 'hidden'` 把 sticky 的滚动上下文切断了——宿主面板容器才是滚动容器，`overflow:hidden` 让浏览器把 `S.panel` 当成"无滚动"的层，`position:sticky; top:0` 在该层里**没有可吸附的滚动祖先**，标签栏随内容一起滚走。
  - 修法：删除 `S.panel` 的 `overflow:'hidden'`。标签栏的 `position:sticky; top:0; z-index:3` 现在能正确吸附到宿主面板容器，搜索栏（已提至 body 外、与标签栏同级）同步固定。
  - 实测：向下滚 2000px 后标签栏 y=10、搜索栏 y=60 不变；内容卡片随滚移动；无 `overflow:hidden` 副作用（body 自身 `overflow:auto` 仍管住内容溢出）。

## 0.5.68

- **修复「选中源后搜索结果显示的是聚合结果」与 trusttools 搜索慢**：
  - 原因：`searchSkills` 分发器把 `category` 参数丢了（客户端→RPC 整条链路都没带），且点击源 chip 时 category 被重置为 all。
  - 客户端：源 chip 点击保留当前 category；`searchSkills` 接受并传递 `category`；技能分类 chip 点击本地过滤 + 回滚顶。
  - 实测（新分发器直连上游）：`source=trusttools` 返回 24 条且**全部是 trusttools**（total=579074，约 4.8s——慢在上游，不在插件；python POST 传输 + 三页拼接，属正常）。
  - 说明：trusttools 上游搜索接口本身不支持 category 过滤，分类 chip 对它做本地过滤（与 UI 其它源行为一致）。

## 0.5.67

- **空 tool-call 防护 A：写入前哨**（新增 `src/toolcall-guard.js`）
  - 缺陷本体在宿主 `@deepseek-ai/dsh-llm` 的 `BlockAssembler`：`tool-call-delta` 里 `partial.toolCallId = chunk.id` 无条件覆盖，provider 发 `id:""` 时就把 id 写成空串；`assemble()` 的 `?? `call-${index}`` 对空串无效（空串不是 nullish），`name` 同理变空。于是空 tool-call 被写进会话日志，该会话之后无法追加。
  - 插件运行在宿主主进程内，通过 `createRequire(<resources>/app.asar/dsh/package.json)` 解析到的是宿主**同一个模块实例**，因此包装原型方法即可对整个宿主生效。
  - `push` 不再让空 id 覆盖已有 id；`assembled()` 在交回结果前丢弃 **id 或 name 为空**的 tool-call 并记一行 warn 日志，正常 tool-call 原样通过。
  - 实测（宿主真实类）：空 tool-call → 丢弃、同流文本块保留；`id=call_1/name=run_code` → 原样通过；只有 id 没有 name → 丢弃；计数器 `__dshMarketGuardState.dropped` 累加。
- **空 tool-call 防护 B：启动自愈**（新增 `src/auto-repair.js`）
  - 插件启动 15s 后（`unref` 定时器，不阻塞退出）扫一遍 `$DSH_HOME/sessions`，只修「已确认那一类」损坏，且**只动 mtime 静止 ≥120s 的日志**——正在写入的会话绝不碰。
  - 修复走既有前缀截断 + 原子写回 + 自动备份，并把每次修复写入 `$DSH_HOME/dsh-market/session-repairs.json`（`{at,file,seq,reason,keepEvents,dropped,backup,by:"dsh-market/auto"}`，保留最近 200 条）。
  - 实测：坏会话被修复、正常会话零改动、修复标记与备份到位、二次运行空操作、仍在更新的损坏日志被跳过。
- **修复搜索栏与标签栏没有真正固定**（用户反馈）
  - 真因：面板 body 的 `overflow:auto` 拿不到受限高度（宿主容器才是滚动容器），因此 body 自身不滚，其内部的 sticky 完全失效——搜索栏随整页滚走。
  - 修法：把搜索栏从 body **提到与标签栏同级**（新增 `S.searchBar`），标签栏加 `position:sticky; top:0`。二者都位于滚动容器之外，滚动时不再移位。
  - 实测：向下滚 700px，卡片 y 168→-437（内容确实滚动），标签栏 y=10、搜索栏 y=60 分毫不动。
- 测试：新增 6 项（自愈 5 项 + 前哨 3 项，纯 node 下前哨自动 SKIP），两套合计 **29 + 43 = 72 项全通过**。

## 0.5.66

- **市场面板滚动条加粗加深**：`S.body` 的右侧滚动条从系统默认（~6px 半透明灰）改为 12px、拇指 `#444`、轨道 `#f3f4f6`，WebKit `::-webkit-scrollbar` 与 Firefox `scrollbar-width` 双轨。
- **搜索栏与 Tab 标签栏在向下滚动时固定**：面板 DOM 结构本身已经是 `head`（Tab 栏）+ `body`（搜索栏 + 内容）分离，只有 body 会滚动；实测向下滚 500px 后搜索框与 Tab 标签 y 坐标完全不变（268 / 10 → 268 / 10），无需改动，仅记录验证结果。

## 0.5.65

- **修复 0.5.64 的致命回归**：删除 `installedGroups` 状态时漏删了 `loadInstalled` 里的 `setInstalledGroups(s.groups || [])` 调用，导致面板任何一次渲染都抛 `setInstalledGroups is not defined`（用户三个 tab 全部红字）。已删除该调用；实测同端口 GUI 四个 tab 均无报错，「已安装」tab 正确渲染可折叠分组标题（▾ 用户目录 rank 200 · 1 个 / ▾ 插件提供 rank 500 · 1 个）与新卡片文案（禁用模型调用 / 打开文件夹 / 卸载）。

## 0.5.64

- **修复「禁用模型调用」的语义与文案**（回应"面板级提示是否合理"）：
  - 文件级生效时按钮写 **禁用模型调用 / 启用**；文件级不可用（插件提供、符号链接接入）时按钮改为 **在本面板隐藏 / 取消隐藏**，并带 tooltip 说明"模型仍会收到"。
  - `skills.list` 的每个 `items[]` 新增 `fileToggleable`（由 `skillFileToggleable` 判定），界面据此选择轨道，不再靠猜。
  - `skills.toggle` 的 `scope` 由界面按技能实际能力传入（`file` / `panel`），不再固定 `auto`。
- **分级浏览改为真正可折叠的分组**：按 rank 分组的标题行（▸/▾ + 层名 + rank + 数量 + 被覆盖数），点击折叠/展开；折叠偏好写入 `localStorage: dsh-skill-mcp-market.collapsedGroups`，跨面板重挂载与刷新保留。原先那条重复的"来源层级"汇总条已删除。
- **新增自动化测试 `test/test-new-features.mjs`（37 项）**：frontmatter 标志写（写/改/删/幂等/无 frontmatter）、双轨启停（目录型/单文件/无残留/不存在报错）、回收站（删→列→恢复→清空）、.zip（解析/安装/落盘/零残留/路径越界）、来源分级（低 rank 胜出/shadowedBy/唯一不标记）、会话日志体检（帧扫描/多帧解码/空 tool-call 定位/预演/修复/备份/单帧）。全程在 `mkdtemp` 临时目录，不触碰用户数据。
- **清理**：删除 `session-repair.js` 里无人使用的 `existsSync/stat/rm` 再导出与对应 import；删除 `verify.js` 中无人调用的 `describeFindings`；删除客户端死状态 `installedGroups`；移除 `~/.dsh/market/skills/.staging-1794469168279-…` 这个 11/12 崩溃安装留下的残骸（无 SKILL.md、无 manifest，已先备份到 `.dsh-repair/staging-…-backup`）。
- 两套测试合计 **29 + 37 = 66 项全通过**。

## 0.5.63

- **修复「插件入口反复消失」的真因（右侧栏 tab 注册的 effect 泄漏）**：
  - `ctx.effect(() => { ctx.sidebarRightTabs.register(...) })` **丢掉了 `register()` 返回的 disposer**。客户端模块热重载时，上一次注册仍在注册表里，第二次 `register()` 抛
    `sidebarRight: tab type id "..." is already registered`；异常冒到 cordis，**整个插件被卸载**，表现为左侧栏「SKILL技能&MCP连接器」消失。
  - 修法：effect 回调把 disposer 原样返回（下次重载会正确注销），并把注册包进 `try/catch`——tab 注册失败只丢右侧栏 tab，**绝不连累市场面板本身**。
  - 实测证据：修复后同端口复现该 warning
    `[dsh-skill-mcp-market] 右侧栏 tab 注册失败（不影响市场面板）: sidebarRight: tab type id "dsh-skill-mcp-market" is already registered`，
    而入口 **仍在**（ref 69）、面板四个 tab 正常、详情按钮 24 个——证明异常已被隔离。
  - 说明：0.5.60 的 slot id 去重（`dsh-market` → `dsh-skill-mcp-market`）是另一件事，解决的是与第三方 `dshmarket` 的标识冲突，二者都需要。

## 0.5.62

- **已装技能按来源层级浏览**（方案 2），不再把五层目录拍平成一个列表：
  - 新增 `collectSkillRoots()`：返回 `[{ dir, rank, label }]`，rank 越小越权威
    | rank | 层 |
    |---|---|
    | 200 | 用户目录（`$AGENTS_HOME/skills`、`$DSH_HOME/skills`） |
    | 300 | 自定义安装目录（`settings.skillDirs`，与用户层同路径时不重复计） |
    | 400 | 宿主内置（`resources/runtime` 下解包的真实目录） |
    | 500 | 插件提供（profile `node_modules` 包内 SKILL.md） |
  - 新增 `collectInstalledGrouped()`：同名 slug **低 rank 胜出**，落败者标 `shadowedBy: "用户目录（rank 200）"`，并按层聚合 `groups: [{rank,label,count,shadowed}]`。
  - `skills.list` 返回体新增 `groups`；每个 `items[]` 新增 `rank` / `sourceLabel` / 可选 `shadowedBy`（旧字段全保留，无破坏）。
  - 客户端「已安装」tab：卡片标题显示被谁覆盖、元信息显示 `来源层 · rank`，被覆盖的卡片半透明；列表上方新增「来源层级」汇总条（每层数量 + 被覆盖数）。
  - 实测：对真实 4 个技能根聚合，schema 与分组结果正确（当前机器仅用户目录 1 个技能，其余目录为空）。

## 0.5.61

- **启用/禁用改为双轨**（方案 4），消除"停用了但模型仍在调用"的误导：
  - **文件级（主）**：改写技能自己 SKILL.md 的 `disable-model-invocation`，原子写回（`tmp`+`rename`），随后失效宿主 catalog，**模型真的收不到该技能**。
  - **面板级（辅）**：仍写 `settings.disabledSkills`，只对本面板隐藏，宿主注册表照旧加载——用于插件提供或符号链接接入的技能。
  - `auto` 策略：SKILL.md 可写且**未通过符号链接接入**时走文件级，否则回落面板级（写穿链接会越出技能根，明确拒绝）。
  - `skills.toggle` 扩展 `{ slug, enabled, scope: 'file'|'panel'|'auto' }`，返回体新增 `scope` / `path` / `effect`，界面按实际生效层提示。
  - 新增 `src/frontmatter.js` 的 `setFrontmatterFlag(text, key, value)`：纯函数、字节级保留其余 frontmatter、幂等、支持新增/覆盖/删除 key。
  - 新增 `src/skills.js` 的 `toggleSkillFile` / `skillFileToggleable`。
  - 未采用独立的 `provider-toggles.json`：其能力与既有 `disabledSkills` 完全重合，再加一份存储只会让"到底哪个状态生效"更难判断（YAGNI）。
  - 实测：目录型技能 disable→`disable-model-invocation: true`、enable→`false`、重复 enable 幂等、单文件技能（根下 `.md`）同样生效、无 `tmp` 残留。

## 0.5.60

- **修复侧边栏入口消失（与第三方 dshmarket 的 slot id 冲突）**：`dshmarket@1.73.19` 把 `sidebar.panellist` 注册成 `id: "dsh-market"`、`main` 注册成 `key: "dsh-market"`，与本插件 0.5.55 起用的同名 id/key **完全撞车**，两个插件抢同一格，本插件的「SKILL技能&MCP连接器」行被挤掉。
  - 全部 slot 身份改为带包名的唯一值：`sidebar.panellist` id、`main` key、右侧栏 tab 的 `id`/`kind`、`layout.selectPanel()` 参数 → `dsh-skill-mcp-market`。
  - 本插件内 `'dsh-market'` 字面量 **6 → 0**，不再与任何第三方插件共用标识。
  - 排查依据：`dshmarket/client/client.js` 中 `const SIDEBAR_PANEL_ID = "dsh-market"` 与同样的 `sidebar.panellist` 注册；同端口实测本插件的 bundle 已含新代码、入口能正常出现。

## 0.5.59

- **新增 .zip 导入**（方案 3）：
  - 新 RPC `skills.importZip { dataBase64, fileName, name?, force? }`：浏览器读 `.zip` → base64 → 服务端解码落临时文件 → 复用 `installSkill({source:"zip"})` 的**暂存+原子提交**管道（与 0.5.56 同一套零残留逻辑）。
  - 硬性上限（对齐 explorer 安全约束）：压缩包 ≤ 4MB、条目 ≤ 512、单个 SKILL.md ≤ 64KB、解压文本总量 ≤ 4MB、必须是合法 PK 头、必须有 SKILL.md；越界/不支持的条目由 `readZip` 点名跳过并在返回体里带 `skipped`。
  - 只新建不覆盖：沿用 `existingSlugs` + `uniqueSlug`，非 `force` 时同名自动加后缀。
  - 客户端「已安装」tab 上传区新增「导入 .zip」按钮；分块 base64 编码避免大文件爆栈。
  - 实测：316 字节的 zip（`zip-skill/SKILL.md` + `zip-skill/extra.md`）→ 安装成功、落盘 `SKILL.md`/`extra.md`/`.market-install.json`、**零暂存残留**。

## 0.5.58

- **补齐回收站管理面**（方案 5 第 4 部分）：删除本来就是 `rename` 进 `.trash`，但一直没有恢复入口。现在：
  - `uninstallSkill` 删除时写一条 `<条目>.trash-entry.json` 边车，记录 `slug / originalPath / originalDir / kind / deletedAt`，恢复时回到**原位置**。
  - 新增 `listTrash({trashDir, dirs})`：同时扫 `settings/trash` 与各技能根的 `.trash`，解析 `<slug>-<ISO时间戳>[.md]`，边车缺失时按文件名还原 slug（兼容历史条目）。
  - 新增 `restoreFromTrash({path, dirs})`：优先边车记录的原始路径，缺失则回落到第一个技能根；同名冲突自动加 `-2/-3` 后缀；`EXDEV` 降级 `copy+rm`；恢复后删边车。
  - 新增 `emptyTrash({trashDir, dirs})`：永久清空，RPC 层要求 `confirm:true` 二次确认。
  - 新增 RPC：`skills.trash` / `skills.restore` / `skills.trashEmpty`。
  - 客户端「已安装」tab 底部新增「回收站」区块：列出条目（slug / 类型 / 时间戳）、逐个「恢复」、整站「清空回收站」。
  - 实测：边车恢复→原路径、无边车恢复→`legacy.md`（保留 .md）、同名冲突→`demo-2`、`emptyTrash` 清空归零；21 条历史回收站条目全部可正常列出。

## 0.5.57

- **新增「会话日志体检」**（路径 tab）：检测并一键修复 `session.v4.jsonl.zstd` 的「空 tool-call」永久损坏。
  - 新增 `src/session-repair.js`：自解析 DSH 的**串联 Zstandard 帧容器**（Node 的 `zstdDecompress` 只解第一帧，必须逐帧解），逐帧解码成 JSONL 事件。
  - 损坏判定只认已确认的那一类：`assistant/message` 里 `type:"tool-call"` 的 `id` 或 `name` 为空，或 `tool/call` 的 `callId`/`name` 为空，或某行不是合法 JSON。**不猜其它类别**，合法日志绝不会被误裁。
  - 修复 = 保留损坏点之前的全部事件，重新压成一帧后**原子写回**（`tmp` + `rename`），原文件自动备份为 `<file>.repair-<时间戳>`。
  - 新增 RPC：`sessions.scan`（`{deep, limit}`，浅扫列大小、深扫逐帧检测）、`sessions.repair`（`{file, dryRun}`）。
  - 实测：对三份真实损坏日志（seq 2502 / 2807 / 2984）全部精准定位；修复后 seq 2983 `step/start` 收尾、单帧、2985 条事件、零解码错误；12 个正常会话零误报。

## 0.5.56

- **安装改为「暂存 + 原子提交」**：先在 `<root>/.staging-<slug>-<ts>` 写全部文件与 `.market-install.json`，核对无误后 `rename` 到正式目录（同卷原子）；任何一步失败只清暂存，**正式目录零残留**。跨卷 `EXDEV` 降级 `copy + rm`，失败同样只清暂存。
- **安全扫描改为报告制（不拒装）**：`scanSkillBundle` 仍执行，高危命中不再抛错，改为随安装结果返回 `findings` 与 `scanStats`，由界面提示用户自行确认。
- 移除 `lobehub` / `modelscope` 分支里重复的预扫描拒绝逻辑（统一由 `writeSkill` 报告）。
- `uploadSkillFromFolder` 的 `copyOne` 同步改为暂存 + 原子提交 + 报告制。
- 新增同名保护：非 `force` 安装时若正式目录已存在，明确报错而不是静默覆盖。
- 清理未使用的 `describeFindings` 导入。

## 0.5.54

- **移除「预览」功能**：详情按钮已覆盖"看介绍"需求（内置浏览器 tab 打开来源站完整详情页，比 tarball 下载快且信息更全），预览按钮与预览弹层（`skills.preview` 客户端调用路径、`preview`/`previewModal` state、卡片「预览」按钮、预览模态）全部移除。
- `index.js` 的 `skills.preview` RPC 保留（服务端能力，不影响客户端；其他客户端/自动化仍可调）。
- `client.js` 卡片操作行现为：「详情」+「安装 / ✓ 已安装 / 仅可浏览」。

## 0.5.33

- **修复 trusttools CLI 命令名**：`trusttools` CLI 的安装命令是 `add` 而非 `install`（`trusttools add <source> -g`），0.5.30 的 `installViaTrustToolsCli` 使用了不存在的 `trusttools install` 子命令，会导致 CLI 安装路径永远失败并回退 GitHub。修正为 `npx -y trusttools add <reference> -g`。
- **修复 skillhub 安装 reference 映射**：`client.js` `doInstallSkill` 中 skillhub 条目的 `reference` 之前走 `item.upstreamUrl || item.id` 默认分支，当 `upstream_url` 为空时 `item.id`（`skillhub:facebook/react/test`）带前缀传给 `npx skillhub install` 会失败。修正为 `item.reference || item.upstreamUrl || item.id`，优先使用 `skillhub.js` 新增的 `reference` 字段（canonicalName，无 `skillhub:` 前缀）。
- **`installViaSkillHubCli` 防御性 strip 前缀**：即使传入带 `skillhub:` 前缀的 skill-id，也会自动 strip，确保 CLI 调用成功。

## 0.5.32

- **skillhub 安装改用官方 `skillhub` CLI**（用户 m14629 确认 skillhub CLI 无需注册登录即可搜索和安装）：
  - `src/cli-install.js` 新增 `installViaSkillHubCli`：`npx -y skillhub install <skill-id> --target-dir <targetRoot>`，自动下载 CLI（无需预装、无需认证）；安装到 `<targetRoot>/<skill-name>/`；timeout 180s；失败时回退 GitHub。
  - `src/skillhub.js` 条目 `installable` 不再依赖 `upstream_url`，改为 `Boolean(canonical || raw.slug)`；新增 `reference: canonical || raw.slug` 字段供 CLI 安装使用。
  - `src/skills.js` skillhub 分支由 GitHub 直下改为调用 `installViaSkillHubCli`，CLI 失败仍回退 GitHub（`upstream_url` 存在时）。
  - 官方 CLI 接受 `owner/slug` 格式的 skill-id（如 `facebook/react/test`），与 SkillHub API 的 `namespace.canonicalName` 直接匹配。

## 0.5.31

- **clawhub 安装改用官方 `clawhub` CLI**（用户 m14469 反馈「clawhub 有官方 CLI，为什么选择 HTTP API 下载 ZIP？」）：
  - `src/cli-install.js` 新增 `installViaClawHubCli`：`npx -y clawhub install <owner/slug> --dir <targetRoot> --no-input`，自动下载 CLI（无需预装），安装到 `<targetRoot>/@<owner>/<slug>/`；timeout 180s；失败时回退 GitHub。
  - `src/skills.js` clawhub 分支由 `installViaClawHubApi`（HTTP API 下载 ZIP）改为 `installViaClawHubCli`（官方 CLI）。
  - 官方 CLI 支持 `owner/slug` 格式输入，与 dsh-market clawhub 条目的 `reference` 字段直接匹配。

## 0.5.30

- **browse.sh 安装路径修复**（用户反馈 browse.sh 条目显示「无可用下载地址」，但实际可通过官方 `browse` CLI 安装）：
  - `src/sources.js` `searchBrowseSh` 条目 `installable` 由 `false` 改为 `true`，新增 `reference: raw.slug` 字段；`note` 改为「通过官方 browse CLI 安装（npx browse skills add）」。
  - `client.js` `doInstallSkill` 对 `browse.sh` 源使用 `item.reference`（原始 slug）作为安装引用；非可安装条目 status 显示改为 `item.note`（有 note 时）或「该条目没有可用的下载源」。
  - `src/skills.js` browse.sh 安装分支：CLI 失败时不再回退 GitHub（GitHub 上 browse.sh 技能仓库 404），改为抛出带指引的错误（提示安装 Node.js 22.18+ 并运行 `npm i -g browse`）。
  - `src/cli-install.js` `installViaBrowseShCli`：`npx -y browse` 自动下载 CLI（无需预装），timeout 延长到 180s；搜索目录扩展到所有 agent skills 目录 + `.browse/skills`；支持 slug 含 `/`（取 basename 匹配）；错误信息带 `npx browse skills add <slug>` 手动指引。
  - `client.js` `installable === false` 时 meta 行显示「· 仅可浏览」替代「· 无可用下载地址」。

## 0.5.29

- **lawhub.ai 不显示「详情」按钮**（用户 m10721 指令：skills.sh、lawhub.ai、browse.sh 不设详情功能）：
  - `client.js` `detailUrlFor` 新增 lawhub.ai 识别：`item.source === 'lawhub'` 或 homepage 匹配 `/lawhub\.ai$/i` 时返回空字符串，卡片上不渲染「详情」按钮。
  - 0.5.28 已处理 skills.sh / clawhub / browse.sh，本次补齐 lawhub.ai。

## 0.5.28

- **卸载回退到 `$AGENTS_HOME/skills/<slug>`**（用户 m11258 反馈「装在 SKILLS_HOME 下的技能无法卸载」）：
  - `src/skills.js` `uninstallSkill` 新增 `agentsHomeSkillsDir` 参数，在 skillDirs 找不到时回退到 `$AGENTS_HOME/skills/` 删除。
  - `index.js` 两处调用（`skill_market_uninstall` 工具 + `skills.uninstall` RPC）传入 `join(agentsHome(), "skills")`。
- **skills.sh / clawhub / browse.sh / lawhub.ai 不显示「详情」按钮**（用户 m11258 要求这四个源不设详情功能）：
  - `client.js` `detailUrlFor` 对 `skills.sh`、`clawhub`、`browse.sh` 源直接返回空字符串，卡片上不渲染「详情」按钮；`lawhub.ai` 通过 source 或 homepage 域名识别，同样不渲染；其他源保留。

## 0.5.27

- **修复「已安装」tab 卡片网格右侧空白**（用户 m10903 反馈「页面右边仍然是大片空白，卡片区中一行并未填满」）：
  - `client.js:92` `S.grid` 由 `repeat(auto-fill, minmax(240px, 1fr))` 改为 `repeat(3, 1fr)` 固定 3 列，填满面板宽度。
  - `client.js:1253` 已安装 tab 包裹 div 加 `flex: 1, width: '100%', alignItems: 'stretch'`；`client.js:90` `S.body` 加 `alignItems: 'stretch'`。
- **修复拖拽上传技能失败**（用户 m11116 反馈拖拽 agnes 文件夹报「A requested file or directory could not be found」）：
  - `client.js` 拖拽处理改用 `DataTransferItem.webkitGetAsEntry()` 递归读取 `FileEntry` 树，拿到真实目录层级；读不到时回退 `dataTransfer.files`。
  - 根目录前缀推断改为「所有文件 path 的公共第一段」，比原来只取 `dropped[0].name` 更可靠。

## 0.5.26

- **详情面板：被拒嵌入站点不再显示破图**（用户 m10464 反馈 skills.sh 详情 iframe 渲染为「禁止嵌入」破图无退路）：
  - `client.js` 详情浮层 iframe 路径新增**常显 URL 工具栏**（`makeUrlStrip`）：URL 单行省略 +「复制 URL」按钮（clipboard.writeText，成功改「已复制 ✓」）+「在浏览器中打开」按钮（window.open noopener）；CSP 黑名单分支（`makeDetailPanel`）同样保留。
  - `index.js` 新增宿主 RPC `frame.check`：`checkFrameable(url)` 对目标 URL 发 `fetch({redirect:'follow'})`，读 `X-Frame-Options` 与 CSP `frame-ancestors` 响应头，返回 `{embeddable, reason, status}`；客户端 `openDetail` 在非黑名单命中时先 `await call('frame.check',{url})`，`embeddable===false` 直接走 `makeDetailPanel` 友好提示（附 `blockReason` 文案），不再等 iframe 破图。
  - `package.json` 版本 0.5.25 → 0.5.26。
- **修复「已安装」tab 布局错乱**（用户 m10495 反馈「已装技能/已装MCP 两个标题占据右侧整列、把内容挤到左边」）：
  - `client.js:1253` 已安装 tab 包裹 div 由无样式 `h('div', null, ...)` 改为 `{ display:'flex', flexDirection:'column', gap:12 }`，拖拽区 / 已装技能标题+卡片网格 / 已装 MCP 标题+卡片网格 全部纵向全宽堆叠，不再横向并排。

## 0.5.25

- **四个源全部走 CLI 快路径（clawhub / skills.sh / browse.sh / trusttools）**：新增 `src/cli-install.js`，`src/skills.js` 各源分支先试快路径、失败 `console.log(... falling back to GitHub)` 后回退原 GitHub 逻辑。
  - `installViaClawHubApi`：直接 `https://clawhub.ai/api/v1/download?slug=<slug>` 拉 zip → 解包 → 校验 frontmatter → 落盘；不再依赖页面 HTML 抓取。
  - `installViaSkillsShCli` / `installViaBrowseShCli` / `installViaTrustToolsCli`：分别对应各源的 CLI/API 直连下载。
- **修复 clawhub 安装失败「找不到 GitHub 源仓库」**（用户 m09486 反馈）：`installViaClawHubApi` 收到的 `reference` 形如 `owner/slug`，直接拼进 `?slug=` 会 404（实测带 owner 前缀 404/15B，裸 slug 200/53KB zip）。新增 `bareSlug = slug.includes('/') ? slug.split('/').pop() : slug`，URL / 目标目录 / kebab / finalSlug 全部改用 `bareSlug`。
- **详情页改为在 DSH 客户端内打开**：`client.js` 注入 `sidebarRight`，点击「详情」→ `sidebarRight.openTab('browser')` → 插件 pane tab → inline iframe overlay；`clawhub.ai` / `browse.sh` 因 CSP `frame-ancestors` 被列入黑名单，改为直接显示详情面板 + 复制 URL。预览按钮文案由「在浏览器中查看详情」改为「在 DSH 客户端内查看详情」。
- **修复「已安装」面板位置错乱**（用户 m09737 反馈）：`grid` 增加 `alignItems: 'start'`；`title` / `meta` 改为单行省略（`overflow: hidden` + `textOverflow: ellipsis` + `whiteSpace: nowrap`，并移除 `meta` 的 `flexWrap: 'wrap'` + 加 `minWidth: 0`）。此前 `openpencil-design` 的长路径（`...\node_modules\@zseven-w\dsh-openpencil\lib\assets`）换行导致该卡片 131px、同行其他卡片 98px，网格行对齐被破坏；修复后 8 张卡片统一 98px。
- `package.json`：`dsh.client.inject` 追加 `@deepseek-ai/dsh-client-ui-sidebar-right`。

## 0.5.22

- **卡片加「详情」按钮：秒开详情页，不再干等下载**（用户 m06943 反馈）：
  - 每张技能卡片在「预览」旁新增「详情」小按钮，点击经 `window.open` 在系统浏览器打开对应详情页：
    - skills.sh → `https://www.skills.sh/<owner>/<slug>`；
    - clawhub → `https://clawhub.ai/<owner>/<slug>`；
    - 其他源 → `upstreamUrl`。
  - 详情页信息齐全（安装命令、示例、版本历史），加载 <1s，替代原来「下载整仓库 tarball + 解包 + 安全扫描」的数十秒预览等待。
- **clawhub 预览失败回退：不再死胡同**：
  - `clawhubResolve`（`src/extra-sources.js`）先走 HTML 正则提取 GitHub 源仓库（原路径），失败时回退到 `clawhub.ai/api/v1/search` 结构化 API，从结果的 `links.source` / `install.sourceUrl` / `sourceIdentity.repo` 字段定位仓库；两者皆无则抛错并附详情页 URL。
  - `index.js skills.preview`：clawhub 源的全量下载路径失败时，不再向上抛错，改为返回 `{ openUrl, previewError }` 结构体；`client.js` 预览弹层收到 `openUrl` 后显示「在浏览器中查看详情」按钮，替代原来的 `预览失败：…` 死胡同错误。
- **「已安装」面板：去掉顶部输入框+导入按钮，改为拖拽文件夹**（0.5.21 已实现，随本版合入）：
  - 虚线拖拽区（`onDragOver`/`onDrop`）+「浏览文件夹」按钮（`<input type=file webkitdirectory>`），选中含 `SKILL.md` 的文件夹后批量上传。
- **tdd 等 skills.sh 嵌套技能安装修复**（0.5.21 已实现，随本版合入）：
  - `src/github.js` 新增 `findSkillDirFor`：探测 `skills/engineering/<slug>/SKILL.md`、`skills/<slug>/SKILL.md`、`.agents/skills/<slug>/SKILL.md` 三候选路径。
  - `src/skills.js` skills.sh 分支在 `skillDir` 为空时自动探测嵌套路径，修复 `mattpocock/skills` 的 `tdd`（上游 `skills/engineering/tdd/`）安装后「未显示在已安装列表」的问题。

## 0.5.20

- **「已安装」面板补全 DSH 内置与插件携带技能**（`collectDshNativeSkillDirs` 重写）：
  - 原实现只收集 `$AGENTS_HOME/skills` + `settings.skillDirs`（market 安装目录 + .custom-skills），遗漏了两类技能：
    1. **宿主安装目录内的应用内置技能**（`resources/runtime/office-skills/`，office/office-docx/office-pptx 等 7 个）；
    2. **profile node_modules 里插件包自带的 SKILL.md**（如 `@zseven-w/dsh-openpencil` 的 openpencil-design）。
  - 新实现追加两个扫描源：
    - `process.resourcesPath`（Electron 宿主注入）→ `resources/runtime/` 下递归找含 SKILL.md 子目录的父目录；
    - `findProfileNodeModules()`（优先 `DSH_PROFILE_DIR` 环境变量，否则扫 `~/.dsh/profiles/*/node_modules`）→ 遍历顶层包（scoped `@scope/name` 展开一层）递归找技能目录。
  - `findSkillDirs` 返回"含 SKILL.md 子目录的父目录"（与 `listInstalledSkills` 的扫描语义一致——后者对每个 dir 做 readdir 找子目录里的 SKILL.md）。
  - 验证：宿主上下文 dry-run 共 13 个技能（用户 5 + 内置 7 + 插件 1），`skills.list` RPC 返回全部四类来源。

## 0.5.19

- **对话框底部按钮栏新增「技能」「MCP」两个快捷按钮**（composer 输入行左侧，`conversation.input.left` 槽位）：
  - 点「技能」弹出已安装技能列表（宿主 RPC `skills.list`）；点「MCP」弹出已安装 MCP 列表（宿主 RPC `mcp.list`）。
  - 点击条目把一段调用提示**插入输入框草稿**（不覆盖已有内容、不直接发送）：技能插 `使用技能 /slug（简介）…`，MCP 插 `使用 MCP 连接器 name（transport/挂载状态/工具前 8 个）…`。
  - 弹窗底部「去技能市场 / 去 MCP 市场」按钮经宿主 `layout.selectPanel('dsh-market')` 直接激活市场面板。
  - 交互细节：外部点击 / Escape 关闭（quick-resume popover 范式），按钮 `onMouseDown` 阻止失焦，已加载列表在会话内缓存避免重复 RPC。
  - `package.json` 的 `dsh.client` 补 `inject: ["@deepseek-ai/dsh-client-ui-conversation"]`，宿主先载入 conversation 包（提供 `inputActions` / `useInput`）再加载本插件浏览器半边。
- **预览提速：github / skills.sh（裸 owner/repo 与页面 URL）走单文件快路径**（`skills.preview`）
  - 原路径：整个技能目录 `listTree` + 逐文件下载 + 读回再删临时目录（本机直连 GitHub 不稳时极慢，用户反馈「预览和安装的速度都很慢，耗时很长」）。
  - 快路径：只拉 `SKILL.md` 一个文件（raw → jsDelivr 兜底），用 `skillMetaFromText` 解析 frontmatter 即返回；单文件取失败（404/网络）才回退整目录路径。
  - skills.sh 裸 `owner/repo` 直接走 github 快路径；页面 URL 用 `lookupSkillShRepo` 本地正则解析出 repo+skill 后同样只拉单文件，免掉原来「抓整页 → 正则解析 npx 命令」的 25 秒网络跳（`src/sources.js` 新增 `lookupSkillShRepo` 导出）。
  - 安装（`skills.install`）保持全目录下载不变（预览只是看简介，快路径不能替代安装）；skills.sh 安装路径改走带缓存的 `resolveSkillsShInstall(url, cache)`（`src/skills.js` 签名加 `cache` 参数，`index.js` 三处调用点传 `marketCache`），首次抓页后 24h 内重复安装/预览免再抓。

## 0.5.18

- 修「上传技能」对带 Python 虚拟环境 / 构建产物的技能目录误拒：前端 `<input type=file webkitdirectory>` 读出文件后、宿主 `uploadSkillFromFolder` 读盘时，都自动跳过 `.git`、`.venv`、`venv`、`node_modules`、`dist`、`build`、`__pycache__`、`.idea`、`.vscode`、`.pytest_cache`、`.mypy_cache`、`.ruff_cache`、`.next`、`.nuxt`、`.svelte-kit` 等无关目录。
- 修 SKILL.md 用 YAML 块级描述（`description: >` 折行 / `description: |` 保留）时 frontmatter 解析器只读到单个 `>` / `|` 字符、导致 description 为空被拒的问题：`src/frontmatter.js` 现在识别块标量，把缩进行累积成完整描述文本。

## 0.5.17

- 新增「上传技能」按钮（已安装页导入行旁）：点击弹系统文件夹选择器（`<input type=file webkitdirectory>`），选中含 `SKILL.md` 的文件夹后整目录批量上传，子目录里每个含 `SKILL.md` 的逐个安装，全部走 `scanSkillBundle` 安全扫描。
- `src/skills.js` 新增 `uploadSkillFromFolder({ folder, skillDirs, force })`：根目录含 `SKILL.md` 整目录拷入；否则扫一级子目录逐个装；都没有则报「请选一个符合 SKILL 技能格式的文件夹」。复用 `installSkill` 的 `writeSkill` 规则（frontmatter 校验、`.market-install.json` 元数据、`uniqueSlug` 去重）。
- `index.js` 新增 `skills.upload` RPC：支持 `body.path`（宿主本地目录）或 `body.files`（前端读出的文件数组，宿主解包到临时目录再上传）；成功后对每个新装技能 `registerInstalledSkillToCatalog` 注册到 DSH `/` 浮窗。
- `client.js`：导入行「导入」按钮旁加「上传技能」按钮，`busy==='upload'` 时禁用，成功后 notice 显示上传的 slug 列表并刷新已安装。

## 0.5.16

- 「已安装」页改为**卡片网格布局**（与技能市场 / MCP 市场同款 grid，一行多张卡片自适应换列），已装技能与已装 MCP 两段都换；卡片加了 220px 最小宽度避免窄格挤压。

## 0.5.15

- 面板「加载更多」按钮升级为**分页导航**：上一页/下一页 + 页码（中间省略号折叠，点「…」向后跳 5 页）+ 每页条数选择器（12/24/48），SKILL 与 MCP 两个页签统一；总页数未知时（官方注册表按 cursor 翻页）退化为「上一页 / 第 n 页 / 下一页」。
- `index.js` 的 `mcp.search` 透传 `size`，注册表页大小随选择生效。

## 0.5.14

### skills.sh 的卡片终于有真正的简介了

- 之前 skills.sh 的卡片要么只有「mattpocock/skills 收录于 skills.sh 的技能」这种通用文案，要么把
  SKILL.md 里的残留符号（实测出现过 `>`）当成简介。现在直接读 skills.sh 详情页的 meta 描述——
  一次请求一条、最准；只有连 meta 都没有时才回落到仓库里的 SKILL.md 头。
- 补描述增加总时间预算（9 秒）：超时就先把卡片发出去，描述退回通用文案，面板不会为了几十条描述
  一直转圈。实测暖缓存翻页 3.8 秒、24/24 有真实简介。
- 描述质量加了校验：不足 12 字、纯标点符号（`>`、`#`）一律丢弃，不再冒充简介。

## 0.5.13

### 修掉 `skill_market_search` 工具直接报错（面板没暴露的真实缺陷）

- **`fallbackCache is not defined`**：0.5.10 重写分页时删掉了 `src/sources.js` 里的进程级兜底缓存，
  但 `searchSkills()` / `warmMarketCache()` 的默认参数还在引用它。面板走的是宿主传入的缓存，所以看不出来；
  只有不带 `cache` 调用时才炸——也就是 agent 直接用 `skill_market_search` 工具的路径。
- **skills.sh 浏览不再只看到 48 条**：`browseSkillsSh` 之前只会「读」缓存里的全量目录，从不自己「抓」；
  没预热过缓存（工具路径、刚重启）时永远只显示首页推荐。现在最多等 12 秒抓 sitemap 目录（约 2 万条），
  超时才回退首页推荐并给提示，同时把抓取留在后台继续，下次打开就是全量。
- 新增 `test/test-nocache.mjs`：不带 cache 参数逐一验证 8 个源 page1/page2 都有数据且零重叠，
  再验证 `all` 聚合与 `warmMarketCache()`——这类「默认参数引用了已删除变量」的缺陷以后会被测试挡住。

## 0.5.12

### 面板侧补齐注册表分页（0.5.11 只修了宿主侧）

- **官方注册表下「加载更多」点了没反应**：宿主已经能翻页，但 RPC `mcp.search` 仍返回 `totalPages: 1`
  且不带 `canLoadMore`，面板据此判定「没有下一页」把按钮置灰。现在 RPC 同样返回 `canLoadMore`；
  注册表没有总页数时 `totalPages` 为 `0`，不再假装是 `1`。
- 注册表状态行不再把「本页 24 条」写成「24 个结果」，改为 `已显示 24 个（可继续加载）`。
- 追加分页时按 id 去重：注册表按版本行翻页，同一 slug 可能跨页出现，去重后列表才不会重复。

## 0.5.11

### MCP 官方注册表也能「加载更多」+ 修掉测试暴露的三个缺陷

- **官方注册表分页**：注册表是 cursor 分页，而且按「版本行」翻页（同一个 server 的多个版本会占多行，
  一页 10 行去重后可能只剩 5 个），所以现在先累积去重目录再切片：前三页各 24 条、零重叠。
  顺手修掉一个静默 bug：分页缓存只存了 items 没存 cursor，导致**第二页永远回到第一页**。
- 面板 MCP 页两个市场（官方注册表 / LobeHub）都显示「加载更多」；注册表没有总页数，按钮显示
  `加载更多（第 n 页）`，到底显示「已到最后一页」。
- **LobeHub 安装失败修复**：卡片 id 带 `lobehub:` 前缀，取清单时没剥掉 → 404 被当成「没有声明启动方式」。
  现在剥掉前缀，并按 `deploymentOptions[].isRecommended` 选推荐配方；清单里 `configSchema` 声明为必填的
  变量写成 `${VAR}` 占位（值留在用户环境变量里）。
- **`uninstallSkill` 的 `trashDir` 之前被忽略**，回收站一直写在技能目录下；现在传了就写到传入位置，
  跨盘仍走 copy+delete 兜底。
- 新增 `test/test-features.mjs`（29 项）：注册表浏览/翻页/缓存命中后翻页/关键词/定义解析/配置映射、
  LobeHub 浏览/翻页/排序/分类/搜索/清单解析、MCP 纯函数、安装前安全扫描、技能安装/编辑/卸载。

## 0.5.10

### 「加载更多」对每个源都真的能翻到新条目（0.5.9 的妥协做法已废弃）
0.5.9 把不可翻页的源「置灰」并标注「（当前源已取完）」，那不是上游的限制，是我实现偷懒：
skills.sh 只抓了首页那 48 条精选，其余源也只取了第一屏。参照 `hermes-business-agent` 里的
`unified_skills_client.py`（服务端 page + 全量目录本地切片），现在每个源都能真正翻页：

| 源 | 翻页方式 | 规模 |
|---|---|---|
| `skills.sh` | sitemap 全量目录 `sitemap-skills-1/-2.xml` → 缓存 24h → 本地切片 | ~20 000 |
| `clawhub` | 顺 `nextCursor` 累积本地目录（每屏 50 条） → 本地切片 | 持续增长 |
| `browse.sh` | 一次取整份目录（约 480 条）→ 本地切片 | ~480 |
| `lobehub-agent` | `index.json` 全量（约 505 个 agent）→ 本地切片 | ~505 |
| `skillsmp` | 服务端 `?page=&limit=` | ~1 200 |
| `trusttools` | 服务端 `page`（实际 10 条/页，按批拼接） | 579 074 |
| `skillhub` | 服务端 `page` | 226 000+ |
| `modelscope` | 服务端 `PUT PageNumber/PageSize`（新增源） | 88 862 |

- 客户端改为**请求下一页并追加去重**，不再「把 pageSize 加大重查」；按钮显示 `加载更多（n/m）`，
  到底显示 `已到最后一页（n/m）`（SKILL 与 MCP 一致）。
- 聚合源（`all`）也按页返回：8 个源各出 12 条，翻页后整页无重复。
- `skills.sh` 列表接口本身没有简介字段：读不到 SKILL.md 时给一句诚实兜底，卡片不再空白。
- 新增 `test/test-paging.mjs`：逐源断言「第 2 页与第 1 页零重叠、hasMore/total 合理」，并覆盖
  聚合源与关键词搜索的翻页。

## 0.5.9

### 「加载更多」对各源真实可用 + 修复切换源反复重查/不可达误报
- **加载更多**：此前点「加载更多」只是把 `size` 加 24 再查一次同一查询——
  多数技能源（skills.sh / clawhub / skillsmp / trusttools / lobehub-agent）的上游是**单页/无分页**，
  重新查只会拿到同一批，所以按钮「点了没反应」甚至把整页换掉。现在：
  - 后端按源判定 `canLoadMore`（只有 `skillhub` 支持真实翻页；MCP 的 LobeHub 本就带 `page`），
    非可翻页的源「加载更多」置灰并标注「（当前源已取完）」，避免误点；
  - skillhub「加载更多」真正传 `page`，取到新一批；
  - clawhub 浏览改用 `?limit=`（实测 limit=50 有效），搜索拼接两页，加载更多能取到更多；
  - skills.sh 浏览/搜索的描述补齐加**负缓存**（404/403/451 才记），把 80s 级等待降到 ~10s。
- **切源不再白屏重查**（0.5.8 已做的 stale-while-revalidate 结果缓存）保留；本次修复
  clawhub「不可达：fetch failed」的间歇误报：clawhub 浏览/搜索现在对网络错误做 1 次重试，
  且把「不可达」与「无结果」分开提示。
- 其余源行为经测试集核实：skillsmp/lobehub-agent/trusttools/skillhub 浏览与搜索均正常返回、
  描述完整；MCP registry/lobehub 搜索、分页、分类、排序正常。

## 0.5.8

### skills.sh 描述补齐 + 切源走缓存（不再白屏重查）
- **skills.sh 描述**：上游目录/搜索 API 不携带描述字段（只返回 `id/source/skillId/name/installs`），
  之前只有「搜索」路径会尽力从 GitHub `SKILL.md` frontmatter 补描述（前 10 条、0.3–2s/条、超时留空），
  「浏览」（空搜索框的首页推荐）完全不补 → 整页都是 `skills.sh · owner/skills`。现在浏览路径也补前 10 条描述。
- **切源/改查询走 stale-while-revalidate**：客户端加了一个按 `(tab, source, category, sort, query, page)` 的结果缓存。
  切源或改查询时若命中就**立即渲染旧结果**（提示「缓存，正在刷新…」），后台再刷新；不再每次切源都清空重查、白屏等待。
- 插件代码无其他变化。

## 0.5.7

### 已安装标签：「详情/编辑」改为「打开文件夹」
- 技能卡片和 MCP 卡片的「详情/编辑」按钮改成了「**打开文件夹**」：点了直接在资源管理器里定位到该技能 / MCP 定义所在目录，
  可查看 / 编辑内容（保存即生效，无需重启 DSH）。
- 之前的「详情/编辑」抽屉（全屏模态）被移除，编辑需求通过资源管理器直接改文件实现。
- `market.openDir` RPC 扩展：支持 `{ kind: "skill", slug }` 和 `{ kind: "mcp-item", serverName }` 两种用法，
  Windows 上用 `explorer.exe /select,` 定位到具体文件。
- 插件代码无其他变化。

## 0.5.6

### 已安装标签：搜索 + DSH 内置技能
- 「已安装」标签顶部加一个**搜索框**，可按关键词过滤已安装的技能 / MCP（名称、描述）；清空后恢复完整列表。
- 「已安装」标签现在同时列出 **DSH 内置技能**（`$AGENTS_HOME/skills/`）+ market 安装的技能（`settings.skillDirs`）；
  MCP 仍只列出 market 安装的。区块标题旁会显示「含 DSH 内置 N 个目录」。
- `skills.list` RPC 改用 `collectDshNativeSkillDirs()` 合并两套目录；`market_get_settings` 也返回
  `dshNativeSkillDirs` 供客户端展示。
- 插件代码无其他变化。

## 0.5.5

### 安装技能后立即出现在对话框 / 浮窗里
- 之前：`skill_market_install` 把技能装到 `settings.skillDirs[0]`，DSH 的"技能目录"扫描不会把这份技能列进
  对话框输入 `/` 时弹出的浮窗里（要重启 DSH 才可见）。
- 现在：安装成功后，插件往 DSH 原生扫描路径 `$AGENTS_HOME/skills/` 写一份 junction（Windows）/ symlink（其它平台），
  指向技能实际安装位置；DSH 会把它列进"技能目录"，`/` 浮窗随之更新，**无需重启**。
- 卸载不自动清理这份 junction（避免误删用户手工放置的），需要时手工 `rmdir "$AGENTS_HOME\skills\<slug>"`。
- 插件代码无其他变化。

## 0.5.4

### 交互：「详情/编辑」改为全屏模态
- 不再在列表上方插入详情面板，改为**半透明遮罩 + 居中 560px 卡片**的模态（参考 Hermes 的"返回 + 详情"全屏页风格）；
- 关闭：点右下角「关闭」按钮（遮罩外区域不拦截，避免误关）；
- 技能：「描述 / 正文」两个输入区；MCP：「命令 / URL / 参数」三个输入区 + 只读的 transport/env/headers JSON；
- 右下角操作按钮：「保存」/「保存并重连」（与之前一致），「关闭」在左侧。
- 插件代码无其他变化。

## 0.5.3

### 修复：trusttools 技能市场每页只 10 条、"加载更多" 位置不合理、缺少"打开安装目录"按钮
- **trusttools 现在能展示更多技能**：该 API 固定返回 10 行/页（`pageSize` 参数被忽略），`searchTrustTools` 现在
  会最多拉 6 页、去重后截断到面板需要的条数（面板默认 24 行 → 拉 3 页）。每页 10 分钟缓存，搜索词命中后直接走缓存，
  避免每次翻页都打 6 次上游。
- **「加载更多」按钮位置**：从工具条移到**列表最后一行的正下方居中**；MCP（LobeHub）会显示 `加载更多（n/m）`，
  最后一行变成 `已到最后一页（n/m）`；SKILL 市场按钮文案保持 `加载更多`。不再需要滚回顶部点按钮。
- **「已安装」标签的两个区块（已装技能 / 已装 MCP）标题旁各加一个「打开目录」按钮**：
  - 技能目录：`settings.skillDirs[0]`（安装目标）；
  - MCP 目录：`settings.mcpDirs[0]`（`.json` 定义存放处）；
  - 点了在资源管理器中打开，直接查看 / 编辑文件（保存即生效，无需重启 DSH）。
  - 两个目录都还没配置时会提示"还没有配置 … 目录"。
- 插件代码无其他变化。

## 0.5.3

### 修复：trusttools 技能市场每页只 10 条、"加载更多" 位置不合理、缺少"打开安装目录"按钮
- **trusttools 现在能展示更多技能**：该 API 固定返回 10 行/页（`pageSize` 参数被忽略），`searchTrustTools` 现在
  会最多拉 6 页、去重后截断到面板需要的条数（面板默认 24 行 → 拉 3 页）。每页 10 分钟缓存，搜索词命中后直接走缓存，
  避免每次翻页都打 6 次上游。
- **「加载更多」按钮位置**：从工具条移到**列表最后一行的正下方居中**；MCP（LobeHub）会显示 `加载更多（n/m）`，
  最后一行变成 `已到最后一页（n/m）`；SKILL 市场按钮文案保持 `加载更多`。不再需要滚回顶部点按钮。
- **「已安装」标签的两个区块（已装技能 / 已装 MCP）标题旁各加一个「打开目录」按钮**：
  - 技能目录：`settings.skillDirs[0]`（安装目标）；
  - MCP 目录：`settings.mcpDirs[0]`（`.json` 定义存放处）；
  - 点了在资源管理器中打开，直接查看 / 编辑文件（保存即生效，无需重启 DSH）。
  - 两个目录都还没配置时会提示"还没有配置 … 目录"。
- 插件代码无其他变化。

## 0.5.2

### 文档：安装/升级卡住、`ERR_PNPM_EPERM` 的原因与修法
- 说明根因：pnpm 用「重命名临时目录覆盖目标目录」的方式落地包，Windows 下覆盖前要删旧目录，而 DSH 正加载着这个插件
  → `EPERM`，表现为安装卡在 `added 0` 或直接失败。
- 给出实测有效的修法：先 `rmdir /s /q` 删掉
  `~/.dsh/profiles/desktop/node_modules/dsh-skill-mcp-market`，再 `dsh plugin --profile desktop add …`（实测 3.7 秒完成）；
  或先退出 DSH 再装；或使用应用内「插件」页的更新按钮。
- 警示：不要用 Git-Bash/MSYS 的 `rm` 删 `link:` 形式的 `node_modules` 条目——它会跟随符号链接删掉源码仓库
  （开发期间因此损坏过一次本地 `.git` 元数据，已从存活对象重建，远端历史未受影响）。
- 插件代码无变化。

## 0.5.1

### 修复：插件无法卸载（“其他配置仍在使用的组合包的组件，请先停用它们”）
- 根因不在插件本身，而是**同一个插件被挂载了两次**：包名在 `dsh.profile.bundles` 里，同时又有一份手写在
  profile `cordis.patch.yml` 的 `insert`。插件管理器卸载时会先停用组合包，随后仍发现同 `id` + 同 `name` 的插件行在运行，
  于是以 `bundle-in-use` 拒绝卸载。
- 插件启动时新增**重复挂载检测**：命中时在日志里告警，并直接给出修法（删掉 profile 里手写的 `insert`，只保留 `bundles` 里的包名）。
- README 补充说明：`bundles` 与手写 `insert` **只能二选一**；「卸载」小节新增这个报错的处理步骤。
- `market_get_settings` 的 MCP 来源说明更新为两个市场（官方注册表 / LobeHub）。

## 0.5.0

### 新增：MCP 市场的分类 / 排序 / 分页
- **分类**：LobeHub 页签按上游返回的分类码生成 chips（70 个，取前 12 个 + 「全部分类」），常见分类显示中文名
  （开发者 / 数据分析 / 媒体生成 / 效率办公 / 金融 …），点一下即按该分类重新检索。
- **排序**：LobeHub 支持「默认顺序 / 安装最多 / 评分最高」，官方注册表支持「默认顺序 / 按名称」。
- **分页**：LobeHub 每页 40 条，「加载更多（第 n/m 页）」按页追加；状态行显示「共 X 个连接器 · 第 n/m 页」。
  `mcp_market_search` 也同步支持 `category` / `sort` / `page` 参数并回传分页信息。
- **稳定性**：LobeHub 市场偶发 `fetch failed`（本机网络抖动），CLI 调用加了 3 次重试（仅对链路类错误重试）。

## 0.4.0

### 新增：两个 MCP 市场（不合并，各占一个来源）
- 面板 MCP 页签新增来源切换：**「MCP 官方注册表」/「LobeHub」**，与技能页签的 chips 一致，一次只看一个市场。
- LobeHub 市场走它自己的官方接口 `@lobehub/market-cli`（首次使用自动注册市场客户端，凭证由 CLI 写到
  `~/.lobehub-market/credentials.json`）；搜索支持关键词、分类、`--sort`，卡片显示作者、分类、安装次数。
- LobeHub 条目的安装走公开 manifest：`/api/v1/plugins/<identifier>/manifest` 给出真实 `command`/`args`
  或远程 `url` 以及需要的环境变量，装完照旧探活。
- `mcp_market_search` 新增 `source: "registry" | "lobehub"` 参数。

### 修正
- 之前「LobeHub 目录已改付费接口（HTTP 402）/不可用」的结论是错的：那是**匿名**请求的 401，注册市场客户端后即可搜索；
  相关错误文案与 README 已更正。
- LobeHub 搜索分页上限是 40（更大的 `--page-size` 会被拒），且 `--sort` 只能和关键词一起用，代码里都已处理。

## 0.3.2

### 修复
- **skills.sh 空搜索不再空白**：该上游没有列表接口，改为抓取首页推荐的技能卡片（缓存 30 分钟），
  面板同时提示「未输入关键词，显示首页推荐；输入 ≥2 个字符可精确搜索」。
- **trusttools 恢复可用**：`ai.trusttools.cn` 会丢弃本进程的 TLS 握手（与 skillsmp 同类），
  POST 改走 python → curl → fetch 三级通道（`postJsonEscalating`）。
- 面板空状态优先显示各来源自己的 `hint`，不再一律显示「上游不可达」。

## 0.3.1

### 文档与元数据
- 仓库转为 public；README 补齐安装 / 升级 / 卸载与数据源说明
- `docs/ARCHITECTURE.md` 重写为对外版本（去掉内部参考实现对照与本机路径）
- package.json 描述改为中英双语，并补充 keywords
- 清理代码注释里的第三方项目名

行为无变化。

## 0.3.0（进行中）

### 变更
- **移除内置精选库**：删除 `catalog/`（17 条精选技能 + 8 条精选 MCP），只保留实时在线源。
- **技能源改为实时**：`skills.sh`（sitemap 2 万条）+ `SkillHub`（社区 API）。
- **MCP 源改为实时，主源换成官方注册表**：`registry.modelcontextprotocol.io`
  （免费、无需鉴权、自带真实启动方式：npm 包 + stdio，或 streamable-http 端点）。
  LobeHub 降为第二源——它的边缘会间歇返回 `402 payment_required`，不能再作为唯一目录。
  目录失效时按「上次成功缓存 → 内置常见条目」降级，并明确告知原因；安装本身不依赖目录，
  只要给出名称即可解析。
- **新增 skillsmp 源**：`skillsmp.com/api/skills`。该站由 Cloudflare 托管，实测 Node
  `fetch`/`https` 与 Windows `curl` 全部 403「Just a moment…」，只有 CPython 的 TLS 栈能拿到
  200，因此新增 python → curl → fetch 的三级取数通道；条目的 GitHub 位置直接用于安装。
- **GitHub 取数增强**：`github.com`/`raw.githubusercontent.com` 在部分网络只能走系统代理，
  Node `fetch` 不读系统代理，故下载改为 fetch → python → curl 递进；jsDelivr 的文件列表
  看不到 `.agents/` 这类目录，补充 GitHub contents API 与仓库归档（tarball）兜底。
- **新增技能启停配置项** `disabledSkills`：等价于常见的 `config skills.disabled: [...]` 写法，
  由自建 skill provider 读取并过滤，改完立即失效目录缓存。
- **新增 `${ENV_VAR}` + 系统环境变量**：面板填写的 Key 写入 Windows 用户环境变量，
  配置里只保留占位符。
- **新增面板**：`shell.overlay` 注入，四个标签（技能 / MCP / 已安装 / 路径）。
- 修复：自建 provider 未返回 `provider` 字段导致技能目录校验失败。
- 修复：`skill_market_install` 传裸 `owner/repo` 给 `skills.sh` 源时报
  `Failed to parse URL`；现在裸仓库名与页面 URL 都接受。
- 修复：`installSkill` 的 `ref` 参数未被解构，trusttools 源安装时抛 `ref is not defined`。
- 修复：目录为空时只显示空白；现在区分「没有匹配」与「目录不可达」并给出可操作提示。

### 已知问题
- skills.sh 的安装路径靠 `/<owner>/<repo>/<skill>` 推断，非标准布局会装不上。
- 安装前没有隔离区安全扫描。
- modelscope（`api/v1/dolphin/skills` 已 404）仍未接。
- 官方注册表按 token 精确匹配，多词查询由本插件拆词后合并排序。
- 存放于点目录（`.agents/skills/...`）的技能只能走仓库归档安装，单个技能可能要下载
  整个仓库（数十 MB）。

## 0.2.0

- 首个可用版本：12 个 host 工具 + 面板 + 动态挂载官方 MCP 客户端实现零重启生效。

## 0.1.0

- 骨架。
