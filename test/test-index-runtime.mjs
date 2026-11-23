#!/usr/bin/env node
// test-index-runtime.mjs — 把 index.js 真的跑起来：假 ctx + 隔离 DSH_HOME，
// 走面板真正注册的那个 handler，逐个调只读 op。
//
// 为什么必须存在：0.5.148 线上崩溃（面板每个 tab 红字 skillsmpCategoryVocabulary
// is not defined，路径 tab 整页空白）在 61 套件全绿的情况下没被抓到。原因是既有套件的
// settings.get 判据全是对 index.js 源码切片跑正则的「文本锁」——文本锁满足 ≠ 代码能跑，
// 缺 import 这种链接期 ReferenceError 永远不会让正则失败。本套件补的就是这条真判据：
// 1) 运行时可达：apply() 不抛、handler 注册成功、settings.get 返回 ok:true；
// 2) 静态链接：index.js 里被调用的 src/ 导出符号必须真的被 import（点名整类缺陷，
//    不只是这一次的两个函数）。
import fs from 'node:fs';
import { safeTempDir } from '../src/home.js';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const W = path.resolve(import.meta.dirname, '..');
let passed = 0, failed = 0;
const check = (n, cond, d) => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + d + ']' : '')); } };

// 隔离：dshHome()/agentsHome() 先看 DSH_HOME / DSH_AGENTS_HOME（src/home.js 实测），
// 所以整套件只碰临时目录，绝不读写真实的 ~/.dsh/market。
// 父目录必须走 safeTempDir()：裸 os.tmpdir() 在没有 TEMP/TMPDIR/TMP 的进程里返回
// 相对串 undefined\temp（0.5.110 CI 实测事故），mkdtempSync 直接 ENOENT。
const home = fs.mkdtempSync(path.join(safeTempDir(), 'dsh-index-home-'));
fs.mkdirSync(path.join(home, 'market', 'skills'), { recursive: true });
fs.mkdirSync(path.join(home, 'market', 'mcp'), { recursive: true });
fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
fs.writeFileSync(path.join(home, 'market', 'settings.json'), JSON.stringify({
  skillDirs: [path.join(home, 'market', 'skills')],
  mcpDirs: [path.join(home, 'market', 'mcp')],
  disabledSkills: [],
  shippedRoot: '',
}, null, 2) + String.fromCharCode(10));
process.env.DSH_HOME = home;
process.env.DSH_AGENTS_HOME = path.join(home, '.agents');

const effects = [];
const registered = [];
const logs = [];
const ctx = {
  config: { get: () => undefined, getAll: () => ({}) },
  logger: { info: (m) => logs.push(['info', String(m)]), warn: (m) => logs.push(['warn', String(m)]), error: (m) => logs.push(['error', String(m)]), debug: (m) => logs.push(['debug', String(m)]) },
  plugin: { dataDir: path.join(home, 'data'), metadata: { id: 'dsh-market' } },
  // 真实宿主语义：ctx.effect(fn) 立刻执行 fn 拿到 disposer（index.js:64 defineTool 就是
  // 靠它注册工具的）。延迟执行会让 webServer.register 永远不被调用，判据就假了。
  effect(fn) { try { effects.push(fn()); } catch (e) { logs.push(['effect-throw', String((e && e.message) || e)]); } },
  tools: { register: () => (() => {}) },
  get(name) {
    if (name === 'webServer') return { register: (r) => registered.push(r) };
    if (name === 'scheduler') return { every: () => (() => {}), daily: () => (() => {}) };
    if (name === 'config') return { get: () => undefined, getAll: () => ({}) };
    return undefined;
  },
};

console.log('Test 1: index.js 真 import + apply');
let mod = null, importErr = '';
try {
  mod = await import(pathToFileURL(path.join(W, 'index.js')).href + '?t=' + Date.now());
} catch (e) { importErr = String((e && e.message) || e); }
check('index.js 可被 import', Boolean(mod), importErr.slice(0, 160));
const plugin = mod && (mod.default ?? mod);
check('导出 apply', typeof (plugin && plugin.apply) === 'function');

