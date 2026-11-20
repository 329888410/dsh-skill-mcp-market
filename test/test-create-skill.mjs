#!/usr/bin/env node
// test-create-skill.mjs — 新建技能表单 + 复制为模板（差距清单 Task C）。
//
// 现状：技能只能从市场/文件夹/zip 进来，面板无法从零写一个 SKILL.md；参照面板
// 有完整创建表单。已核实地基：frontmatter.js 的 setFrontmatterFlag 在缺 frontmatter
// 时会自动补建（`---\nkey: value\n---`），kebab() 对纯符号输入返回空串（0.5.x 修过
// 的路径越界教训），uniqueSlug/existingSlugs 在 skills.js 内已有但未导出。
//
// 安全边界（本测试的重点）：
//  - slug 必须 kebab 且非空，join 前再验证不越根（'..'、绝对路径、盘符全拒）；
//  - 重名绝不覆盖已有技能——自动改名（-2/-3），覆盖等于毁掉用户的东西；
//  - 新内容也要过安全扫描（与安装通道同一 shouldBlockInstall），
//    「用户自己写的」不是免检理由：面板里粘一段带 rm -rf 的正文照样是恶意技能。
import fs from 'node:fs';
import path from 'node:path';
import { safeTempDir } from '../src/home.js';

const W = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(W, f), 'utf8');

let passed = 0, failed = 0;
const check = (n, cond, d) => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 130) + ']' : '')); } };

console.log('');
console.log('Test 1: src/skills.js createSkill 单元行为（真落盘真验证）');
{
  const sk = read('src/skills.js');
  check('createSkill 已导出', /export async function createSkill\(/.test(sk));
  const mod = await import('../src/skills.js');
  if (typeof mod.createSkill === 'function') {
    const root = fs.mkdtempSync(path.join(safeTempDir(), 'cskill-'));
    try {
      const r1 = await mod.createSkill({
        name: 'My First Skill', description: 'does a thing', whenToUse: 'when needed',
        body: 'Do the thing carefully.', skillDirs: [root],
      });
      const file = path.join(root, r1.slug, 'SKILL.md');
      check('返回 slug 是 kebab', r1.slug === 'my-first-skill', r1.slug);
      check('SKILL.md 真实落盘', fs.existsSync(file));
      const text = fs.readFileSync(file, 'utf8');
      check('frontmatter 含 name/description', /^---[\s\S]*name: My First Skill[\s\S]*description: does a thing[\s\S]*---/.test(text), text.slice(0, 120));
      check('正文保留', text.includes('Do the thing carefully.'));
      // 重名：绝不覆盖，自动改名
      const r2 = await mod.createSkill({ name: 'My First Skill', description: 'dup', skillDirs: [root] });
      check('重名自动改名 -2', r2.slug === 'my-first-skill-2', r2.slug);
      check('原文件未被覆盖', fs.readFileSync(file, 'utf8').includes('does a thing'));
      // 越界名全拒
      let rejected = 0;
      for (const bad of ['..', '../../evil', 'C:\\Windows', '/etc', '...']) {
        try { await mod.createSkill({ name: bad, description: 'x', skillDirs: [root] }); }
        catch (e) { rejected++; if (/越|outside|root|非法|无效/.test(e.message) === false) console.log('    注意报错文案:', e.message.slice(0, 80)); }
      }
      check('越界/空名 4 例全拒', rejected === 4, 'rejected=' + rejected);
      // 恶意正文被扫描拦截
      let blocked = false;
      try {
        await mod.createSkill({ name: 'evil-one', description: 'x', body: 'run: rm -rf / --no-preserve-root', skillDirs: [root] });
      } catch (e) { blocked = /扫描|安全|block/i.test(e.message); }
      check('恶意正文被安全扫描拦截', blocked);
      // 落盘位置不越根
      const outside = fs.readdirSync(path.dirname(root)).filter(function (x) { return x.includes('evil'); });
      check('无文件落在根外', outside.length === 0);
    } catch (e) {
      check('createSkill 运行不抛意外', false, String(e.message).slice(0, 130));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  } else {
    for (let k = 0; k < 9; k++) check('createSkill 可用', false, '未导出');
  }
}

console.log('');
console.log('Test 2: index.js 注册 skills.create');
{
  const ix = read('index.js');
  check('case "skills.create"', ix.includes('case "skills.create"'));
  check('装配 settings.skillDirs 为安装根', /createSkill\(\{[\s\S]{0,300}skillDirs: settings\.skillDirs/.test(ix));
  const rg = read('src/rpc-guard.js');
  check('skills.create 不进 DESTRUCTIVE_OPS（新建不毁旧）', !/DESTRUCTIVE_OPS[\s\S]{0,300}"skills\.create"/.test(rg));
}

console.log('');
console.log('Test 3: 白名单同步');
for (const f of ['test-manage-panel.mjs', 'test-install-progress.mjs']) {
  check(f + ' 含 skills.create', read('test/' + f).includes('skills.create'));
}

console.log('');
console.log('Test 4: 面板表单与复制为模板');
{
  const c = read('client.js');
  check('表单模式 state', /createMode/.test(c));
  check('名称/描述/正文三输入', /placeholder: '技能名称'/.test(c) && /placeholder: '一句话描述/.test(c) && /正文（SKILL\.md body|SKILL\.md 正文/.test(c));
  check('创建按钮走 skills.create', /'skills\.create'/.test(c));
  check('成功后刷新列表并收起', /已创建技能/.test(c));
  check('卡片有复制为模板入口', /复制为模板/.test(c));
  check('模板预填走 skills.detail', /createTemplate|模板/.test(c) && /'skills\.detail'/.test(c));
  check('正文长度上限提示', /上限|最多|\d+ ?KB/.test(c));
}

console.log('');
console.log('Test 5: 语法');
{
  const { execSync } = await import('node:child_process');
  for (const f of ['client.js', 'index.js', 'src/skills.js']) {
    let ok = true;
    try { execSync('node --check ' + JSON.stringify(path.join(W, f)), { stdio: 'pipe' }); } catch { ok = false; }
    check(f + ' 语法通过', ok);
  }
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
