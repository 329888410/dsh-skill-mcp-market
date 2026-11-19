#!/usr/bin/env node
// test-rpc-guard.mjs — TDD: 破坏性操作确认契约 + 死代码不得复活。
// 注意：0.5.95 的 Origin 边界已被推翻（见 rpc-guard.js 头注释），
// 本套件不再测试任何「来源判定」，只测真正生效的 confirm 契约。
import fs from 'node:fs';
import path from 'node:path';
import { safeTempDir } from '../src/home.js';
import { makeRpcGuard, DESTRUCTIVE_OPS } from '../src/rpc-guard.js';

let passed = 0, failed = 0;
const check = (n, c, d = '') => { if (c) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  ' + d : '')); } };

console.log('');
console.log('Test 1: 死代码不得复活');
{
  const g = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src/rpc-guard.js'), 'utf8');
  check('no token machinery', !g.includes('randomBytes') && !g.includes('timingSafeEqual'));
  check('no origin gate', !g.includes('isTrustedOrigin'));
  check('lesson recorded in header', g.includes('误伤') || g.includes('绕过'));
}

console.log('');
console.log('Test 2: check() 恒通过（面板请求不带 Origin 也必须放行）');
{
  const guard = makeRpcGuard();
  check('no headers passes', guard.check({ headers: {} }).ok === true);
  check('null origin passes', guard.check({ headers: { origin: null } }).ok === true);
}

console.log('');
console.log('Test 3: 破坏性操作必须带 confirm:true');
{
  const guard = makeRpcGuard();
  for (const op of DESTRUCTIVE_OPS) {
    check(op + ' without confirm is refused', guard.checkDestructive(op, {}).ok === false);
    check(op + ' with confirm passes', guard.checkDestructive(op, { confirm: true }).ok === true);
  }
}

console.log('');
console.log('Test 4: 只读操作不受 confirm 限制');
{
  const guard = makeRpcGuard();
  for (const op of ['settings.get', 'skills.list', 'skills.search', 'mcp.list', 'sessions.scan']) {
    check(op + ' needs no confirm', guard.checkDestructive(op, {}).ok === true);
  }
}

console.log('');
console.log('Test 5: 面板调用破坏性操作时必须带 confirm（否则面板功能被闸门打断）');
{
  const c = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'client.js'), 'utf8');
  check('skills.uninstall passes confirm', /call\('skills\.uninstall',\s*\{[^}]*confirm:\s*true/.test(c));
  check('mcp.uninstall passes confirm', /call\('mcp\.uninstall',\s*\{[^}]*confirm:\s*true/.test(c));
  check('sessions.repair passes confirm when not dryRun', /call\('sessions\.repair',\s*\{[^}]*confirm:\s*!dryRun/.test(c));
}

console.log('');
console.log('Test 6: dryRun 预演不需要确认（只读，不落盘）');
{
  const guard = makeRpcGuard();
  check('dryRun repair allowed without confirm', guard.checkDestructive('sessions.repair', { dryRun: true }).ok === true);
  check('real repair needs confirm', guard.checkDestructive('sessions.repair', { dryRun: false }).ok === false);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);