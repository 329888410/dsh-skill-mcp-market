#!/usr/bin/env node
// test-dead-exports.mjs — TDD: src/ 不得存在零外部引用的导出，也不得留着没人调用的函数。
//
// 为什么要有这条锁：本插件的 src/ 模块只被 index.js、client.js、test/ 三方消费。
// 一个导出若在这三处零引用，它就是死代码；留着有两个实际危害——
//   (1) 读代码的人会以为它是对外契约，不敢删、不敢改（本会话就因此多花了三轮核查）；
//   (2) 「已清理」这类 CHANGELOG 承诺无法被证伪——历史上出现过「说做了其实没做」。
// 另有一条反向锁（Test 5）：被 test/ 引用的符号绝不能被「顺手清理」掉，
// 实测教训：buildPosixExportLine 只被 test-security.mjs 引用，生产代码并不用它。
import fs from 'node:fs';
import path from 'node:path';

const W = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(W, f), 'utf8');
const srcFiles = fs.readdirSync(path.join(W, 'src'), { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.js')).map((e) => 'src/' + e.name);
const corpus = { 'index.js': read('index.js'), 'client.js': read('client.js') };
for (const f of srcFiles) corpus[f] = read(f);
for (const e of fs.readdirSync(path.join(W, 'test'), { withFileTypes: true })) if (e.isFile() && e.name.endsWith('.mjs')) corpus['test/' + e.name] = read('test/' + e.name);
for (const f of ['README.md', 'AGENTS.md', 'package.json']) { try { corpus[f] = read(f); } catch {} }
for (const f of fs.readdirSync(path.join(W, 'locale'))) corpus['locale/' + f] = read('locale/' + f);

let passed = 0, failed = 0;
const check = (n, c, d = '') => { if (c) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 120) + ']' : '')); } };

// 收集 src/ 的导出符号（含 export {} 重导出）
function exportsOf(file) {
  const t = corpus[file];
  const out = new Set();
  for (const m of t.matchAll(/^export (?:async )?(?:function|const|let|var|class) (\w+)/gm)) out.add(m[1]);
  for (const m of t.matchAll(/export \{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) { const name = part.trim().split(/\s+as\s+/).pop().trim(); if (name) out.add(name); }
  }
  return [...out];
}
function externalRefs(name, home) {
  let n = 0;
  for (const [f, t] of Object.entries(corpus)) {
    if (f === home) continue;
    n += (t.match(new RegExp('\\b' + name + '\\b', 'g')) || []).length;
  }
  return n;
}
const homeOf = {}; for (const f of srcFiles) for (const s of exportsOf(f)) if (!homeOf[s]) homeOf[s] = f;

console.log('');
console.log('Test 1: 死函数必须彻底消失（连级联私有 helper 一起）');
{
  const all = Object.entries(corpus).filter(([f]) => f.startsWith('src/')).map(([, t]) => t).join('\n');
  for (const s of ['enrichSkillsSh', 'readEnvironmentVariable', 'repoFileIndex', 'locateSkillFile']) {
    // 允许出现在「已删除」说明注释里，因此只禁函数声明形态
    check(s + ' 声明已移除', !new RegExp('(function|const|class)\\s+' + s + '\\b').test(all), 'still declared');
  }
}

console.log('');
console.log('Test 2: 仅本文件使用的符号不得再对外 export');
{
  const INTERNAL = {
    mapLimit: 'src/enrich.js', fetchFileText: 'src/github.js', safeJoin: 'src/github.js',
    BROWSER_HEADERS: 'src/http.js', curlJson: 'src/http.js', pythonJson: 'src/http.js',
    curlPostText: 'src/http.js', pythonPostText: 'src/http.js',
    LOBEHUB_MARKET_BASE: 'src/lobehub-market.js', lobehubCredentialsPath: 'src/lobehub-market.js', registerLobeHubClient: 'src/lobehub-market.js',
    registryCard: 'src/mcp-registry.js', registryQueryUrl: 'src/mcp-registry.js', FALLBACK_SERVERS: 'src/mcp-registry.js',
    browseSkillsSh: 'src/sources.js', searchSkillsSh: 'src/sources.js', searchBrowseSh: 'src/sources.js',
  };
  for (const [s, f] of Object.entries(INTERNAL)) {
    check(s + ' 已改为内部符号', !exportsOf(f).includes(s), 'still exported from ' + f);
    // 收紧不等于删除：函数本体必须还在（被本文件调用）
    check(s + ' 本体仍在（未误删）', new RegExp('(function|const)\\s+' + s + '\\b').test(corpus[f]));
  }
}

console.log('');
console.log('Test 3: 全量扫描——src/ 不存在零外部引用的导出');
{
  const dead = [];
  for (const f of srcFiles) for (const s of exportsOf(f)) { if (externalRefs(s, f) === 0) dead.push(s + '(' + f + ')'); }
  check('零引用导出数 = 0', dead.length === 0, dead.join(', '));
}

console.log('');
console.log('Test 4: 收紧后仍可被正常 import（模块没被改坏）');
{
  const mod = await import('../src/enrich.js');
  check('enrich.js 仍导出 enrichSkillsShFast', typeof mod.enrichSkillsShFast === 'function');
  check('enrich.js 不再导出 mapLimit/enrichSkillsSh', mod.mapLimit === undefined && mod.enrichSkillsSh === undefined);
  const mod2 = await import('../src/sources.js');
  check('sources.js 仍导出 searchSkills/makeCache/ALL_SOURCES', typeof mod2.searchSkills === 'function' && typeof mod2.makeCache === 'function' && Array.isArray(mod2.ALL_SOURCES));
  check('sources.js 不再导出 browseSkillsSh/searchSkillsSh/searchBrowseSh', mod2.browseSkillsSh === undefined && mod2.searchSkillsSh === undefined && mod2.searchBrowseSh === undefined);
  const mod3 = await import('../src/http.js');
  check('http.js 仍导出降级链', typeof mod3.getJsonEscalating === 'function');
  check('http.js 不再导出 curlJson/pythonJson', mod3.curlJson === undefined && mod3.pythonJson === undefined);
}

console.log('');
console.log('Test 5: 反向锁——被测试引用的符号不得被顺手清理掉');
{
  // buildPosixExportLine 生产代码不用，但 test-security.mjs 直接 import 它（实测 ×4 引用）。
  // 若把它当死导出删掉，安全套件会整块崩；这类「只被测试用」的导出必须保留。
  const env = read('src/env.js');
  check('buildPosixExportLine 仍是导出', /export (?:async )?function buildPosixExportLine/.test(env));
  const sec = read('test/test-security.mjs');
  check('test-security 仍 import 它', /buildPosixExportLine/.test(sec));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
