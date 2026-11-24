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
import { pathToFileURL } from 'node:url';
import { gateVerdict } from './gate-verdict.mjs';
import { safeTempDir } from '../src/home.js';

const W = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(W, 'package.json'), 'utf8'));
// 套件清单来自 test:chain（原始 && 链）。绝不能读 scripts.test —— 它现在指向本运行器，
// 若从它解析会把自己当套件跑 → 无限递归（0.5.109 冒烟时实测炸出递归栈）。
const chain = pkg.scripts['test:chain'] || '';
let suites = [...chain.matchAll(/node test\/([\w.\-]+\.mjs)/g)].map((m) => m[1]).filter((f) => f !== 'run-gate.mjs');
// DSH_GATE_ONLY=a.mjs,b.mjs 只跑指定套件：给「契约本身可证伪」留的钩子
// （test-gate-contract 用它 + 一个无 summary 的假套件，验证 gate 真红），
// 不影响 CI 全量路径。
if (process.env.DSH_GATE_ONLY) {
  const only = process.env.DSH_GATE_ONLY.split(',').map((x) => x.trim()).filter(Boolean);
  suites = suites.filter((f) => only.includes(f));
}
// DSH_GATE_EXTRA 追加清单外的套件（test-gate-contract 用它跑一次性假套件，
// 证明「缺 summary 的套件会让 gate 真红」而不是口头约定）。名字必须是裸文件名
// （无路径分隔符、无 ..），且永远排除 run-gate.mjs 本身 —— 否则就是无限递归。
if (process.env.DSH_GATE_EXTRA) {
  const extra = process.env.DSH_GATE_EXTRA.split(',').map((x) => x.trim()).filter(Boolean);
  const unsafe = extra.filter((f) => !/^[\w.\-]+\.mjs$/.test(f) || f === 'run-gate.mjs');
  if (unsafe.length) {
    console.error('[GATE] DSH_GATE_EXTRA 含非法名字，拒绝执行: ' + unsafe.join(', '));
    process.exit(2);
  }
  for (const f of extra) if (!suites.includes(f)) suites.push(f);
}

if (!suites.length) {
  console.error('[GATE] no suites parsed from scripts["test:chain"] — refusing to pass an empty gate.');
  console.error('::error::[GATE] empty suite list (test:chain missing or malformed) — publish blocked by design');
  process.exit(2);
}
// 420s：本地最慢套件 full-sort≈189s；CI 冷 npx 缓存会让触发 lobehub CLI 的套件（func-fixes、
// full-sort 的 all 聚合）额外等 30–180s。300s 会把这些「慢但正常」误判成 TIMEOUT。
const perTimeout = Math.max(30000, Number(process.env.DSH_GATE_TIMEOUT_MS) || 420000);

// 回放层（方案 B）：DSH_REPLAY=record|1|replay 时给每个套件注入 --import 预加载。
// 刻意用 spawn 参数注入，而不是只靠 NODE_OPTIONS 继承：取证 probe-inherit2 显示
// 「父进程自己也带 NODE_OPTIONS」时父进程的 node:child_process 已被替身顶掉，
// spawnSync 返回的是替身的 {status:0,stdout:''} —— 继承看起来生效、实际是自欺。
// 显式加进 argv 让「注入了没有」在门日志里可见、可锁。
const replayMode = process.env.DSH_REPLAY_MODE || process.env.DSH_REPLAY || '';
const replayOn = replayMode === 'record' || replayMode === '1' || replayMode === 'replay';
const replayArgs = replayOn ? ['--import=' + pathToFileURL(path.join(import.meta.dirname, 'replay', 'preload.mjs')).href] : [];
const replayEnv = replayOn
  ? { ...process.env, DSH_REPLAY_DIR: process.env.DSH_REPLAY_DIR || path.join(W, 'test', 'replay', 'store') }
  : process.env;
// 未命中账本放临时区：它是门运行时产物，不是档案的一部分 —— 混进 store 会被一起提交，
// 也会污染「档案大小」这个度量。按 pid 隔离避免并发门互踩，门结束时整目录删除。
// 父目录必须走 safeTempDir()（test-temp-hygiene 锁：裸 os.tmpdir() 与 mkdtempSync 都判红）。
// DSH_REPLAY_MISS_DIR 是外部编排者（test/replay/backfill.mjs）指定的账本目录：给了就**不删**，
// 否则门末的清理会让外层永远读到 0 条 —— 00:48 实测那层假收敛就是这么来的。
const missDirGiven = replayOn ? String(process.env.DSH_REPLAY_MISS_DIR || '') : '';
const MISS_DIR = replayOn ? (missDirGiven || path.join(safeTempDir(), 'dsh-replay-miss-' + process.pid)) : '';
if (replayOn) { try { fs.mkdirSync(MISS_DIR, { recursive: true }); } catch {} }

// GitHub Actions 用 % 做属性转义、行首 :: 触发命令解析；断言原文可能含这些字符。
// 注解消息里把 % 转 %25、去掉行首 :: 与换行，避免污染工作流命令。
function gateEscape(text) {
  return String(text).replace(/%/g, '%25').replace(/\r?\n/g, ' ').replace(/^:+/, '');
}
const runOne = (file) => new Promise((resolve) => {
  const t0 = Date.now();
  // 每个套件一份独立账本：谁未命中就判谁红，不靠套件自己怎么汇报。
  const misslog = replayOn ? path.join(MISS_DIR, '.miss-' + process.pid + '-' + file + '.log') : '';
  if (replayOn) { try { fs.mkdirSync(MISS_DIR, { recursive: true }); fs.rmSync(misslog, { force: true }); } catch {} }
  const child = spawn(process.execPath, [...replayArgs, path.join(W, 'test', file)], {
    cwd: W,
    env: misslog ? { ...replayEnv, DSH_REPLAY_MISSLOG: misslog } : replayEnv,
  });
  let out = '';
  let killed = false;
  const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, perTimeout);
  const grab = (chunk) => { out += String(chunk); if (out.length > 400000) out = out.slice(-400000); };
  child.stdout.on('data', grab);
  child.stderr.on('data', grab);
  child.on('close', (code) => {
    clearTimeout(timer);
    let misses = 0;
    if (misslog) {
      try { misses = fs.readFileSync(misslog, 'utf8').split('\n').filter(Boolean).length; } catch {}
    }
    resolve({ file, code, killed, ms: Date.now() - t0, out, misses });
  });
});

console.log(`[GATE] ${suites.length} suites, per-suite timeout ${Math.round(perTimeout / 1000)}s` + (replayOn ? `, replay=${replayMode} dir=${replayEnv.DSH_REPLAY_DIR}` : ''));
const results = [];
for (const s of suites) {
  const r = await runOne(s);
  // 判定唯一来源：gate-verdict.mjs 的纯函数（test-gate-contract 锁住其全部分支）。
  const { verdict, summary } = gateVerdict(r);
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
// 未命中账本是运行时产物：门跑完即清理（正常退出路径；红路径已用 process.exit，
// 残留按 pid 隔离不互踩，下轮 mkdirSync 覆盖）。外层指定目录时不清——它还要读。
if (replayOn && !missDirGiven) { try { fs.rmSync(MISS_DIR, { recursive: true, force: true }); } catch {} }

