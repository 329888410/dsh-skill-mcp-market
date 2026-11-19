#!/usr/bin/env node
// test-nested-update.mjs — TDD: 编辑 clawhub 两层布局（@owner/slug）的技能。
//
// 0.5.97 的提交信息是「unify nested @owner layout across uninstall/detail/toggle」——
// 它统一了三处，漏了第四处 updateSkill。实测（本套件复现）：
//   <root>/@acme/my-tool/SKILL.md  →  listInstalledSkills 看得见、readSkillBody 能读、
//   toggleSkillFile 能开关、uninstallSkill 能删，但 updateSkill 抛「未找到技能 my-tool」。
// 面板表现：用户编辑一个 clawhub CLI 装的技能并保存 → 报错，改不动。
// 修法：复用同文件已有的 resolveSkillFile（它已处理一层与两层两种布局）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listInstalledSkills, updateSkill, toggleSkillFile, uninstallSkill } from '../src/skills.js';

let passed = 0, failed = 0;
const check = (n, c, d = '') => { if (c) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 90) + ']' : '')); } };

const root = fs.mkdtempSync(path.join(os.tmpdir() || '.', 'dsh-nested-upd-'));
const slugDir = path.join(root, '@acme', 'my-tool');
fs.mkdirSync(slugDir, { recursive: true });
const file = path.join(slugDir, 'SKILL.md');
const ORIGINAL = '---\nname: my-tool\ndescription: original text\n---\n\nbody here\n';
fs.writeFileSync(file, ORIGINAL, 'utf8');

console.log('');
console.log('Test 1: 同一技能在四种操作下的可达性必须一致（缺陷锁）');
{
  const list = await listInstalledSkills([root]);
  const items = Array.isArray(list) ? list : (list.items || []);
  check('list 能看见', items.some((x) => x.slug === 'my-tool'));
  let toggleErr = '', updateErr = '';
  try { await toggleSkillFile({ dirs: [root], slug: 'my-tool', enabled: false }); } catch (e) { toggleErr = String(e.message); }
  check('toggle 能改', !toggleErr, toggleErr);
  try { await toggleSkillFile({ dirs: [root], slug: 'my-tool', enabled: true }); } catch (e) { /* restore */ }
  try { await updateSkill({ dirs: [root], slug: 'my-tool', name: 'my-tool', description: 'CHANGED', body: 'new body' }); }
  catch (e) { updateErr = String(e.message); }
  check('update 能改（当前失败 → 本测试为 RED）', !updateErr, updateErr || 'ok');
}

console.log('');
console.log('Test 2: 更新真实写入嵌套文件，且保留其它 frontmatter 键');
{
  fs.writeFileSync(file, '---\nname: my-tool\ndescription: original text\nlicense: MIT\n---\n\nold body\n', 'utf8');
  let err = '';
  try { await updateSkill({ dirs: [root], slug: 'my-tool', name: 'my-tool', description: 'NEW-DESC', body: 'new body' }); }
  catch (e) { err = String(e.message); }
  if (err) { check('update 成功', false, err); }
  else {
    const now = fs.readFileSync(file, 'utf8');
    check('描述已写入', now.includes('NEW-DESC'));
    check('正文已替换', now.includes('new body') && !now.includes('old body'));
    check('无关键 license 保留', /license:\s*MIT/.test(now), now.replace(/\n/g, '\\n').slice(0, 80));
    check('文件仍在嵌套位置（没被搬到扁平目录）', fs.existsSync(file));
    check('没有生成扁平副本', !fs.existsSync(path.join(root, 'my-tool', 'SKILL.md')));
  }
}

console.log('');
console.log('Test 3: 一层布局（回归保护，不得被改坏）');
{
  const flat = fs.mkdtempSync(path.join(os.tmpdir() || '.', 'dsh-flat-upd-'));
  const fdir = path.join(flat, 'flat-skill');
  fs.mkdirSync(fdir, { recursive: true });
  fs.writeFileSync(path.join(fdir, 'SKILL.md'), '---\nname: flat-skill\ndescription: d1\n---\n\nb1\n', 'utf8');
  try {
    await updateSkill({ dirs: [flat], slug: 'flat-skill', name: 'flat-skill', description: 'FLAT-NEW', body: 'b2' });
    const now = fs.readFileSync(path.join(fdir, 'SKILL.md'), 'utf8');
    check('一层布局仍可更新', now.includes('FLAT-NEW'), now.replace(/\n/g, '\\n').slice(0, 60));
  } catch (e) { check('一层布局仍可更新', false, String(e.message)); }
  fs.rmSync(flat, { recursive: true, force: true });
}

console.log('');
console.log('Test 4: 不存在的技能仍必须报错（不得静默成功）');
{
  let threw = false;
  try { await updateSkill({ dirs: [root], slug: 'no-such-skill', name: 'x', description: 'y', body: 'z' }); }
  catch (e) { threw = true; }
  check('缺失技能抛错', threw);
}

uninstallSkill({ dirs: [root], slug: 'my-tool' }).catch(() => {});
fs.rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);