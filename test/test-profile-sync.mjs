#!/usr/bin/env node
// test-profile-sync.mjs — TDD: desktop profile 必须与工作树逐字节一致。
// 症状回归：profile 的 client.js 停留在 0.5.66 之前 → 吸顶头部丢失 + 分页器无省略号。
import fs from 'node:fs';
import path from 'node:path';
import { safeTempDir } from '../src/home.js';
import { execSync } from 'node:child_process';

const W = path.resolve(import.meta.dirname, '..');
// 可移植：不写死用户名/盘符。profile 与 D 仓库都是「可选」的镜像，
// 不存在时跳过而记为 skipped（CI 上没有这些路径是正常的）。
import os from 'node:os';
const HOME = os.homedir();
const P = process.env.DSH_MARKET_PROFILE_DIR || path.join(HOME, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-skill-mcp-market');
// 镜像仓库完全可选：只认环境变量或 ~/dsh-market，不存在就跳过。
const D = process.env.DSH_MARKET_MIRROR_DIR
  || [path.join(HOME, 'dsh-market')]
       .find((c) => { try { fs.accessSync(path.join(c, 'package.json')); return true; } catch { return false; } })
  || path.join(HOME, 'dsh-market-none');
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const norm = (t) => t.replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log('  \u2713 ' + name); }
  else { failed++; console.log('  \u2717 ' + name + (detail ? '  ' + detail : '')); }
};

const tracked = execSync('git ls-files', { cwd: W, encoding: 'utf8' })
  .split('\n').filter((l) => l.trim() && l.endsWith('.js'))
  .map((l) => l.trim().replace(/\//g, path.sep));

// ── Test 1: profile client.js 必须有吸顶头部 ──
console.log('\nTest 1: profile client.js keeps the sticky tab header');
if (!exists(path.join(P, 'client.js'))) {
  console.log('  (skipped: no profile checkout at ' + P + ')');
} else {
  const c = norm(fs.readFileSync(path.join(P, 'client.js'), 'utf8'));
  check('has position: sticky', c.includes("position: 'sticky'"));
  check('has data-dsh-market-body scroll root', c.includes('data-dsh-market-body'));
}

// ── Test 2: profile client.js 分页器必须折叠中间页（省略号） ──
console.log('\nTest 2: profile pager collapses the middle with an ellipsis');
if (!exists(path.join(P, 'client.js'))) {
  console.log('  (skipped: no profile checkout)');
} else {
  const c = norm(fs.readFileSync(path.join(P, 'client.js'), 'utf8'));
  check('uses pageItems (ellipsis window)', c.includes('pageItems'));
  // 旧断言 !c.includes('pageWin') 会被新纯函数名 pageWindow 的子串触发（假阳性，
  // 与 Test 11 的 skillsTotalPages 冒充 skillsTotal 同类）。改钉真正区分「当前版 vs
  // 0.5.66 陈旧版」的标记：本轮删掉的死代码 const shown / windowed 必须不在。
  check('no dead pager code from older builds', !c.includes('const shown = Math.min') && !c.includes('windowed = true'), '');
  check('page window via pure fn with span 5', c.includes('pageWindow(page, n, 5)'));
}

// ── Test 3: 每个 git 跟踪的 .js 在 profile 与 D 中逐字节一致 ──
console.log('\nTest 3: every tracked .js matches across the mirror checkouts that exist');
{
  if (!exists(P) && !exists(D)) console.log('  (skipped: no mirror checkouts present)');
  const stale = [];
  for (const f of tracked) {
    let a, b, d;
    try { a = norm(fs.readFileSync(path.join(W, f), 'utf8')); } catch { a = null; }
    try { b = norm(fs.readFileSync(path.join(P, f), 'utf8')); } catch { b = null; }
    try { d = norm(fs.readFileSync(path.join(D, f), 'utf8')); } catch { d = null; }
    if (a === null) continue;
    if (b !== null && a !== b) stale.push('profile:' + f);
    if (d !== null && a !== d) stale.push('D:' + f);
  }
  check('no stale copies', stale.length === 0, stale.slice(0, 6).join(', '));
}

// ── Test 4: profile package.json 版本与工作树一致 ──
console.log('\nTest 4: profile package.json version matches worktree');
if (!exists(path.join(P, 'package.json'))) {
  console.log('  (skipped: no profile checkout)');
} else {
  const readv = (base) => { try { return JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8')).version; } catch { return null; } };
  const wv = readv(W), pv = readv(P), dv = readv(D);
  const present = [pv, dv].filter((v) => v !== null);
  check('mirrors report ' + wv, present.every((v) => v === wv), '(work=' + wv + ' profile=' + pv + ' D=' + dv + ')');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
