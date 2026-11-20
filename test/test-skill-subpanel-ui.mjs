#!/usr/bin/env node
// test-skill-subpanel-ui.mjs — 「管理 → SKILL 技能」子面板的布局与状态筛选锁。
//
// 起因（2026-11-20 实测首屏坐标）：上传区常驻首屏吃掉 100px（低频动作）；搜索框被挤到最右且
// 文字截断；分组头与卡片各显示一次 `rank 200/500`（实现细节泄漏）；卡片没有描述行；技能侧按钮
// 叫「关闭」而 MCP 侧叫「停用」（同义两词）；回收站常驻且「恢复」按钮贴右边缘距条目 570px。
//
// 关键正确性前提：停用有两种实现——文件级（SKILL.md 的 disable-model-invocation）与面板级
// （settings.disabledSkills）。旧卡片只读 disabledSkills，所以**文件级停用的技能在界面上
// 显示成未停用**。状态筛选必须建立在合并两种来源的真实状态上，否则它是假筛选。
import fs from 'node:fs';
import path from 'node:path';

const W = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(W, f), 'utf8');
const c = read('client.js');
const sk = read('src/skills.js');

let passed = 0, failed = 0;
const check = (n, cond, d = '') => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 120) + ']' : '')); } };

console.log('');
console.log('Test 1: 停用状态的数据源必须合并两种机制（否则筛选是假陈述）');
{
  check('listInstalledSkills 透出 disableModelInvocation', /disableModelInvocation:\s*(meta\.|skillMeta)/.test(sk));
  // 合并逻辑收敛在 skillStateOff 里（卡片与筛选共用同一个判据，避免两处口径漂移）
  const fnBody = /const skillStateOff = (\([^)]*\) => [^;]+;)/.exec(c);
  check('skillStateOff 合并面板级与文件级', fnBody && /disabledSet\.has/.test(fnBody[1]) && /disableModelInvocation/.test(fnBody[1]), fnBody ? fnBody[1].slice(0, 120) : '函数未找到');
  check('卡片 off 用同一判据', /const off = skillStateOff\(item\);/.test(c));
}

