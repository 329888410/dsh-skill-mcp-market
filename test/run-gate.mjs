#!/usr/bin/env node
// test/run-gate.mjs — CI 门运行器：逐套件执行并打印归属，取代 `a && b && c` 链。
//
// 为什么要有它（2026-11-19 实测教训）：0.5.109 的 CI 在 'Run tests' 步骤 exit 1，
// 但 && 链只给出「Process completed with exit code 1」，而 Actions 日志下载端点需要
// 仓库 admin（403）—— 一个红灯无法归因，只能靠猜。本运行器为每个套件打印
// [GATE] <suite> → PASS/FAIL/SKIP/TIMEOUT + 计数行 + 失败摘录，日志自解释。
//
// 语义与 && 链一致：任一 FAIL/TIMEOUT → 退出码 1（闸门不放行）。SKIP 不算失败。
// 每个套件有独立超时（默认 300s，可用 DSH_GATE_TIMEOUT_MS 覆盖），慢套件不再
// 拖垮整条链，也不会让整条链被 CI 的 360min 步骤超时静默吞掉。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const W = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(W, 'package.json'), 'utf8'));
// 套件清单来自 test:chain（原始 && 链）。绝不能读 scripts.test —— 它现在指向本运行器，
// 若从它解析会把自己当套件跑 → 无限递归（0.5.109 冒烟时实测炸出递归栈）。
const chain = pkg.scripts['test:chain'] || '';
const suites = [...chain.matchAll(/node test\/([\w.\-]+\.mjs)/g)].map((m) => m[1]).filter((f) => f !== 'run-gate.mjs');
if (!suites.length) {
  console.error('[GATE] no suites parsed from scripts["test:chain"] — refusing to pass an empty gate.');
  console.error('::error::[GATE] empty suite list (test:chain missing or malformed) — publish blocked by design');
  process.exit(2);
}
// 420s：本地最慢套件 full-sort≈189s；CI 冷 npx 缓存会让触发 lobehub CLI 的套件（func-fixes、
// full-sort 的 all 聚合）额外等 30–180s。300s 会把这些「慢但正常」误判成 TIMEOUT。
const perTimeout = Math.max(30000, Number(process.env.DSH_GATE_TIMEOUT_MS) || 420000);

// GitHub Actions 用 % 做属性转义、行首 :: 触发命令解析；断言原文可能含这些字符。
// 注解消息里把 % 转 %25、去掉行首 :: 与换行，避免污染工作流命令。
function gateEscape(text) {
  return String(text).replace(/%/g, '%25').replace(/\r?\n/g, ' ').replace(/^:+/, '');
}
const runOne = (file) => new Promise((resolve) => {
  const t0 = Date.now();
  const child = spawn(process.execPath, [path.join(W, 'test', file)], { cwd: W, env: process.env });
  let out = '';
  let killed = false;
  const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, perTimeout);
  const grab = (chunk) => { out += String(chunk); if (out.length > 400000) out = out.slice(-400000); };
  child.stdout.on('data', grab);
  child.stderr.on('data', grab);
  child.on('close', (code) => {
    clearTimeout(timer);
    resolve({ file, code, killed, ms: Date.now() - t0, out });
  });
});

console.log(`[GATE] ${suites.length} suites, per-suite timeout ${Math.round(perTimeout / 1000)}s`);
const results = [];
for (const s of suites) {
  const r = await runOne(s);
  const counts = (r.out.match(/\n(\d+) passed, (\d+) failed(?:, (\d+) skipped)?\s*$/) || []);
  const summary = counts.length ? `${counts[1]} passed, ${counts[2]} failed${counts[3] ? ', ' + counts[3] + ' skipped' : ''}` : '(no summary line)';
  // 判定优先级：被杀=TIMEOUT；非零退出=FAIL；退出0但无 summary 行=NO-SUMMARY（红）；
  // 退出0且 summary 含 0 failed=PASS。NO-SUMMARY 必须算红：本仓库 24 个套件无一例外都打印
  // 「N passed, M failed」并 process.exit(failed?1:0)，缺失说明套件中途崩了或没跑完——
  // 正是「25 个版本零测试静默发布」那类失败模式，闸门绝不能替它放行。
  const hasSummary = counts.length > 0;
  const verdict = r.killed ? 'TIMEOUT' : r.code !== 0 ? 'FAIL' : !hasSummary ? 'NO-SUMMARY' : (summary.includes(' 0 failed') ? 'PASS' : 'FAIL');
  results.push({ file: s, verdict, summary, ms: r.ms });
  console.log(`[GATE] ${s.padEnd(26)} ${verdict.padEnd(9)} ${Math.round(r.ms / 1000)}s  ${summary}`);
  if (verdict !== 'PASS') {
    // ::error:: 会被 GitHub 转成 check-run annotation（公开可读，无需 admin 拉日志），
    // 因此红灯的「哪个套件、什么判定」必须进这一行。
    console.log('::error::[GATE] ' + s + ' ' + verdict + ' (' + gateEscape(summary) + ', ' + Math.round(r.ms / 1000) + 's)');
    const bad = r.out.split('\n').filter((l) => /FAIL|✗|Error|npm error/.test(l)).slice(0, 8);
    for (const l of bad) console.log('        | ' + l.trim().slice(0, 160));
    // 失败断言也各出一条 annotation，便于在 Checks 页直接看到是哪一项
    for (const l of bad.slice(0, 4)) console.log('::error::[GATE] ' + s + ' :: ' + gateEscape(l.trim()).slice(0, 180));
    if (verdict === 'TIMEOUT') console.log('::error::[GATE] ' + s + ' 被单套件超时 ' + Math.round(perTimeout / 1000) + 's 杀死（可调 DSH_GATE_TIMEOUT_MS）');
  }
}
const bad = results.filter((x) => x.verdict !== 'PASS');
console.log('');
console.log(`[GATE] ${results.length - bad.length}/${results.length} suites green`);
if (bad.length) {
  console.log('[GATE] RED suites: ' + bad.map((x) => x.file + '(' + x.verdict + ')').join(', '));
  console.log('::error::[GATE] publish blocked: ' + bad.length + '/' + results.length + ' suites red → ' + gateEscape(bad.map((x) => x.file + '(' + x.verdict + ')').join(', ')).slice(0, 400));
  process.exit(1);
}
console.log('[GATE] total ' + Math.round(results.reduce((a, x) => a + x.ms, 0) / 1000) + 's across ' + results.length + ' suites');
