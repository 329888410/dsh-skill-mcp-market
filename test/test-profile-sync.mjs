#!/usr/bin/env node
// test-profile-sync.mjs — TDD: desktop profile 必须与工作树逐字节一致。
// 症状回归：profile 的 client.js 停留在 0.5.66 之前 → 吸顶头部丢失 + 分页器无省略号。
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const W = path.resolve(import.meta.dirname, '..');
const P = 'C:\\Users\\贺新\\.dsh\\profiles\\desktop\\node_modules\\dsh-skill-mcp-market';
const D = 'D:\\DeepSeek Harness WorkSpace\\dsh-market';
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
{
  const c = norm(fs.readFileSync(path.join(P, 'client.js'), 'utf8'));
  check('has position: sticky', c.includes("position: 'sticky'"));
  check('has data-dsh-market-body scroll root', c.includes('data-dsh-market-body'));
}

// ── Test 2: profile client.js 分页器必须折叠中间页（省略号） ──
console.log('\nTest 2: profile pager collapses the middle with an ellipsis');
{
  const c = norm(fs.readFileSync(path.join(P, 'client.js'), 'utf8'));
  check('uses pageItems (ellipsis window)', c.includes('pageItems'));
  check('no legacy pageWin', !c.includes('pageWin'));
  check('window span is 5', c.includes('span = 5'));
}

// ── Test 3: 每个 git 跟踪的 .js 在 profile 与 D 中逐字节一致 ──
console.log('\nTest 3: every tracked .js matches across work / profile / D');
{
  const stale = [];
  for (const f of tracked) {
    let a, b, d;
    try { a = norm(fs.readFileSync(path.join(W, f), 'utf8')); } catch { a = null; }
    try { b = norm(fs.readFileSync(path.join(P, f), 'utf8')); } catch { b = null; }
    try { d = norm(fs.readFileSync(path.join(D, f), 'utf8')); } catch { d = null; }
    if (a === null) continue;
    if (a !== b) stale.push('profile:' + f);
    if (a !== d) stale.push('D:' + f);
  }
  check('no stale copies', stale.length === 0, stale.slice(0, 6).join(', '));
}

// ── Test 4: profile package.json 版本与工作树一致 ──
console.log('\nTest 4: profile package.json version matches worktree');
{
  const wv = JSON.parse(fs.readFileSync(path.join(W, 'package.json'), 'utf8')).version;
  const pv = JSON.parse(fs.readFileSync(path.join(P, 'package.json'), 'utf8')).version;
  const dv = JSON.parse(fs.readFileSync(path.join(D, 'package.json'), 'utf8')).version;
  check('all three report ' + wv, wv === pv && wv === dv, '(work=' + wv + ' profile=' + pv + ' D=' + dv + ')');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