console.log('');
console.log('Test 2: 状态筛选维度（全部/已启用/已停用）');
{
  check('manageSkillState state 存在', /const \[manageSkillState, setManageSkillState\] = useState\(/.test(c));
  check('筛选同时作用于搜索词与状态', /filteredInstalled = [\s\S]{0,420}manageSkillState/.test(c));
  check('已停用判定用合并后的 off', /skillStateOff\(/.test(c));
  check('筛选无结果显示空态而非纯空白', /没有符合筛选条件|没有匹配的技能/.test(c));
  check('状态筛选值持久化（与折叠偏好同风格）', /manage-skill-state|skillStateKey|SKILL_STATE_KEY/.test(c));
}

console.log('');
console.log('Test 3: 工具行——搜索为主角，上传收进弹出层');
{
  const gi = c.indexOf("manageTab === 'skill' ? h('div'");
  // 窗口要覆盖到「＋ 添加技能」（实测偏移 ~7.1k），6000 不够。
  const seg = c.slice(gi, gi + 11000);
  check('搜索框排在上传按钮之前', seg.indexOf('搜索已装技能') < seg.indexOf('＋ 添加技能'));
  // 本文件是 h() 调用风格，不是 JSX：门控的真实形态是 uploadOpen ? h('div', ...) : null
  check('上传区收进 uploadOpen 门控', /uploadOpen \? h\('div'/.test(seg) && /onClick: \(\) => setUploadOpen\(!uploadOpen\)/.test(seg));
  check('上传区在门控内、搜索框在门控后', seg.indexOf("uploadOpen ? h('div'") < seg.indexOf('浏览文件夹') && seg.indexOf('浏览文件夹') < seg.indexOf('搜索已装技能'));
  check('「浏览文件夹」仍在技能段内（结构锁不破坏）', seg.includes('浏览文件夹'));
  check('拖拽热区升到整个列表容器', /onDrop: \(e\) => handleSkillDrop\(e\)|onDrop: handleSkillDrop/.test(seg));
  check('拖入时浮出提示条', /dragOver/.test(seg) && /松开即可上传|拖到这里上传/.test(seg));
}

console.log('');
console.log('Test 4: 分组头不再泄漏实现细节');
{
  const gi = c.indexOf('const installedSkills = installedGrouped.map');
  const seg = c.slice(gi, gi + 1500);
  check('可见文案去掉 rank 数字', !/`rank \$\{group\.rank\}|rank \$\{group\.rank\} ·/.test(seg));
  check('rank 降级为悬浮提示', /title:[^\n]*(层级|优先级)/.test(seg));
  check('分组头保留计数', /\$\{group\.items\.length\} 个/.test(seg));
}

console.log('');
console.log('Test 5: 卡片排版——描述、路径缩写、按钮位置与文案');
{
  const ci = c.indexOf('const renderInstalledCard');
  const seg = c.slice(ci, ci + 4200);
  check('卡片显示描述', /item\.description/.test(seg));
  check('路径用 ~ 缩写', /shortPath\(/.test(seg));
  // 假绿防线：只断言「调用了 shortPath」不够——homeDir 必须是 OS 主目录（~ 的约定含义），
  // 否则 .agents/… 技能路径前缀不匹配，缩写静默失效（0.5.117 首版正是这样）。
  check('homeDir 用 homedir() 而非 dshHome()', /homeDir: homedir\(\)/.test(read('index.js')));
  check('shortPath 真实产出 ~（行为级）', (function () {
    const fn = /function shortPath\(p, home\) \{[\s\S]*?\n    \}/.exec(c);
    if (!fn) return false;
    const body = fn[0].replace('function shortPath', 'function');
    const f = new Function('return ' + body)();
    return f('C:\\Users\\x\\.agents\\skills\\demo', 'C:\\Users\\x') === '~/.agents/skills/demo';
  })());
  check('技能侧按钮文案统一为停用', /'停用'/.test(seg) && !/'关闭'/.test(seg));
  check('卸载是危险样式且靠右', /danger|S\.btnDanger|color: '#c62828'/.test(seg));
  check('按钮行不换行（窄面板不挤成两行）', /flexWrap: 'nowrap'/.test(seg));
}

console.log('');
console.log('Test 6: 回收站默认折叠 + 条目对齐 + 时间可读');
{
  const gi = c.indexOf("manageTab === 'skill' ? h('div'");
  // 浮层弹出层加入后回收站被推到 ~12.7k；窗口给到 15k 留余量
  const seg = c.slice(gi, gi + 15000);
  check('回收站标题保留 回收站（N） 形态（结构锁）', seg.includes('回收站（'));
  // 未记录时 getItem 返回 null，null==='1' 为 false → 默认折叠；catch 分支同样 false。
  check('默认折叠（未记录时 false）', /getItem\(TRASH_OPEN_KEY\) === '1'/.test(c));
  check('列表体受 trashOpen 门控', /trashOpen\s*\n\s*\? \(trashList/.test(c));
  check('条目用 grid 对齐、恢复紧跟条目', /gridTemplateColumns:[^}]*auto/.test(seg));
  check('时间戳格式化（不再 ISO 带连字符）', /formatStamp\(/.test(seg));
}

console.log('');
console.log('Test 7: 栅格自适应');
{
  check('S.grid 用 auto-fill minmax', /gridTemplateColumns: 'repeat\(auto-fill, minmax\(272px, 1fr\)\)/.test(c));
}

console.log('');
console.log('Test 8: 既有结构锁不被破坏');
{
  check('MCP 段仍在技能段之后', c.indexOf("manageTab === 'mcp' ? h('div'") > c.indexOf("manageTab === 'skill' ? h('div'"));
  check('未引入未登记 op', (() => {
    const ops = [...new Set([...c.matchAll(/call\('([\w.]+)'/g)].map((m) => m[1]))];
    const known = new Set(['skills.list','mcp.list','settings.get','skills.search','mcp.search','skills.detail','mcp.detail','mcp.probe','mcp.status','skills.update','mcp.update','skills.install','mcp.install','skills.toggle','mcp.toggle','skills.uninstall','settings.set','skills.trash','skills.restore','skills.trashEmpty','mcp.trash','mcp.restore','mcp.trashEmpty','mcp.tools.get','mcp.tools.set','sessions.scan','sessions.repair','market.openDir','mcp.uninstall','skills.upload','skills.importZip']);
    return ops.filter((o) => !known.has(o)).length === 0;
  })());
}

console.log('');
console.log('Test 9: 语法');
{
  const { execSync } = await import('node:child_process');
  for (const f of ['client.js', 'src/skills.js']) {
    let ok = true;
    try { execSync('node --check ' + JSON.stringify(path.join(W, f)), { stdio: 'pipe' }); } catch { ok = false; }
    check(f + ' 语法通过', ok);
  }
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
