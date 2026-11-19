#!/usr/bin/env node
// test-func-fixes.mjs — TDD: 本轮功能缺陷的回归测试。
// 1) TrustTools 上游参数应为 search（不是 q），查询必须真正生效。
// 2) 安装落在 @owner/slug/ 两层目录，listInstalledSkills 必须能看见。
// 3) searchSkills 必须接受并真正应用 category（切页前过滤）。
// 4) 客户端切源时必须重置分类，避免陈旧条件导致空列表。
import fs from 'node:fs';
import path from 'node:path';
import { safeTempDir } from '../src/home.js';
import { listInstalledSkills } from '../src/skills.js';
import { searchSkills, makeCache } from '../src/sources.js';

let passed = 0, failed = 0, skipped = 0;
const check = (n, c, d = '') => { if (c) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  ' + d : '')); } };
const skip = (n) => { skipped++; console.log('  SKIP ' + n); };

const W = path.resolve(import.meta.dirname, '..');

console.log('');
console.log('Test 1: TrustTools 传上游的参数名必须是 search');
{
  const src = fs.readFileSync(path.join(W, 'src/extra-sources.js'), 'utf8');
  const seg = src.slice(src.indexOf('export async function searchTrustTools'));
  const call = seg.slice(0, seg.indexOf('const batch'));
  check('posts search: query', /search:\s*query/.test(call), 'still q:');
  check('no longer posts q: query', !/\bq:\s*query/.test(call));
}

console.log('');
console.log('Test 2: listInstalledSkills 能识别 @owner/slug 两层目录');
{
  const root = fs.mkdtempSync(path.join(safeTempDir(), 'dsh-inst-'));
  const mk = (rel) => {
    const d = path.join(root, rel);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'SKILL.md'), '---\nname: ' + path.basename(rel) + '\ndescription: test\n---\nbody');
  };
  mk('flat-skill');                 // 一层
  mk('@someowner/nested-skill');    // clawhub CLI 的两层布局
  const found = await listInstalledSkills([root]);
  const slugs = found.map((s) => s.slug).sort();
  check('finds flat skill', slugs.includes('flat-skill'), slugs.join(','));
  check('finds @owner/nested skill', slugs.includes('nested-skill'), slugs.join(','));
  check('no duplicate entries', slugs.length === new Set(slugs).size);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('');
console.log('Test 3: searchSkills 接受 category 并在切页前过滤');
{
  const sig = fs.readFileSync(path.join(W, 'src/sources.js'), 'utf8');
  check('signature declares category', /export async function searchSkills\(\{[^}]*category/.test(sig));
  const cache = makeCache(path.join(safeTempDir(), 'dsh-cat-' + Date.now()));
  let r1, r2, err = null;
  try {
    r1 = await searchSkills({ query: '', source: 'lobehub', page: 1, pageSize: 24, cache });
    const cat = (r1.items.find((i) => i.category) || {}).category;
    if (!cat) { skip('lobehub returned no categories'); }
    else {
      r2 = await searchSkills({ query: '', source: 'lobehub', page: 1, pageSize: 24, cache, category: cat });
      check('filtered page only contains that category', r2.items.every((i) => !i.category || i.category === cat), JSON.stringify(r2.items.map(i=>i.category)));
      check('filter actually narrows or keeps a subset', r2.items.length <= r1.items.length);
    }
  } catch (e) { err = e; }
  if (err) skip('lobehub unreachable: ' + String(err.message).slice(0, 40));
}

console.log('');
console.log('Test 4: 客户端切源时重置分类');
{
  const c = fs.readFileSync(path.join(W, 'client.js'), 'utf8');
  const seg = c.slice(c.indexOf('setSource(key)') - 200, c.indexOf('setSource(key)') + 200);
  check('switching source resets category to all', /setSource\(key\)[\s\S]{0,160}setCategory\(['"]all['"]\)/.test(seg), seg.slice(0, 120));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
process.exit(failed ? 1 : 0);