let applyErr = '';
try {
  await plugin.apply(ctx, {});
} catch (e) { applyErr = String((e && e.message) || e); }
check('apply(ctx) 不抛', applyErr === '', applyErr.slice(0, 200));
check('面板 RPC 端点注册成功', registered.length === 1, 'registered=' + registered.length);

const route = registered[0] || {};
check('端点路径是 /api/dsh-market/rpc', route.path === '/api/dsh-market/rpc', String(route.path));
check('端点 kind=exact', route.kind === 'exact', String(route.kind));
const handler = route.handler;
check('handler 是 async 函数', typeof handler === 'function');

async function rpc(op, payload) {
  const res = { code: 0, body: '', writeHead(c) { this.code = c; }, end(b) { this.body = String(b || ''); } };
  const req = {
    method: 'POST',
    url: '/api/dsh-market/rpc',
    headers: { 'content-type': 'application/json' },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ op, ...(payload || {}) })); },
  };
  let thrown = '';
  try { await handler(req, res); } catch (e) { thrown = String((e && e.message) || e); }
  let json = null;
  try { json = JSON.parse(res.body); } catch {}
  return { json, thrown, status: res.code };
}

console.log('');
import zlib from 'node:zlib';
{
  const { makeCache } = await import(pathToFileURL(path.join(W, 'src', 'sources.js')).href);
  const es = await import(pathToFileURL(path.join(W, 'src', 'extra-sources.js')).href);
  const page = zlib.gunzipSync(fs.readFileSync(path.join(W, 'test', 'fixtures', 'skillsmp-categories.html.gz'))).toString('utf8');
  const seeded = await es.skillsmpCategoryVocabulary({ cache: makeCache(path.join(home, 'market', 'cache')), getText: async () => ({ text: page }) });
  check('夹具词表已写入本次隔离缓存', Boolean(seeded && seeded.categories && seeded.categories.length === 63), '实际=' + (seeded && seeded.categories ? seeded.categories.length : String(seeded)));
}

console.log('Test 2: settings.get 运行时可达（0.5.148 崩溃点）');
const sg = await rpc('settings.get');
check('settings.get 不抛', sg.thrown === '', sg.thrown.slice(0, 160));
check('settings.get 返回 ok:true', sg.json && sg.json.ok === true, sg.json ? String(sg.json.error).slice(0, 160) : 'body 不是 JSON：' + sg.body);
  // handler 返回体是 { ok:true, ...dispatch(...) }：业务字段与 ok 同级（client.js call() 同语义）
  const d = sg.json || {};
check('settings.get 带 settings.skillDirs', Boolean(d.settings && Array.isArray(d.settings.skillDirs)));
check('settings.get 带 settings.homeDir', Boolean(d.settings && typeof d.settings.homeDir === 'string' && d.settings.homeDir.length > 0));
check('settings.get 带 sortCapabilities 三键', Boolean(d.sortCapabilities && d.sortCapabilities.keys && d.sortCapabilities.skills && d.sortCapabilities.mcp));
// 词表载体：夹具真实页面经模块自己的键写进本次隔离缓存，settings.get 必须把它带回来。
// （冷缓存时键会被 JSON.stringify 丢掉，所以只能这样锁：有数据就必须出现，
//   删掉 categoryVocabulary 字段 / 删掉读取调用 / 键名不一致 都会让这条 FAIL。）
  const cv = d.categoryVocabulary;
  const cvDetail = '实际=' + String(cv && Array.isArray(cv.categories) ? cv.categories.length : JSON.stringify(cv === undefined ? '(字段缺失)' : cv)).slice(0, 90);
  // 0.5.153 起 categoryVocabulary 是按源分组（{skillsmp, clawhub}），播种只给了 skillsmp。
  check('词表通道按源分组带回 63 条分类', Boolean(cv && cv.skillsmp && Array.isArray(cv.skillsmp.categories) && cv.skillsmp.categories.length === 63), cvDetail);
check('settings.get 带 shipped 段', Boolean(d.shipped));

