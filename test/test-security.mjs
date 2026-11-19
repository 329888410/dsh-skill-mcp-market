#!/usr/bin/env node
// test-security.mjs — TDD: 落盘路径与外部环境写入必须拒绝不可信输入。
import path from 'node:path';
import { safeTempDir } from '../src/home.js';
import { kebab } from '../src/frontmatter.js';

let passed = 0, failed = 0;
const check = (n, c, d = '') => { if (c) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  ' + d : '')); } };

// 平台中立：CI 跑在 ubuntu-latest，不能有盘符
const ROOT = path.join(safeTempDir(), 'dsh-skills-root');
const skills = await import('../src/skills.js');
const { safeInstallSlug, resolveInsideRoot } = skills;
const resolveInside = (root, slug) => resolveInsideRoot(root, safeInstallSlug(slug));

console.log('');
console.log('Test 1: traversal slugs must be rejected');
// 纯穿越值必须被拒；含路径段但可净化的必须收敛到根目录内（两者都是安全结果）
const MUST_REJECT = ['..', '//..//', '///'];
for (const bad of MUST_REJECT) {
  let threw = false;
  try { resolveInside(ROOT, bad); } catch (e) { threw = true; }
  check('rejects ' + JSON.stringify(bad), threw);
}
const MUST_CONTAIN = ['a/../../b', '../../etc'];
for (const tricky of MUST_CONTAIN) {
  let out = '';
  try { out = resolveInside(ROOT, tricky); } catch (e) { out = 'THREW'; }
  const inside = typeof out === 'string' && out.indexOf(path.resolve(ROOT) + path.sep) === 0;
  check('contains ' + JSON.stringify(tricky) + ' inside root', inside, out);
}

console.log('');
console.log('Test 2: legal slugs resolve inside the root');
for (const good of ['normal-skill', 'My Skill']) {
  let out = '';
  try { out = resolveInside(ROOT, good); } catch (e) { out = 'THREW'; }
  check('accepts ' + JSON.stringify(good), out.indexOf(path.resolve(ROOT) + path.sep) === 0, out);
}

console.log('');
console.log('Test 3: empty-after-kebab must throw');
{
  let threw = false;
  try { resolveInside(ROOT, '///'); } catch (e) { threw = true; }
  check('rejects empty-after-kebab', threw);
}

console.log('');
console.log('Test 4: POSIX export line must not allow command expansion');
{
  const env = await import('../src/env.js');
  check('exports buildPosixExportLine', typeof env.buildPosixExportLine === 'function');
  if (typeof env.buildPosixExportLine === 'function') {
    const line = env.buildPosixExportLine('MYVAR', 'x$(id)`whoami`');
    check('uses single quotes', line.indexOf("MYVAR='") !== -1, line);
    check('no bare double-quote wrapping the value', line.indexOf('"x"') === -1, line);
  }
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);