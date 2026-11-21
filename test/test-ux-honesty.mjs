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
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
