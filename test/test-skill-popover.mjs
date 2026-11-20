#!/usr/bin/env node
// test-skill-popover.mjs — 「＋ 添加技能」弹出层的布局与交互锁。
//
// 现状实测（2026-11-20）：点击按钮后搜索框/列表头/卡片/回收站全部下移 62px（插队横幅，
// 不是弹出层）；弹层内没有 ✕/Escape/点外关闭；上传成功不自动收起；上传错误走页面级
// setError，视线不在那里；弹层不说明安装目标与 4MB 上限。
//
// 方案：绝对定位浮层锚在工具行按钮下方（面板容器 position:relative 已存在），
// 三路关闭（✕ / Escape / 点外），成功 600ms 自动收起，错误就地显示，上下文行给
// 安装目标目录（~ 缩写）与 zip 上限。拖拽热区保持在整个列表容器（行为不倒退）。
import fs from 'node:fs';
import path from 'node:path';

const W = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(W, f), 'utf8');
const c = read('client.js');

let passed = 0, failed = 0;
const check = (n, cond, d = '') => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 120) + ']' : '')); } };

console.log('');
console.log('Test 1: 弹出层是绝对定位浮层（零位移的前提）');
{
  const gi = c.indexOf("uploadOpen ? h('div'");
  const seg = c.slice(gi, gi + 900);
  check('浮层 position:absolute', /position: 'absolute'/.test(seg));
  check('浮层带阴影/边框（视觉独立于列表）', /boxShadow/.test(seg));
  check('不使用 fixed（会脱离面板容器）', !/position: 'fixed'/.test(seg));
}

console.log('');
console.log('Test 2: 三路关闭（✕ / Escape / 点外）');
{
  check('✕ 关闭按钮存在', /'✕'/.test(c.slice(c.indexOf("uploadOpen ? h('div'"), c.indexOf("uploadOpen ? h('div'") + 3000)));
  // Escape 是组件级 useEffect（在文件前部），不在浮层渲染窗口内——按功能存在性全局断言
  check('Escape 处理存在', /if \(e\.key === 'Escape'\) setUploadOpen\(false\)/.test(c));
  check('点外关闭监听存在', /mousedown|pointerdown|addEventListener\('mousedown|addEventListener\("mousedown/.test(c));
  check('关闭监听带清理（useEffect return）', /\}\s*,\s*\[uploadOpen\]\s*\)|\}\s*,\s*\[uploadOpen,/.test(c));
  check('监听在 uploadOpen 打开时才挂（不常驻）', /if \(!uploadOpen\) return|if \(uploadOpen\) \{/.test(c));
}

console.log('');
console.log('Test 2b: 包含块与触发豁免（静态复核挖出的两个定位 bug）');
{
  // 无 position:relative 的祖先链里只有 S.page 定位 → 浮层会锚到面板整体右上角
  const ci = c.indexOf("manageTab === 'skill' ? h('div'");
  check('技能容器是定位包含块', /position: 'relative'/.test(c.slice(ci, ci + 400)));
  check('浮层起点在工具行下方（top≥40）', (function () { const m = /position: 'absolute',[^}]*top: (\d+)/.exec(c); return m && Number(m[1]) >= 40; })());
  // mousedown 先关 → 重渲染 → click 闭包取反又开 = 闪回；触发按钮必须豁免
  check('点外关闭豁免触发按钮', /closest\('\[data-upload-trigger\]'\)/.test(c));
  check('触发按钮带 data 标记', /'data-upload-trigger': '1'/.test(c));
}

console.log('');
console.log('Test 3: 成功自动收起 + 错误就地显示');
{
  check('上传成功后自动收起（600ms）', /setUploadOpen\(false\)[\s\S]{0,220}600\)|setTimeout\([\s\S]{0,80}setUploadOpen\(false\)/.test(c));
  check('浏览 handler 用就地错误而非页面级 setError', /setUploadError\(/.test(c));
  check('zip handler 用就地错误', (c.match(/setUploadError\(/g) || []).length >= 2);
  check('drop handler 用就地错误', (c.match(/setUploadError\(/g) || []).length >= 3);
  check('上传错误不在页面级 error 槽', /setError\(`上传失败/.test(c) === false);
  check('弹层渲染就地错误行（三元形态）', /uploadError \? h\('div'/.test(c));
}

console.log('');
console.log('Test 4: 上下文行（安装目标 + zip 上限）');
{
  const gi = c.indexOf("uploadOpen ? h('div'");
  // 浮层里夹着两个完整上传 handler（浏览/zip），children 尾部距起点约 6k 字符
  const seg = c.slice(gi, gi + 7000);
  check('显示安装目标（首个 skillDir，~ 缩写）', /安装到/.test(seg) && /shortPath\(/.test(seg));
  check('zip 上限提示在弹层内', /zip ≤ 4MB|≤ 4MB|4MB/.test(seg));
  check('拖拽提示保留（引导真实热区）', /拖到本列表区域|拖到这里/.test(seg));
}

console.log('');
console.log('Test 5: 行为不倒退');
{
  check('拖拽热区仍在列表容器（onDrop: handleSkillDrop）', /onDrop: handleSkillDrop/.test(c));
  check('浏览文件夹字面量仍在技能段（结构锁）', c.indexOf('浏览文件夹') > c.indexOf("manageTab === 'skill' ? h('div'") && c.indexOf('浏览文件夹') < c.indexOf("manageTab === 'mcp' ? h('div'"));
  check('按钮 aria-expanded 保留', /'aria-expanded': uploadOpen/.test(c));
  check('拖入提示条保留', /松开即可上传/.test(c));
}

console.log('');
console.log('Test 6: 语法 + 既有锁不破');
{
  const { execSync } = await import('node:child_process');
  let ok = true;
  try { execSync('node --check ' + JSON.stringify(path.join(W, 'client.js')), { stdio: 'pipe' }); } catch { ok = false; }
  check('client.js 语法通过', ok);
  // 0.5.117 的锁：弹出层曾是插队横幅，锁「搜索框仍在列表头上方」（防回到推挤式）
  check('搜索框仍在列表头之前（防回退）', c.indexOf('搜索已装技能') < c.indexOf('已装技能（'), 'search@' + c.indexOf('搜索已装技能') + ' header@' + c.indexOf('已装技能（'));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
