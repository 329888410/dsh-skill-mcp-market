#!/usr/bin/env node
// test-cleanup.mjs — TDD: 本批清理的回归锁定。
//   P0-1 生产代码不得写调试日志（dsh-rpc-headers.log）
//   P0-2 frame.check / checkFrameable 死功能 + SSRF 必须删除
//   P1-3 rpc-guard 死导出（token/checkToken/TOKEN_HEADER/isTrustedOrigin）必须删除
//   P1-4 sessions.scan deep 模式必须有节流（防侦察/DoS）
//   P2-6 CHANGELOG 不得宣称已被推翻的「安全修复」
import fs from 'node:fs';
import path from 'node:path';
import { safeTempDir } from '../src/home.js';
import { absent } from './anchor-lib.mjs';

let passed = 0, failed = 0;
const check = (n, c, d = '') => { if (c) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  ' + d : '')); } };
const W = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(W, f), 'utf8');
// 死代码断言只对代码生效：注释里提到旧名字（如头注释记录删除了什么）是合法的历史说明，
// 算成命中就是断言越界。needle 全由标识符字符组成时必须用 absent() 而不是裸 includes
// —— 后者是子串匹配，未来一个更长的合法标识符（如 appendFileSyncSafe）就会误红。
const codeOnly = (t) => t.split(/\r?\n/).map((l) => {
  const s = l.trimStart();
  if (s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) return '';
  const c = l.indexOf('//');
  return c >= 0 ? l.slice(0, c) : l;
}).join('\n');

console.log('');
console.log('Test 1: index.js 不含调试日志（dsh-rpc-headers.log）');
{
  const i = read('index.js');
  check('no debug log write', !i.includes('dsh-rpc-headers.log'));
  check('appendFileSync not imported', absent(codeOnly(i), 'appendFileSync'), '');
}

console.log('');
console.log('Test 2: frame.check 与 checkFrameable 已删除');
{
  const i = read('index.js');
  check('no frame.check case', !i.includes('frame.check'));
  check('no checkFrameable fn', absent(codeOnly(i), 'checkFrameable'), '');
  const readme = read('README.md');
  check('README no longer advertises frame.check', !readme.includes('frame.check'));
}

console.log('');
console.log('Test 3: rpc-guard 只保留有效接口');
{
  const g = read('src/rpc-guard.js');
  check('no TOKEN_HEADER', absent(codeOnly(g), 'TOKEN_HEADER'), '');
  check('no checkToken', absent(codeOnly(g), 'checkToken'), '');
  check('no isTrustedOrigin', absent(codeOnly(g), 'isTrustedOrigin'), '');
  check('no token field', !g.includes('const token ='));
  check('check() still permissive no-op', /check\(\)\s*\{\s*return\s*\{\s*ok:\s*true\s*\};?\s*\}/.test(g));
  check('DESTRUCTIVE_OPS retained', g.includes('DESTRUCTIVE_OPS'));
  check('checkDestructive retained', g.includes('checkDestructive'));
}

console.log('');
console.log('Test 4: sessions.scan 有节流（deep 扫描缓存）');
{
  const i = read('index.js');
  const seg = i.slice(i.indexOf('case "sessions.scan"'), i.indexOf('case "sessions.repair"'));
  check('scan throttle present', /scanCache|SCAN_THROTTLE|scanThrottle|throttle/i.test(seg), seg.slice(0, 200));
}

console.log('');
console.log('Test 5: CHANGELOG 记录 0.5.95 教训');
{
  const cl = read('CHANGELOG.md');
  check('records the origin-gate lesson', /Origin[\s\S]{0,200}(误伤|绕过|推翻)/.test(cl) || cl.includes('已推翻'));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);