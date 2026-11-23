#!/usr/bin/env node
// test-manage-states.mjs — 管理面板的加载态 / 空态 / 工具浮窗检索 / 坏定义可见性。
//
// 实测差距（2026-11-20，对照 Fishquito7/dsh-skill-mcp-panel 2.3.16）：
//  1) installed/mounted 初值都是 []，与「RPC 返回空数组」不可区分 → 首帧渲染成
//     「SKILL 技能 (0)」，把用户已有的东西说成没有（假陈述）。
//  2) MCP 子面板没有任何空态：筛空时纯空白，与技能段的处理不一致。
//  3) 工具浮窗只有全量清单：几十个工具的连接器（REA 255 个）没有搜索框与无匹配提示。
//  4) 定义文件 JSON 解析失败时被 readDefs 静默跳过（实测：尾逗号、非 JSON 都不出现），
//     用户手改坏一个文件后会以为连接器被删了。原计划的「未命名服务器」兜底经核实
//     不可达（serverName 有空文件名回落，永不为空），属死代码，已撤回。
import fs from 'node:fs';
import path from 'node:path';

const W = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(W, f), 'utf8');
const c = read('client.js');
const mj = read('src/mcp.js');

let passed = 0, failed = 0;
const check = (n, cond, d) => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 120) + ']' : '')); } };

console.log('');
console.log('Test 1: 未加载 ≠ 空（首帧不得谎报 0 个）');
check('installed 初值为 null', /const \[installed, setInstalled\] = useState\(null\)/.test(c));
check('mounted 初值为 null', /const \[mounted, setMounted\] = useState\(null\)/.test(c));
check('未加载时计数位显示读取中', /读取中/.test(c));

console.log('');
console.log('Test 2: 两个子面板都有筛选空态与无数据空态');
const si = c.indexOf("manageTab === 'skill' ? h('div'");
const sseg = c.slice(si, si + 16000);
check('技能段无数据空态', /还没有已安装技能/.test(sseg));
check('技能段筛选空态', /没有符合筛选条件/.test(sseg));
const mi = c.indexOf("manageTab === 'mcp' ? h('div'");
  const mseg = c.slice(mi, mi + 11000);   // 手动添加浮层加入后空态文案距起点 ~9.4k（实测）
check('MCP 段无数据空态', /还没有已安装 MCP|还没有 MCP 连接器/.test(mseg));
check('MCP 段筛选空态', /没有匹配的连接|没有符合筛选/.test(mseg));

console.log('');
console.log('Test 3: 工具浮窗可检索');
check('浮窗有工具搜索框', /placeholder: '搜索工具名或描述'/.test(c));
check('搜索时标题给匹配计数', /匹配/.test(c));
check('无匹配时明确提示', /没有匹配的工具/.test(c));

