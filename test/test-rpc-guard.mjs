#!/usr/bin/env node
// test-rpc-guard.mjs — TDD: RPC 端点必须鉴权；破坏性操作必须二次确认。
// 症状：本机任意进程 POST /api/dsh-market/rpc 无来源校验即返回 200 与全部路径/会话列表。
import fs from 'node:fs';
import { makeRpcGuard, isTrustedOrigin, DESTRUCTIVE_OPS } from '../src/rpc-guard.js';

let passed = 0, failed = 0;
const check = (n, c, d = '') => { if (c) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  ' + d : '')); } };

console.log('');
console.log('Test 1: 只有本机 GUI 来源可信');
{
  check('accepts 127.0.0.1 origin', isTrustedOrigin('http://127.0.0.1:61177'));
  check('accepts localhost origin', isTrustedOrigin('http://localhost:61177'));
  check('rejects remote origin', !isTrustedOrigin('https://evil.example.com'));
  check('rejects file origin', !isTrustedOrigin('file:///C:/x.html'));
  check('rejects empty', !isTrustedOrigin(''));
  check('rejects garbage', !isTrustedOrigin('not a url'));
}

console.log('');
console.log('Test 2: 无来源的请求必须被拒绝（这正是本地任意进程的形态）');
{
  const guard = makeRpcGuard();
  check('rejects no headers at all', guard.check({ headers: {} }).ok === false);
  check('rejects remote origin', guard.check({ headers: { origin: 'https://evil.example.com' } }).ok === false);
  check('accepts loopback origin', guard.check({ headers: { origin: 'http://127.0.0.1:61177' } }).ok === true);
  check('accepts loopback referer without origin', guard.check({ headers: { referer: 'http://127.0.0.1:61177/' } }).ok === true);
}

console.log('');
console.log('Test 3: token 随机且可校验（页面可选加固）');
{
  const a = makeRpcGuard(), b = makeRpcGuard();
  check('two instances differ', a.token !== b.token);
  check('token is long enough', String(a.token).length >= 64);
  check('absent token is tolerated', a.checkToken({ headers: {} }).ok === true);
  check('wrong token is rejected', a.checkToken({ headers: { 'x-dsh-market-token': 'nope' } }).ok === false);
  check('right token is accepted', a.checkToken({ headers: { 'x-dsh-market-token': a.token } }).ok === true);
}

console.log('');
console.log('Test 4: 破坏性操作必须带 confirm:true');
{
  const guard = makeRpcGuard();
  for (const op of DESTRUCTIVE_OPS) {
    check(op + ' without confirm is refused', guard.checkDestructive(op, {}).ok === false);
    check(op + ' with confirm passes', guard.checkDestructive(op, { confirm: true }).ok === true);
  }
}

console.log('');
console.log('Test 5: 只读操作不受 confirm 限制');
{
  const guard = makeRpcGuard();
  for (const op of ['settings.get', 'skills.list', 'skills.search', 'mcp.list']) {
    check(op + ' needs no confirm', guard.checkDestructive(op, {}).ok === true);
  }
}

console.log('');
console.log('Test 6: 面板自己调用破坏性操作时必须带 confirm（否则面板功能会被闸门打断）');
{
  const client = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  check('skills.uninstall passes confirm', /call\('skills\.uninstall',\s*\{[^}]*confirm:\s*true/.test(client));
  check('mcp.uninstall passes confirm', /call\('mcp\.uninstall',\s*\{[^}]*confirm:\s*true/.test(client));
  check('sessions.repair passes confirm when not dryRun', /call\('sessions\.repair',\s*\{[^}]*confirm:\s*!dryRun/.test(client));
}

console.log('');
console.log('Test 7: dryRun 预演不需要确认（只读，不落盘）');
{
  const guard = makeRpcGuard();
  check('dryRun repair is allowed without confirm', guard.checkDestructive('sessions.repair', { dryRun: true }).ok === true);
  check('real repair still needs confirm', guard.checkDestructive('sessions.repair', { dryRun: false }).ok === false);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);