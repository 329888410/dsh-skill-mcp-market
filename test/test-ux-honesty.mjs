#!/usr/bin/env node
// test-ux-honesty.mjs — TDD: 四个本轮实测取证的既有缺陷（不新增功能）。
//
// 取证（实测，非推断）：
//  ① MCP 缓存命中不恢复 hasMore：技能侧有 setSkillsHasMore(Boolean(cached.hasMore))
//     且缓存对象写了 hasMore；MCP 侧两处都没有 → 切源再切回时「下一页」按钮停在
//     上一个源的 hasMore 值上（cursor 型注册表没有总页数，hasMore 是唯一信号）。
//  ② 卡片数字未统一 Number 化：installs 直接 item.installs.toLocaleString()，同排其余
//     三处都包了 Number()。上游若回字符串数字，String 没有 toLocaleString → 整卡抛错。
//  ③ 跳页拒绝是静默的：pageJumpTarget 对越界/非法/同页一律返回 0，界面清空输入框、
//     页面不动、零反馈 → 用户无法区分「被拒绝」与「已经跳了」（9736 页量级必踩）。
//  ④ 同一条件的在途请求不去重：连按两次回车各打一次上游（等待翻倍、结果同形）。
import fs from 'node:fs';
import path from 'node:path';
import { countHits, blockEnd } from './anchor-lib.mjs';