console.log('');
console.log('Test 4: 无法解析的定义文件必须可见');
check('readDefs 收集解析失败项', /brokenDefs\.push\(/.test(mj));
check('broken 访问器存在且导出（list 契约不变）', /function broken\(\) \{/.test(mj) && /\bbroken\b/.test(mj.slice(mj.indexOf('return { init, dispose'))));
check('RPC 组装 broken 清单', /broken: mcp\.broken\(\)/.test(read('index.js')));
check('面板显示坏定义并给文件名', /无法解析|无法读取/.test(c) && /mcpBroken/.test(c));

console.log('');
console.log('Test 5: 路径 tab 的降级（一个 op 抛错不得让整页空白）');
{
  // 0.5.148 实测：settings.get 因缺 import 每次必抛 ⇒ client 的 settings 停在 null，
  // 而旧渲染把整个 tab 写成 `tab === 'settings' && settings ? … : null`，于是「路径」页
  // 连与会话日志体检（它根本不需要 settings）一起消失 —— 用户截图原文「路径面板异常空白」。
  // 服务端侧实测过：其它 op 没有被同一异常带崩（skills.search/mcp.list/mcp.status 全 ok:true），
  // 所以这是面板的降级缺陷，不是 RPC 分发缺陷。判据跑真实函数体，不跑正则。
  // 必须先归一 CRLF：按 \n 切 CRLF 文件，每行结尾带 \r，bodyOf 找「整行正好是 }」
  // 就永远找不到 —— 那是判据失效，不是实现有问题（0.5.148 那轮同类坑）。
  const clientLines = c.split(String.fromCharCode(13, 10)).join(String.fromCharCode(10)).split(String.fromCharCode(10));
  const bodyOf = (needle) => {
    const at = clientLines.findIndex((l) => l.indexOf(needle) >= 0);
    if (at < 0) return null;
    for (let i = at + 1; i < clientLines.length; i++) if (clientLines[i] === '}') return clientLines.slice(at, i + 1).join(String.fromCharCode(10));
    return null;
  };
  const run = (args) => {
    const body = bodyOf('function pathsView(');
    if (body === null) return { err: '未取到函数体 pathsView' };
    try { return new Function('return (' + body + ')')()(...args); }
    catch (e) { return { err: String((e && e.message) || e) }; }
  };
  const full = {
    settings: { skillDirs: ['C:/a'], mcpDirs: ['C:/m'], settingsPath: 'C:/Users/x/.dsh/market/settings.json', homeDir: 'C:/Users/x' },
    skillProvider: { mounted: true, error: '' },
    shipped: { mcpClient: 'C:/app.asar/dsh/node_modules/@deepseek-ai/dsh-mcp-client' },
  };
  const cold = run([null, 'C:/typed/skill', 'C:/typed/mcp']);
  check('settings 缺失时函数可执行（不抛）', !cold.err, JSON.stringify(cold).slice(0, 120));
  // 函数体缺失时 cold 没有字段：后面每条都从 cold 取值，必须整段守住，
  // 否则 TypeError 崩掉套件、连汇总行都没有（0.5.148 那轮同类机制缺陷，已犯过一次）。
  if (!cold.err) {
    check('settings 缺失时路径区仍要渲染', cold.showPathsSection === true, JSON.stringify(cold).slice(0, 160));
    check('settings 缺失时会话体检区仍要渲染', cold.showSessionSection === true, JSON.stringify(cold).slice(0, 160));
    check('settings 缺失时草稿仍可编辑（不被失败 op 清空）', (cold.skillRows || []).join('|') === 'C:/typed/skill' && (cold.mcpRows || []).join('|') === 'C:/typed/mcp', JSON.stringify(cold.skillRows) + '/' + JSON.stringify(cold.mcpRows));
    check('未知项给如实文案而非空白', /未知/.test(cold.configPath || '') && /未知/.test(cold.providerLabel || '') && /未知/.test(cold.clientLabel || ''), [cold.configPath, cold.providerLabel, cold.clientLabel].join(' | '));
    check('降级提示说明是哪个 op 失败', /settings\.get/.test(cold.degradedNote || ''), JSON.stringify(cold.degradedNote));
  }
  const warm = run([
    {
      settings: { skillDirs: ['C:/a'], mcpDirs: ['C:/m'], settingsPath: 'C:/Users/x/.dsh/market/settings.json', homeDir: 'C:/Users/x' },
      skillProvider: { mounted: true, error: '' },
      shipped: { mcpClient: 'C:/app.asar/dsh/node_modules/@deepseek-ai/dsh-mcp-client' },
    },
    'C:/a',
    'C:/m',
  ]);
  if (!warm.err) {
    check('settings 在手时给真实配置路径', warm.loaded === true && warm.configPath === 'C:/Users/x/.dsh/market/settings.json', JSON.stringify(warm).slice(0, 160));
    check('settings 在手时 provider 如实挂载态', warm.providerLabel === '已挂载', warm.providerLabel);
    check('settings 在手时 MCP 客户端给真实路径', warm.clientLabel === 'C:/app.asar/dsh/node_modules/@deepseek-ai/dsh-mcp-client', warm.clientLabel);
    check('settings 在手时不再显示降级提示', !warm.degradedNote, JSON.stringify(warm.degradedNote));
  }
  const broken = run([
    { settings: { skillDirs: [], mcpDirs: [], settingsPath: 'p' }, skillProvider: { mounted: false, error: 'ctx.skills unavailable' }, shipped: { mcpClient: 'NOT FOUND' } },
    '',
    '',
  ]);
  if (!broken.err) {
    check('provider 未挂载时不得谎报已挂载', broken.providerLabel === '未挂载', broken.providerLabel);
    check('空目录草稿给空数组（保存由服务端把关，面板不造数）', Array.isArray(broken.skillRows) && broken.skillRows.length === 0, JSON.stringify(broken.skillRows));
  }
  // 反向：旧写法把整个 tab gate 在 settings 上（`tab === 'settings' && settings`），
  // 这条否定锁保证它不会回来 —— 判据只看这一处 gate 形态，不看文案。
  check('渲染不再把整个 tab gate 在 settings 上', !/tab === 'settings' && settings/.test(c), c.split(String.fromCharCode(10)).filter((l) => /tab === 'settings' && settings/.test(l)).join(' ~ '));
}
console.log('');
console.log('Test 6: 既有行为不破');
check('list() 仍返回数组（test-mcp-trash 契约）', /return \[\.\.\.defs\.values\(\)\]\.map/.test(mj));
check('技能段仍在 MCP 段之前', si > 0 && si < mi);
// 0.5.130 起渲染源改为 renderedTools（visibleTools 的分批切片）。单一数据源仍是 visibleTools：
// 计数、无匹配提示、分批渲染都从它派生。锁这条链，而不是锁某个变量名还在被 map。
check('浮窗单一数据源仍是 visibleTools', /const visibleTools = mcpTools \? mcpTools\.toolDetails\.filter/.test(c));
check('渲染经 renderedTools 分批（派生自 visibleTools）', /const renderedTools = mcpTools && visibleTools\.length > TOOL_BATCH \* toolBatch/.test(c) && /renderedTools\.map\(\(tool\) =>/.test(c));
check('计数与无匹配提示仍读 visibleTools', /匹配 \$\{visibleTools\.length\}/.test(c) && /visibleTools\.length === 0/.test(c));

check('回收站折叠锁仍在', c.includes('回收站（'));
check('上传门控锁仍在', /uploadOpen \? h\('div'/.test(c));

console.log('');
console.log('Test 7: 语法');
const { execSync } = await import('node:child_process');
for (const f of ['client.js', 'src/mcp.js']) {
  let ok = true;
  try { execSync('node --check ' + JSON.stringify(path.join(W, f)), { stdio: 'pipe' }); } catch { ok = false; }
  check(f + ' 语法通过', ok);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
