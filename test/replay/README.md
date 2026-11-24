# 门提速层（方案 B / C / D）

> 用户 2026-11-24 21:45 定的口径：**B 主刀**（650s→100~150s）、**C 并行**（前提是 B 完成）、
> **D 必须保留 live 冒烟层**。这一页只讲怎么用、以及它的诚实边界。

## 是什么

`test/run-gate.mjs` 在 `DSH_REPLAY` 开启时，给每个套件子进程注入
`--import=<file:///…/test/replay/preload.mjs>`。预加载装两个东西：

1. **模块钩子**（`hooks.mjs`）——把 `src/http.js` 与网络型 `node:child_process` 调用
   整体换成替身（`http-replay.mjs` / `cp-replay.mjs`）。取证证明钩子命中
   **生产模块内部的相对导入** `./http.js`，所以**零生产代码改动**。
2. **`globalThis.fetch` 补丁**（`fetch-patch.mjs`）——覆盖绕过 http.js 的 14 处裸 fetch
   （实测清单在文件头注释里；钩子管不到「取全局对象再调用」这种写法）。

档案是一条请求一份 JSON，键 = `sha256(方法 + 归一化 URL + body)` 前 32 位
（`engine.requestKey`）。URL 归一化会解码 query 再按 key 排序重建，
所以 `cursor=a%2Fb` 与 `cursor=a/b` 是同一个逻辑键（00:36 实测：不归一化时补录永不收敛）。

## 怎么用

```powershell
# 一次性录制（真打上游，产出档案）。要冷缓存，见下面「录放条件必须一致」。
$env:DSH_REPLAY='record'; $env:DSH_REPLAY_DIR='<archive dir>'
node test/run-gate.mjs

# 回放（零网络，秒级）
$env:DSH_REPLAY='1'; $env:DSH_REPLAY_DIR='<archive dir>'
node test/run-gate.mjs

# 不设 DSH_REPLAY ⇒ 与改动前逐字一致（真网络门）。这是判据 8 锁住的行为。
node test/run-gate.mjs

# 只跑关心的套件（提速方案 A，一直都在）
$env:DSH_GATE_ONLY='test-global-sort.mjs,test-full-sort.mjs'
```

收敛循环（把档案补到能离线跑）：

```powershell
$env:DSH_REPLAY_DIR='<archive dir>'
$env:DSH_GATE_ONLY='<那 10 个慢套件>'
node test/replay/backfill.mjs
```

它每轮**回放 → 若门不绿或有未命中 → 重录 → 再回放**，直到「门全绿且 0 未命中」
或条数不再下降。

## 三条必须知道的边界

**① 未命中 = 红灯，绝不返回空。**
`REPLAY-MISS` 抛错并记账（`DSH_REPLAY_MISSLOG`）。门侧独立数账本条数，
只要 >0 就判该套件红——**不信套件自己怎么汇报**。实测（23:52）：空档案下
`test-global-sort` 把未命中降级成 skip、打印「4 passed, 0 failed, 3 skipped」并退出 0，
而录制态是「9 passed, 2 skipped」：**5 条判据静默蒸发**。若门只听汇总行就放行了，
正是本仓 CHANGELOG 写下过的「『绿』不等于『做了』」。**判据：`misses>0` 优先于 PASS。**

**② 录与放的条件必须逐字一致，尤其是缓存冷热。**
00:45 实测：同一份档案，热缓存下 paging 只 miss 1 条、冷缓存下 miss 24 条——
热态走的是「第二次读 p1 仍要能翻页」的短路径，覆盖面偏窄。
`backfill.mjs` 因此**每轮新建 `DSH_TMP` 缓存目录**。手工补录是无效的：
链型上游（MCP registry 的 cursor、clawhub 的 cursor）下一页由上一页响应决定，
隔时段补的那页属于另一代际的链（我连补三条，每轮换一个新游标值）。