const W = path.resolve(import.meta.dirname, '..');
const NL = String.fromCharCode(10);
const client = fs.readFileSync(path.join(W, 'client.js'), 'utf8').replace(/\r\n/g, NL);
const CL = client.split(NL);
let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  ' + String(d).slice(0, 140) : '')); } };
function grabFn(name) {
  const start = CL.findIndex((l) => l.trimStart().startsWith('const ' + name + ' ='));
  if (start < 0) return null;
  const line = CL[start].trimEnd();
  if (!/[({]$/.test(line)) return line;
  return CL.slice(start, blockEnd(client, start, name) + 1).join(NL);
}

console.log('');
console.log('Test 1: MCP 缓存必须携带并恢复 hasMore');
{
  const wr = CL.find((l) => l.indexOf('resultCacheRef.current[cacheKey] = { items: rows, categories:') >= 0);
  check('找到 MCP 缓存写入行', wr !== undefined);
  check('MCP 缓存写入包含 hasMore 字段', wr !== undefined && wr.indexOf('hasMore:') >= 0, wr ? wr.trim().slice(0, 130) : '');
  check('MCP 缓存命中恢复 hasMore', countHits(client, 'setMcpHasMore(Boolean(cached.hasMore))') >= 1);
  check('技能侧原有恢复仍在（不许改坏一侧）', countHits(client, 'setSkillsHasMore(Boolean(cached.hasMore))') >= 1);
}

console.log('');
console.log('Test 2: 卡片数字一律 Number 化后才 toLocaleString');
{
  const bare = ['installs', 'downloads', 'stars'].filter((k) => client.indexOf('item.' + k + '.toLocaleString()') >= 0);
  check('不存在裸 item.<数字>.toLocaleString()', bare.length === 0, bare.join(', '));
  check('安装数与下载数仍在渲染', client.indexOf('次安装') >= 0 && client.indexOf('次下载') >= 0);
}

console.log('');
console.log('Test 3: pageJumpOutcome 给出拒绝原因（真值表实跑）');
{
  const s = grabFn('pageJumpOutcome');
  check('pageJumpOutcome 已定义', s !== null, 'client.js 里找不到');
  if (s) {
    const f = new Function(s + NL + '; return pageJumpOutcome;')();
    check('合法跨页 → 给页码无拒绝', JSON.stringify(f('9', 1, 9736, false)) === JSON.stringify({ page: 9, reason: '' }), JSON.stringify(f('9', 1, 9736, false)));
    check('越界（已知总页数）→ outOfRange', f('99999', 1, 9736, false).reason === 'outOfRange');
    check('非数字 → invalid', f('abc', 1, 9736, false).reason === 'invalid');
    check('小于 1 → invalid', f('0', 1, 9736, false).reason === 'invalid');
    check('等于当前页 → samePage 且不发请求', f('3', 3, 9736, false).reason === 'samePage' && f('3', 3, 9736, false).page === 0);
    check('空输入 → 静默返回', f('', 3, 9736, false).page === 0 && f('', 3, 9736, false).reason === '');
    check('未知总页数时不设上界（cursor 型源）', f('5000', 1, 0, true).page === 5000);
    const t = grabFn('pageJumpTarget');
    check('pageJumpTarget 由 outcome 派生（不再各写各的 clamp）', t !== null && t.indexOf('pageJumpOutcome(') >= 0);
  }
}

console.log('');
console.log('Test 4: 跳页拒绝必须可见（回车与失焦共用一个入口）');
{
  const ap = countHits(client, 'applyJump(setJumpState)');
  check('回车与失焦都走 applyJump（不是各写各的）', ap === 2, ap);
  check('拒绝三类都有可见文案', client.indexOf('请输入有效页码') >= 0 && client.indexOf('超出范围：共 ') >= 0 && client.indexOf('已在第 ') >= 0);
  check('提示节点确实渲染', countHits(client, 'jumpNotice ? h(') >= 1);
  check('判定在 pager 里只出现一次', countHits(client, 'pageJumpOutcome(jumpState') === 1);
}

console.log('');
console.log('Test 5: 同条件在途请求去重（真值表 + 双侧接线）');
{
  const s = grabFn('shouldSkipInflight');
  check('shouldSkipInflight 已定义', s !== null, 'client.js 里找不到');
  if (s) {
    const f = new Function(s + NL + '; return shouldSkipInflight;')();
    const inflight = new Set(['sk|a|q|c|1|24|s']);
    check('同 key 在途 → 跳过', f(inflight, 'sk|a|q|c|1|24|s') === true);
    check('不同 key → 放行', f(inflight, 'sk|a|q|c|2|24|s') === false);
    check('空 key（append 请求）永不跳过', f(inflight, '') === false);
    check('入参不是 Set 时不误跳过', f(null, 'x') === false);
  }
  check('技能侧接入在途判定', countHits(client, 'shouldSkipInflight(inflightRef.current, cacheKey)') >= 1);
  check('MCP 侧同样接入（不是只修一侧）', countHits(client, 'shouldSkipInflight(mcpInflightRef.current, cacheKey)') >= 1);
  check('两侧都在 finally 清理在途集合（不泄漏）', countHits(client, 'inflightRef.current.delete(cacheKey)') >= 1 && countHits(client, 'mcpInflightRef.current.delete(cacheKey)') >= 1);
}

console.log('');

console.log('');
console.log('Test 6: 面板不得呈现「点了拿不到内容」的详情入口（live 实测取证）');
{
  // 实测（点 clawhub 卡片的「详情」）：宿主内置浏览器 tab 以框架方式承载页面，
  // clawhub 回 X-Frame-Options: DENY + CSP frame-ancestors 'none'，于是 tab 里只有
  // Chromium 的灰色禁止图标 —— 按钮写着「查看详情」，用户拿到的是空白拦截页。
  // 与「质量按钮永远点不动」同一类缺陷，只是发生在点击之后。逐源实测的响应头：
  //   clawhub DENY/'none'、skills.sh DENY/'none'、github(skillsmp) deny/'none'、
  //   skillhub SAMEORIGIN、modelscope 'self' → 都拒绝被非同源宿主内嵌；
  //   lobehub、browse.sh 未设 → 可以内嵌。判据按「实测过拒绝」而不是按猜测。
  const s = grabFn('embedBlockedFor');
  check('embedBlockedFor 已定义', s !== null, 'client.js 里找不到');
  if (s) {
    const f = new Function(s + NL + "; return embedBlockedFor;")();
    for (const src of ['clawhub', 'skills.sh', 'skillsmp', 'skillhub', 'modelscope']) {
      check(src + ' 实测拒绝内嵌 → 入口不可用', f({ source: src }) === true, String(f({ source: src })));
    }
    for (const src of ['lobehub', 'browse.sh']) {
      check(src + ' 未实测到拒绝 → 不置灰（不凭猜限制）', f({ source: src }) === false, String(f({ source: src })));
    }
    check('未知源不置灰（保守：只限制实测过的）', f({ source: 'trusttools' }) === false);
    check('空入参不抛', f(null) === false && f(undefined) === false);
  }
  // 接线：两个站点的详情按钮都必须用它，且被拦时不得再承诺「查看详情」
  check('技能卡详情按钮接可打开性判定', countHits(client, 'disabled: !detailUrlFor(item) || embedBlockedFor(item)') >= 1);
  check('MCP 卡同口径（不只修一侧）', countHits(client, 'detailUrlFor(item) && !embedBlockedFor(item) ? h(') >= 1);
  check('被拦时 title 说明原因而非承诺内容', countHits(client, '该站点拒绝被内嵌') >= 1);
  check('未出现「点了仍打内置浏览器」的旧承诺残留', countHits(client, "title: detailUrlFor(item) ? '在 DSH 内置浏览器中查看详情'") === 0);
}

console.log('');

console.log('');
console.log('Test 7: 「无本插件报错」按【触发方】判定（口径进仓库，不进说明文字）');
{
  // 教训（本轮 live 实测）：点 clawhub「详情」稳定产生 console 错误
  // 「Framing 'https://clawhub.ai/' violates frame-ancestors 'none'」，文本里不含插件文件名。
  // 若按「报错文本里有没有我们的文件名」判定，这类问题会永远落在判据缝隙里。
  // 口径落在 test/live-audit.mjs（纯函数、可证伪），scratch 里的 live 脚本 import 同一个
  // 模块 —— 两处各写一套判据正是假绿来源。
  let mod = null, err = '';
  try { mod = await import('./live-audit.mjs'); } catch (e) { err = String(e && e.message || e); }
  const classify = mod && mod.classify;
  check('test/live-audit.mjs 导出 classify', typeof classify === 'function', err.slice(0, 90));
  if (typeof classify === 'function') {
    const FRAME = { level: 'error', text: "Framing 'https://clawhub.ai/' violates the following Content Security Policy directive: frame-ancestors 'none'. The request has been blocked." };
    check('同一错误非插件触发 → HOST-UNTRIGGERED（豁免但列出）', classify(FRAME) === 'HOST-UNTRIGGERED');
    check('文本命中插件面（client.js）→ PLUGIN', classify({ level: 'error', text: 'TypeError at client.js:1' }) === 'PLUGIN');
    check('RPC op 名也属插件面', classify({ level: 'error', text: 'unknown operation "skills.search"' }) === 'PLUGIN');
    check('点击插件按钮后的报错 → TRIGGERED（计入待处理）', classify(Object.assign({}, FRAME, { phase: 'after:click:详情:clawhub' })) === 'TRIGGERED');
    check('非 error 级不参与判定', classify({ level: 'warn', text: 'client.js slow' }) === null);
    const a = mod.audit([Object.assign({}, FRAME, { phase: 'after:click:详情:clawhub' })]);
    check('audit 把 TRIGGERED 计入 bad', a.bad.length === 1 && a.bad[0].kind === 'TRIGGERED');
    const b = mod.audit([{ level: 'error', text: '[deepseek-account] x' }]);
    check('audit 不因纯基线报错判红', b.bad.length === 0 && b.baseline === 1);
    // 反向破坏（在套件内自证）：若把触发方归因写死成 HOST，本轮教训必须被抓住
    const weakened = (e) => (classify(e) === 'PLUGIN' ? 'PLUGIN' : 'HOST-UNTRIGGERED');
    // 去重与首次出现归因（本轮实测教训：只看「点击后出现过」会把宿主 GUI 自己
    // 每几秒就在刷的 /api/changes.summary → 404 也算成我们触发）。断言一律用
    // 真实观测文本（phase-entries.json 逐字），玩具字符串测不到 URL 剥离那一步。
    const sig = mod.signature;
    const REAL = {
      changes: 'GET /api/changes.summary?sessionId=session-d47527ee-ad19-4d95-8f12-6907415073bc&seq=39001 → 404',
      wsAgent: "WebSocket connection to 'ws://127.0.0.1:56217/sidebar/ws/agent-opens?sessionId=session-d47527ee-ad19-4d95-8f12-6907415073bc' failed: Page entered Back-Forward Cache.",
      wsMux: "WebSocket connection to 'ws://127.0.0.1:56217/api/remote.mux' failed: Page entered Back-Forward Cache.",
      csp: "Framing 'https://clawhub.ai/' violates the following Content Security Policy directive: \"frame-ancestors 'none'\". The request has been blocked.",
    };
    check('同一接口不同 seq 归并为一个签名（实测 changes.summary 轮询）',
      sig(REAL.changes) === sig(REAL.changes.replace('seq=39001', 'seq=41002')),
      sig(REAL.changes) + ' vs ' + sig(REAL.changes.replace('seq=39001', 'seq=41002')));
    check('不同 WebSocket 端点不合并（保守归并）', sig(REAL.wsAgent) !== sig(REAL.wsMux));
    const dup = mod.audit([
      { level: 'error', text: REAL.changes, phase: 'before:load' },
      { level: 'error', text: REAL.changes.replace('seq=39001', 'seq=41002'), phase: 'after:click:详情:clawhub' },
    ]);
    check('点击前就在刷的签名不算本侧触发', dup.bad.length === 0, JSON.stringify(dup.bad.map((x) => x.kind)));
    check('重复条目计入 repeats 而非 distinct', dup.repeats === 1 && dup.distinct === 1, dup.repeats + '/' + dup.distinct);
    const fresh = mod.audit([{ level: 'error', text: REAL.csp, phase: 'after:click:详情:clawhub' }]);
    check('首次就出现在点击后的仍算触发', fresh.bad.length === 1 && fresh.bad[0].kind === 'TRIGGERED');
  }
}

console.log('');

console.log('');
console.log('Test 8: 判别点执行前必须确认探针落在目标面板控件上（未测成不等于行为未变）');
{
  // 本轮真实教训：第一次跑「SkillHub 搜 pdf 的 total」时，我把文本打进主页面搜索框
  // （面板根本没打开），摘要自然没变 —— 差点写成「keyword 未进 live」。识别为「未测成」
  // 才对。这类误判会把正向结论（pdf total 5,623、installs 86,140 与 downloads 1,741,337
  // 分离、翻页总数不随页码变化）反过来污染掉，所以做成硬前置。
  let mod = null, err = '';
  try { mod = await import('./live-audit.mjs'); } catch (e) { err = String(e && e.message || e); }
  const land = mod && mod.assertProbeLanded;
  check('live-audit 导出 assertProbeLanded', typeof land === 'function', err.slice(0, 80));
  if (typeof land === 'function') {
    const GOOD = {
      panelOpen: true,
      control: { ref: 142, owner: 'panel', width: 916 },
      expectedButtons: { '详情': 24 },
      buttons: { '详情': 24 },
    };
    check('落点正确 → landed', land(GOOD).landed === true, JSON.stringify(land(GOOD)));
    const noPanel = land({ ...GOOD, panelOpen: false });
    check('面板没打开 → 未测成（禁止下结论）', noPanel.landed === false && /面板/.test(noPanel.reason), JSON.stringify(noPanel));
    const wrongBox = land({ ...GOOD, control: { ref: 106, owner: 'session-search', width: 200 } });
    check('输入框不属该面板 → 未测成（本轮真实失误形态）', wrongBox.landed === false && /归属/.test(wrongBox.reason), JSON.stringify(wrongBox));
    const missing = land({ ...GOOD, buttons: { '详情': 0 } });
    check('目标按钮数为 0 → 未测成（不是「行为未变」）', missing.landed === false && /按钮/.test(missing.reason), JSON.stringify(missing));
    const mismatch = land({ ...GOOD, buttons: { '详情': 12 } });
    check('按钮数与预期不符 → 未测成', mismatch.landed === false && /按钮/.test(mismatch.reason), JSON.stringify(mismatch));
    check('缺 control 字段 → 未测成而不是抛错', land({ panelOpen: true, expectedButtons: {}, buttons: {} }).landed === false);
    check('verdictOf：未测成不得写成 PASS/FAIL', mod.verdictOf({ landed: false, reason: '面板未打开' }) === 'NOT-TESTED' && mod.verdictOf({ landed: true }) === 'OK');
  }
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