console.log('');
console.log('Test 3: 其余只读 op 运行时可达');
const list = await rpc('skills.list');
check('skills.list ok:true', Boolean(list.json && list.json.ok), list.json ? String(list.json.error).slice(0, 140) : '非 JSON');
const ml = await rpc('mcp.list');
check('mcp.list ok:true', Boolean(ml.json && ml.json.ok), ml.json ? String(ml.json.error).slice(0, 140) : '非 JSON');
const ms = await rpc('mcp.status');
check('mcp.status ok:true', Boolean(ms.json && ms.json.ok), ms.json ? String(ms.json.error).slice(0, 140) : '非 JSON');
const unk = await rpc('no.such.op');
check('未知 op 报 unknown operation', Boolean(unk.json && unk.json.ok === false && /unknown operation/.test(String(unk.json.error))), String(unk.json && unk.json.error).slice(0, 120));
const rawSet = await rpc('mcp.raw.set', { serverName: 'x', definition: '{}' });
check('破坏性 op 无 confirm 被拒', Boolean(rawSet.json && rawSet.json.ok === false && /confirm|二次确认/.test(String(rawSet.json.error))), String(rawSet.json && rawSet.json.error).slice(0, 120));

console.log('');
console.log('Test 4: 静态链接——被调用的 src 导出符号必须已 import');
const ixSrc = fs.readFileSync(path.join(W, 'index.js'), 'utf8');
// index.js 自己声明的名字（import / function / const / let / class）
const declared = new Set();
for (const m of ixSrc.matchAll(/import\s*\{([^}]*)\}\s*from/g)) for (const p of m[1].split(',')) { const n = p.trim().split(/\s+as\s+/).pop(); if (n) declared.add(n.trim()); }
for (const m of ixSrc.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from/g)) declared.add(m[1]);
for (const m of ixSrc.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
for (const m of ixSrc.matchAll(/(?:^|[\s;{(])(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) declared.add(m[1]);
for (const m of ixSrc.matchAll(/(?:^|[\s;{(])(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) declared.add(m[1]);
for (const m of ixSrc.matchAll(/(?:^|[\s;{(])(?:const|let|var)\s*\{([^}]*)\}\s*=/gm)) for (const p of m[1].split(',')) { const n = p.split(':').pop().trim().split(/\s+as\s+/).pop(); if (n && /^[A-Za-z_$]/.test(n)) declared.add(n); }

const srcDir = path.join(W, 'src');
const exported = new Map();
for (const f of fs.readdirSync(srcDir).filter((x) => x.endsWith('.js'))) {
  const t = fs.readFileSync(path.join(srcDir, f), 'utf8');
  for (const m of t.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) exported.set(m[1], f);
  for (const m of t.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) exported.set(m[1], f);
  for (const m of t.matchAll(/^export\s*\{([^}]*)\}/gm)) for (const p of m[1].split(',')) { const n = p.trim().split(/\s+as\s+/).pop(); if (n && /^[A-Za-z_$][\w$]*$/.test(n)) exported.set(n, f); }
}
const globals = new Set(['fetch', 'structuredClone', 'require', 'setTimeout', 'setInterval', 'clearTimeout', 'encodeURIComponent', 'decodeURIComponent']);
const missing = [];
for (const [name, file] of exported) {
  if (declared.has(name) || globals.has(name)) continue;
  const callRe = new RegExp('(?<![.\\w$])' + name.replace(/\$/g, '\\$') + '\\s*\\(');
  if (callRe.test(ixSrc)) missing.push(name + '（来自 src/' + file + '）');
}
check('index.js 没有调用未导入的 src 导出符号', missing.length === 0, missing.join(', ').slice(0, 300));
const importLine = (ixSrc.match(/import\s*\{[^}]*\}\s*from\s"\.\/src\/extra-sources\.js"/) || [''])[0];
check('词表两函数已从 ./src/extra-sources.js 导入', /readSkillsMpCategoryVocabulary/.test(importLine) && /skillsmpCategoryVocabulary/.test(importLine), importLine.slice(0, 160) || 'index.js 无 extra-sources import');

console.log('');
console.log('Test 5: disposer 全可执行（卸载不抛）');
let disposerErrs = 0;
for (const f of effects) { try { if (typeof f === 'function') f(); } catch { disposerErrs++; } }
check('disposer 无异常', disposerErrs === 0, '抛错数=' + disposerErrs);
check('apply 期间无 effect 抛错', !logs.some((l) => l[0] === 'effect-throw'), logs.filter((l) => l[0] === 'effect-throw').map((l) => l[1]).join(',').slice(0, 160));

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