**③ live 冒烟层不可被回放替代（方案 D）。**
回放证明的是「**逻辑**对着一份快照成立」，不是「**上游还是这个形状**。
上游形状漂移正是这类测试最该抓的事。所以要留 env 开关的真实联网层，先例：
`DSH_MS164_LIVE=1`（modelscope 上游真实性）、`DSH_LH_WIN_ONLY=off`（lobehub 平台分支）。
**发布前必须至少跑一次不带 `DSH_REPLAY` 的全量门**（或至少那 10 个真网络套件），
回放用于开发迭代期。CI 的 `npm test` 走的是真网络层——这是有意的。

## 四条必须知道的边界

**④ cursor 链型套件的档案收敛靠「门重录轮」，不靠跨轮回放复用。**
01:11 实测（chain-walk.mjs 读 replay-snap 315 条）：clawhub skills 77 条记录里
cursor-bearing 73 条分属 **68 个不同的链代**（按响应 body 首 2 个 slug 分代），
首页 nextCursor 指向的下一页 hop1 就断——链型上游（clawhub / MCP registry）的
cursor 由上一页响应内容决定，隔时段抓到的任何一页都属于另一代际的链，
**手工补录永远补不齐**。所以这类套件（warmup / nocache / features）在收敛循环里
靠 round 1 重录轮吃满：重录轮内门与套件跑在同一时刻，链是完整的一代，
round 2 回放即 0 未命中（10 套件线实测 rounds=2 CONVERGED）。
推论：**cursor 链档案不能增量复用**——上游目录一动，旧链整代作废，必须整链重录。

**⑤ 全门空档案收敛的语义。**
「回放 0 未命中 + 门全绿」的收敛凭据只在**重录轮吃满之后**成立；
第一轮回放的 miss 数只用于确定红因分布（如 01:15 全门首轮 53/68 green · 54 条，
红因大头 full-sort 25 / sort-honesty 16 / total-pages 11 / sort-options 7 /
warm-budget 6 / func-fixes 1），不作为收敛或失败的判定。

## 本地动作不许冻进档案

`isNetworkCli` 只认 curl / npx / npm（以及 `cmd.exe /c` 里包着这些命令的命令行）；
git / tar / sh / node 一律放行回真。否则「`git ls-remote` 结果被档案糊住」这类
测试会绿得毫无意义。判据 6 锁这七条。

## 现状与待办

- **全门回放实测（01:32，68 套件）：墙钟 43s**，对真网络 1064s（67 套件）。
  该轮 62/68 green，6 条红的判读（**都不算回放层缺陷**）：
  · test-func-fixes / test-paging / test-index-runtime 各「未命中 1 条」+
  test-lobehub-category-vocab 21 条红（`REPLAY-MISS … cmd.exe ["/d","/s","/c","npx -y @lobehub/market-cli …"]`）
  = **这份档案只录了那 10 个慢套件**，其余套件的请求本来就不在里面 ⇒
  红灯正是守卫在起作用（对照组：同一轮里没录到的裸 fetch/CLI 一个都没被当成空数据放行）。
  · test-profile-sync 2 条 = `work=0.5.164 profile=0.5.165`，我的分支基线是 558bbcd（0.5.164），
  合入主树后自然对齐，与回放无关。
  · test-gate-replay 1 条 = **我自己的判据姿势缺陷**：它问父进程 `engine.mode()`，
  而门给子进程传了 `DSH_REPLAY=1` ⇒ 在回放态跑门时必然假红。已改为问子进程
  （判据家 Test 8），两形态各 46/0。
- 10 个慢套件（占门 970s / 1064s）回放态实测 **≈3s**；其余 59 个本来就合计 3s。
- 档案 **不进 git**（13.3 MB，大头是 skills.sh sitemap 891KB×9 分片）；
  放在仓库外的目录，由 `DSH_REPLAY_DIR` 指过去。要长期用就得加一条「档案过期就重录」的
  节奏（建议：每次改 `src/**` 的取数逻辑后重录一轮）。
- 方案 C（并发 4~8）还没做：前提是先有 B，且要同批改 `test-gate-contract` 的
  超时判定（`perTimeout=420s` 是按串行最慢套件定的，并发下总墙钟变短但单套件可能互相拖慢）。
