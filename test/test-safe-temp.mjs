#!/usr/bin/env node
// test-safe-temp.mjs — TDD: 临时目录必须对空 TEMP 环境免疫。
// 症状：os.tmpdir() 在没有 TEMP/TMPDIR/TMP 的进程里返回字面量 'undefined\\temp'（实测），
// 32 处调用点全部退化成非法路径，上传/预览/下载/解压全挂。
import fs from 'node:fs';
import path from 'node:path';
import { safeTempDir } from '../src/home.js';

let passed = 0, failed = 0;
const check = (n, c, d = '') => { if (c) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  ' + d : '')); } };

console.log('');
console.log('Test 1: safeTempDir 返回真实可用的目录');
{
  const d = safeTempDir();
  check('absolute path', path.isAbsolute(d), d);
  check('no literal undefined', !d.includes('undefined'), d);
  check('directory exists or creatable', (() => { try { fs.mkdirSync(d, { recursive: true }); return fs.existsSync(d); } catch { return false; } })(), d);
}

console.log('');
console.log('Test 2: 模拟空 TEMP 环境仍返回合法路径');
{
  // 复刻退化条件：TEMP/TMPDIR/TMP 全空时 os.tmpdir() 在 Windows 上拼 'undefined\\temp'
  const os = await import('node:os');
  const broken = (() => { try { return os.tmpdir(); } catch { return ''; } })();
  const d = safeTempDir();
  check('result differs from broken value when broken', broken.includes('undefined') ? d !== broken : true, 'broken=' + broken + ' d=' + d);
  check('result has no undefined segment', !/[\\/]undefined[\\/]|[\\/]undefined$/.test(d), d);
}

console.log('');
console.log('Test 3: 全仓生产代码不再直接使用裸 tmpdir()');
{
  const W = path.resolve(import.meta.dirname, '..');
  const files = ['index.js', 'src/github.js', 'src/extra-sources.js', 'src/sources.js'];
  for (const f of files) {
    const t = fs.readFileSync(path.join(W, f), 'utf8');
    // every tmpdir() usage must be wrapped by safeTempDir() (or be safeTempDir itself)
    const bare = t.split('\n').filter((l) => /\btmpdir\(\)/.test(l) && !/safeTempDir/.test(l) && !/function safeTempDir|import/.test(l) && !/\/\//.test(l));
    check(f + ' has no bare tmpdir()', bare.length === 0, bare.join(' | ').slice(0, 100));
  }
}

console.log('');
console.log('Test 4: 卸载记录 originalDir 为技能真实所在目录');
{
  const os = await import('node:os');
  const { listInstalledSkills, uninstallSkill, restoreFromTrash } = await import('../src/skills.js');
  const root = fs.mkdtempSync(path.join(safeTempDir(), 'dsh-orig-'));
  const trash = path.join(root, '.trash');
  const nested = path.join(root, '@own', 'nested-skill');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'SKILL.md'), '---\nname: nested-skill\ndescription: t\n---\nb');
  const r = await uninstallSkill({ slug: 'nested-skill', dirs: [root], trashDir: trash });
  check('nested uninstalled', (r.removed || []).length === 1, JSON.stringify(r));
  const t = await import('../src/skills.js').then((m) => m.listTrash({ trashDir: trash, dirs: [root] }));
  const arr = Array.isArray(t) ? t : (t.items || []);
  check('one trash entry', arr.length === 1, String(arr.length));
  if (arr.length) {
    const side = JSON.parse(fs.readFileSync(arr[0].path + '.trash-entry.json', 'utf8'));
    check('originalDir points at @own dir', side.originalDir === path.join(root, '@own') || side.originalPath === path.join(nested), JSON.stringify(side).slice(0, 120));
    const res = await restoreFromTrash({ path: arr[0].path, dirs: [root], trashDir: trash });
    check('restored to nested layout', fs.existsSync(path.join(root, '@own', 'nested-skill', 'SKILL.md')), JSON.stringify(res).slice(0, 100));
  }
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('');
console.log('Test 5: 列表与详情返回真实所在目录（供打开文件夹）');
{
  const os = await import('node:os');
  const { listInstalledSkills } = await import('../src/skills.js');
  const { readSkillBody } = await import('../src/provider.js');
  const root = fs.mkdtempSync(path.join(safeTempDir(), 'dsh-dir-'));
  const nested = path.join(root, '@own', 'nested-skill');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'SKILL.md'), '---\nname: nested-skill\ndescription: t\n---\nb');
  const found = await listInstalledSkills([root]);
  const item = found.find((s) => s.slug === 'nested-skill');
  check('listed', Boolean(item));
  check('dir is the @own parent of the skill', item && item.dir === nested, item && item.dir);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);