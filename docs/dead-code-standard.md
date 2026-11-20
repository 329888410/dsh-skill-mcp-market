# 死代码认定标准与检测方法（dsh-market）

> 本文件由 2026-11-20 的死代码清理实战总结而成。历史上本仓库两次因「凭感觉清理」出问题：
> 一次把「同文件内被 SOURCE_HANDLERS 表引用」误判为死导出（照单删除会崩）；一次差点删掉
> 只被 test-security.mjs 引用的 buildPosixExportLine。以下标准是这两次教训的固化。
> 标准本身由 test/test-dead-exports.mjs 机器执行（Test 3 全量扫描 + Test 5 反向锁），
> 「写了没做」不再可能：文档与测试同仓同 CI。

## 一、认定标准（全部满足才算死代码）

符号 S 声明于文件 F，S 是死代码，当且仅当：

1. **引用面 = 全仓**：检索范围必须覆盖 index.js、client.js、src/*.js、test/*.mjs、
   locale/*.json、README/AGENTS/package.json。缺任何一块都会误判（locale 与文档里
   的符号名是动态查找的候选来源）。
2. **定义文件内的非声明引用也算「活」**：`SOURCE_HANDLERS = { 'skills.sh': searchSkillsSh }`
   这种表引用、`if (q<2) return browseSkillsSh(...)` 这种内部调用，都使符号不能删。
   此时若外部引用为零 → 属于「收紧」（去 export），不属于「删除」。
3. **动态访问必须显式排除**：`obj[name]`、字符串拼接的 op 分派、`await import(...)`。
   检测方法：对每个候选符号跑一次全仓 `import {S} from` 断链核验（见二.3），
   再人工确认无 `"S"` 字符串形态的键访问。不确定 → 不删（存疑归「保留」）。
4. **测试引用是有效引用**：只被 test/ 用的符号（如 buildPosixExportLine）必须保留。
   测试是契约的一部分，不是死代码。
5. **级联判定**：删除 S 后，仅被 S 调用的私有 helper 变成新的死代码，必须一并删除
   （本次 enrichSkillsSh → repoFileIndex/locateSkillFile）；反之，删除后仍有其它调用者
   的 helper 必须保留（usableDescription/fetchText/decodeEntities 均如此）。
   判定方法：删除前模拟移除 S 的函数体，重数每个 helper 的剩余引用数，>0 则保留。

## 二、检测方法（本次实战使用、可复用的四步）

1. **扫描**：正则收集 src/*.js 的 `export function|const|class` 与 `export {}` 重导出，
   对每个符号统计「定义文件外引用数」与「定义文件内非声明引用数」。
2. **分类**：外部=0 且内部=0 → 删除候选；外部=0 且内部>0 → 收紧候选；外部>0 → 保留。
   任何一步不确定（动态访问嫌疑）→ 降级为保留并在 CHANGELOG 记存疑。
3. **断链核验（改后必跑）**：穷举全仓每一条 `import {…} from '../src/x.js'`，动态加载
   目标模块，验证每个被导入名 `in mod`。本次实测 160 个导入名零断链。
   这一步同时覆盖「收紧过度」与「删多了」两类事故。
4. **行为回归（改后必跑，缺一不可）**：
   - 全量离线套件（23 个，334 项）；
   - test-nocache：8 源 handler 表逐个真调（收紧 browseSkillsSh/searchSkillsSh/searchBrowseSh
     后 SOURCE_HANDLERS 是否接得上，只有这条能证明）；
   - CI 门内慢实网套件（full-sort/global-sort/sort-honesty）：直接 import 被收紧符号的
     消费方在这里暴露；
   - test-dead-exports：标准本身的机器锁（Test 3 全量扫描恒零、Test 5 反向锁防「顺手删」）。

## 三、操作纪律

- **基线先行**：动手前全量跑一次并记录数字（本次 334/0），改后必须 ≥ 基线。
- **锚点核验**：按行号删除前，校验区间首行含目标符号；区间外一行不得误伤。
- **模拟删除**：级联 helper 的保留/删除判定必须在模拟后的文本上做，不在脑内做。
- **git diff 行数与预期比对**：删除量 ≈ 函数体行数，收紧量 = 17 行（每符号一行）。
- **一次提交只做一类事**：删除+收紧+新测试同提交可以，但必须混在「行为零变化」的边界内；
  任何行为性修复另开提交。
- **CHANGELOG 只写已验证事实**：每个数字（引用数、断链数、套件项数）都要来自实际命令输出。

## 四、本次执行记录（2026-11-20，0.5.114）

- 删除：enrichSkillsSh（src/enrich.js:94-143）及其级联私有 helper repoFileIndex(:52-69)、
  locateSkillFile(:86-92)；readEnvironmentVariable（src/env.js:56-58）。
- 收紧 17 个仅本文件使用的 export：mapLimit、fetchFileText、safeJoin、BROWSER_HEADERS、
  curlJson、pythonJson、curlPostText、pythonPostText、LOBEHUB_MARKET_BASE、
  lobehubCredentialsPath、registerLobeHubClient、registryCard、registryQueryUrl、
  FALLBACK_SERVERS、browseSkillsSh、searchSkillsSh、searchBrowseSh。
- 保留（反向锁）：buildPosixExportLine（test-security ×4 引用）、SORT_KEYS（0.5.109 起被
  index.js 引用——旧清单已过期，证明「不得凭记忆清理」）。
- 改后验证：160 导入名零断链；334 项离线全绿；nocache 8 源全过；full-sort 24/24、
  global-sort 22/22、sort-honesty 11/11；test-dead-exports 47/47。
