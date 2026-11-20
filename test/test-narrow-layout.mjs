#!/usr/bin/env node
// test-narrow-layout.mjs — 窄屏自适应（差距清单：窄屏与三栏布局自适应的一半——我们本来就没有三栏，
// 所以这一项的真实内容是「面板被宿主侧栏挤窄时不溢出」）。
//
// 实测现状：client.js 完全没有窄屏处理（无 ResizeObserver / matchMedia / innerWidth），而
// 技能工具行（input minWidth120 + select 96 + 按钮×2 ≈ 420px）和批量条（6 控件 ≈ 400px）
// 都写死 flexWrap:'nowrap' —— 宿主左侧会话栏一展开或手机远控时，这些行直接横向溢出裁切。
//
// 参照的双层判据（client.ts:1796-1824，Issue #71）：视口宽供首帧直接用（不闪一下），
// 面板宽由 ResizeObserver 事后校准——「窗口宽 ≠ 面板宽」是这里的物理事实，只按窗口判断
// 会在 900-1100px 窗口下漏掉（那时面板只有 ~650px）。本实现照抄这个判据结构。
import fs from 'node:fs';
import path from 'node:path';

const W = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(W, f), 'utf8');
const c = read('client.js');

let passed = 0, failed = 0;
const check = (n, cond, d) => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 130) + ']' : '')); } };

console.log('');
console.log('Test 1: 双层判据（视口首帧 + 面板宽校准）');
{
  check('视口阈值常量', /NARROW_VIEWPORT_WIDTH = \d{3,4}/.test(c));
  check('面板阈值常量', /NARROW_PANEL_WIDTH = \d{3,4}/.test(c));
  check('matchMedia 首帧判据', /window\.matchMedia/.test(c));
  check('matchMedia 缺失时降级 false（不崩）', /typeof window\.matchMedia !== 'function'\) return false/.test(c));
  check('ResizeObserver 校准面板宽', /new ResizeObserver\(measure\)/.test(c));
  check('ResizeObserver 缺失时仍测一次（降级不失效）', /typeof ResizeObserver === 'undefined'/.test(c));
  check('panelRef 挂在面板根容器', /ref: panelRef/.test(c));
  check('narrow = 视口或面板任一窄', /const narrow = narrowViewport \|\| narrowPanel/.test(c));
}

console.log('');
console.log('Test 2: 阈值取值合理（行为级验证）');
{
  // 阈值常量必须真能算出 narrow：工具行控件合计 ~420px，面板低于 ~560 必然溢出。
  const vp = Number((/NARROW_VIEWPORT_WIDTH = (\d+)/.exec(c) || [])[1]);
  const pn = Number((/NARROW_PANEL_WIDTH = (\d+)/.exec(c) || [])[1]);
  check('视口阈值存在且合理（600-1000）', vp >= 600 && vp <= 1000, vp);
  check('面板阈值存在且覆盖工具行溢出（≥480）', pn >= 480 && pn <= 700, pn);
}

console.log('');
console.log('Test 3: 溢出点改为条件 wrap');
{
  // 技能工具行（input+select+按钮）与批量条按钮区：窄屏 wrap，宽屏维持 nowrap 不折行。
  check('技能工具行条件 wrap', /style: \{ \.\.\.S\.row, gap: 8, flexWrap: narrow \? 'wrap' : 'nowrap' \}/.test(c));
  check('批量条容器条件 wrap', /alignItems: 'center', gap: 8, flexWrap: narrow \? 'wrap' : 'nowrap',/.test(c));
  check('回收站头条件 wrap', /gap: 8, marginTop: 6, flexWrap: narrow \? 'wrap' : 'nowrap'/.test(c));
  check('确认按钮组条件 wrap', /gap: 6, flexWrap: narrow \? 'wrap' : 'nowrap'/.test(c));
  // 卡片标题行必须保持 nowrap（状态点不能掉到第二行——那是 0.5.117 排版的意义）
  check('卡片标题行仍 nowrap', /justifyContent: 'space-between', gap: 8, flexWrap: 'nowrap'/.test(c));
  check('S.btnRow 仍 nowrap（单卡按钮行不折行）', /btnRow: \{[^}]*flexWrap: 'nowrap'/.test(c));
}

console.log('');
console.log('Test 4: 无 ResizeObserver 环境（jsdom 老版本等）不崩');
{
  const guard = /if \(typeof ResizeObserver === 'undefined'\) \{[\s\S]{0,420}?return \(\) =>/.exec(c);
  check('守卫存在且提前 return', Boolean(guard));
  check('守卫内仍读一次 clientWidth（首帧不闪）', guard ? /clientWidth/.test(guard[0]) : false);
}

console.log('');
console.log('Test 5: 既有行为不破');
{
  check('上传门控仍在', /uploadOpen \? h\('div'/.test(c));
  check('批量模式仍在', /const \[batchMode, setBatchMode\] = useState\(false\)/.test(c));
  check('工具禁用仍在', /toolDenyDraft/.test(c));
  check('搜索框仍在列表头之前', c.indexOf('搜索已装技能') < c.indexOf('已装技能（'));
}

console.log('');
console.log('Test 6: 语法');
{
  const { execSync } = await import('node:child_process');
  let ok = true;
  try { execSync('node --check ' + JSON.stringify(path.join(W, 'client.js')), { stdio: 'pipe' }); } catch { ok = false; }
  check('client.js 语法通过', ok);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
