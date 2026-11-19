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
console.log('Test 2b: 三条分支全失败时，兜底不得返回不存在的目录（0.5.110 CI 实测回归）');
{
  // 0.5.110 CI：ubuntu runner 报 mkdtemp '/home/runner/.dsh/tmp/dsh-mcp-trash-XXXXXX' ENOENT。
  // 根因：safeTempDir 的最后兜底 join(dshHome(),'tmp') 在 mkdirSync 失败后**仍然 return**，
  // 违反 Test 1 锁定的「存在或可创建」契约。5 个套件直接 mkdtempSync(safeTempDir()) 全部暴露。
  //
  // 为什么用源码桩而不是改 env：Windows 上 os.tmpdir() 由系统目录决定，env 掐不掉它；
  // 覆盖 SystemRoot 会让子进程 node 直接起不来（实测 exit 134）。所以把 home.js 的
  // tmpdir 导入替换成返回破损值的桩、并把 dshHome 指向非法卷，写进临时副本再 import ——
  // 三条分支同时失败，确定性地逼出兜底，跨平台一致。
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'home.js'), 'utf8');
  // 非法 HOME 必须按平台选：Windows 用不存在的盘符（mkdirSync 失败），
  // POSIX 用 /dev/null/impossible（字符设备下创建子目录必然 ENOTDIR）。
  // 教训：0.5.111 的 CI 红灯正是本测试自己造成的 —— ubuntu 上 'Q:\\nonexistent-vol-dsh'
  // 的反斜杠是合法文件名字符，mkdirSync 真的建出了这个**相对**目录，兜底于是成功返回，
  // isAbsolute 判假。桩路径必须让「创建失败」在每个平台上都成立。
  const badHome = process.platform === 'win32' ? 'Q:\\\\nonexistent-vol-dsh' : '/dev/null/impossible';
  const stubbed = src
    .replace('import { tmpdir } from "node:os";', 'const tmpdir = () => "undefined\\\\temp";')
    .replace('import { homedir } from "node:os";', 'const homedir = () => ' + JSON.stringify(badHome) + ';');
  check('桩替换到位（tmpdir 与 homedir 都被替换）',
    /const tmpdir = \(\) =>/.test(stubbed) && new RegExp('const homedir = \\(\\) =>').test(stubbed),
    'home.js 的导入行格式变了，请同步本测试');
  const tmp = fs.mkdtempSync(path.join(safeTempDir(), 'dsh-stub-'));
  const file = path.join(tmp, 'home-stub.mjs');
  fs.writeFileSync(file, stubbed, 'utf8');
  const { safeTempDir: stubbedSafeTempDir } = await import('file:///' + file.split(String.fromCharCode(92)).join('/'));
  const saved = {};
  for (const k of ['DSH_TMP', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'DSH_HOME']) { saved[k] = process.env[k]; delete process.env[k]; }
  let d;
  try { d = stubbedSafeTempDir(); } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
  let ok = false; try { fs.mkdirSync(d, { recursive: true }); ok = fs.existsSync(d); } catch { ok = false; }
  check('兜底绝不返回不可创建的目录', ok === true, d);
  check('返回值是绝对路径', path.isAbsolute(d), d);
  check('不含 undefined 字面量', !/[\\/]undefined[\\/]|[\\/]undefined$/.test(d), d);
  // 防假绿：必须证明三条分支真的全失败、走到了最后退路（cwd/.dsh-tmp）。
  // 若桩没生效（例如某平台上非法路径其实可创建），兜底会成功返回，
  // 上面三条断言照样全过 —— 那就测不到本次修复的靶心。
  check('确实走到最后退路（证明三条分支全失败）', d.endsWith('.dsh-tmp') || d.endsWith(String.fromCharCode(46) + 'dsh-tmp'), d);
  fs.rmSync(tmp, { recursive: true, force: true });
  // 桩走到最后退路时会在 cwd 创建 .dsh-tmp（HOME/温度全不可用的病态场景）——
  // 测试必须自清理，否则每次跑套件都在仓库根目录留一个空目录。
  try { fs.rmSync(path.resolve(import.meta.dirname, '..', '.dsh-tmp'), { recursive: true, force: true }); } catch {}
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