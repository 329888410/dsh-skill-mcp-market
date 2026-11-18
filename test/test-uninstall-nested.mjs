#!/usr/bin/env node
// test-uninstall-nested.mjs — TDD: 卸载必须能找到 @owner/slug 两层目录。
// 症状：lgd-skill-review 装在 <root>/@owner/<slug>/，uninstallSkill 只试 <root>/<slug>，
// 于是 RPC 返回 { ok:false, removed: [] }，面板点卸载没有任何反应。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listInstalledSkills, uninstallSkill, skillFileToggleable, toggleSkillFile } from '../src/skills.js';
import { readSkillBody } from '../src/provider.js';

let passed = 0, failed = 0;
const check = (n, c, d = '') => { if (c) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  ' + d : '')); } };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-uninst-'));
const trash = path.join(root, '.trash');
const mk = (rel) => {
  const d = path.join(root, rel);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), '---\nname: ' + path.basename(rel) + '\ndescription: t\n---\nb');
};
mk('flat-skill');
mk('@someowner/nested-skill');

console.log('');
console.log('Test 1: 两层目录里的技能必须能被列出来');
{
  const found = await listInstalledSkills([root]);
  const slugs = found.map((s) => s.slug).sort();
  check('flat listed', slugs.includes('flat-skill'));
  check('nested listed', slugs.includes('nested-skill'));
}

console.log('');
console.log('Test 2b: 两层目录里的技能必须能查详情、能开关');
{
  const body = await readSkillBody([root], 'nested-skill');
  check('detail found for nested', Boolean(body && body.raw), JSON.stringify(body && body.path));
  check('fileToggleable true for nested', await skillFileToggleable([root], 'nested-skill'));
  const off = await toggleSkillFile({ dirs: [root], slug: 'nested-skill', enabled: false }).catch((e) => ({ err: e.message }));
  check('toggle works for nested', !off || !off.err, JSON.stringify(off).slice(0, 80));
}

console.log('');
console.log('Test 2: 两层目录里的技能必须能被卸载');
{
  const r = await uninstallSkill({ slug: 'nested-skill', dirs: [root], trashDir: trash });
  check('removed reports the skill', (r.removed || []).length === 1, JSON.stringify(r));
  check('directory is gone', !fs.existsSync(path.join(root, '@someowner/nested-skill')));
  check('moved into trash', fs.existsSync(trash) && fs.readdirSync(trash).some((f) => f.startsWith('nested-skill')));
}

console.log('');
console.log('Test 3: 一层目录仍可卸载');
{
  const r = await uninstallSkill({ slug: 'flat-skill', dirs: [root], trashDir: trash });
  check('flat removed', (r.removed || []).length === 1, JSON.stringify(r));
  check('flat dir gone', !fs.existsSync(path.join(root, 'flat-skill')));
}

console.log('');
console.log('Test 4: 卸载后列表不再包含它');
{
  const after = await listInstalledSkills([root]);
  check('flat gone from list', !after.some((s) => s.slug === 'flat-skill'));
  check('nested gone from list', !after.some((s) => s.slug === 'nested-skill'));
}

fs.rmSync(root, { recursive: true, force: true });
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);