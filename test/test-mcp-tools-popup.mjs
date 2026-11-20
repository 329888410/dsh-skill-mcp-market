#!/usr/bin/env node
// test-mcp-tools-popup.mjs — TDD: 管理面板点已装 MCP 卡片 → 浮窗显示工具清单与详情。
//
// 需求：点击「管理 → MCP 连接器」子面板里已装列表的卡片本体时，弹出浮窗列出该连接器
// 注册的全部工具（名称 + 描述 + 参数 schema），而不是只有卡片上那句「N 个工具」。
//
// 数据面事实：mcp.list/detail 的 tools 只有名字（toolNamesFor 取 definition.name，
// src/mcp.js:163-173）。描述与参数在宿主 definition 上真实存在（ToolSchema：
// name/description/parameters，dsh-llm types.ts；dsh-mcp-client/tools.ts 把上游
// inputSchema 原样放进 parameters），所以不需要新增上游请求，只需把 definition
// 的完整字段透出——这是纯读操作，不进 DESTRUCTIVE_OPS。
import fs from 'node:fs';
import path from 'node:path';

const W = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(W, f), 'utf8');
const mcp = read('src/mcp.js');
const c = read('client.js');

let passed = 0, failed = 0;
const check = (n, cond, d = '') => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 130) + ']' : '')); } };

console.log('');
console.log('Test 1: 服务端透出工具详情（名称+描述+参数 schema）');
{
  check('toolDetailsFor 存在', /function toolDetailsFor\(/.test(mcp));
  check('读 definition.description', /toolDetailsFor[\s\S]{0,420}\.description/.test(mcp));
  check('读 definition.parameters', /toolDetailsFor[\s\S]{0,520}\.parameters/.test(mcp));
  check('按 mcp__<name>__ 前缀过滤（与 toolNamesFor 同规则）', /toolDetailsFor[\s\S]{0,300}mcp__\$\{serverName\}__/.test(mcp));
  check('detail 返回 toolDetails', /async function detail[\s\S]{0,1400}toolDetails: toolDetailsFor/.test(mcp));
}

console.log('');
console.log('Test 2: 卡片本体可点击打开浮窗');
{
  const s = c.indexOf('const installedMcps');
  const seg = c.slice(s, s + 900);
  check('卡片 div 带 onClick', /key: `m-\$\{item\.serverName\}`,[\s\S]{0,260}onClick: \(\) => openMcpTools\(item\.serverName\)/.test(seg));
  check('卡片有可点击提示（cursor/标题）', /cursor: 'pointer'|title: '查看工具清单'/.test(seg));
  const btns = c.slice(s, s + 3600);
  check('操作按钮行 stopPropagation（点按钮不误开浮窗）', /stopPropagation/.test(btns));
}

console.log('');
console.log('Test 3: 浮窗组件与状态');
{
  check('mcpTools state 存在', /const \[mcpTools, setMcpTools\] = useState\(null\)/.test(c));
  check('openMcpTools 走 mcp.detail', /const openMcpTools = async[\s\S]{0,400}'mcp\.detail'/.test(c));
  check('openMcpTools 声明在 installedMcps 之前（TDZ）',
    c.indexOf('const openMcpTools') > 0 && c.indexOf('const openMcpTools') < c.indexOf('const installedMcps'));
  check('mcpTools state 声明在使用之前（TDZ）',
    c.indexOf('const [mcpTools,') < c.indexOf('const installedMcps'));
}

console.log('');
console.log('Test 4: 浮窗渲染工具清单与详情');
{
  // 浮窗渲染段：从 map 调用回溯到遮罩开头（state 声明处也有同名注释，故不能用 indexOf(注释)）
  // 0.5.120 起清单走 visibleTools 单一数据源（toolDetails.map 不再出现）；
  // 锚换成唯一的 搜索工具名或描述（浮层内搜索框），遮罩在其上方约 1.1k
  const mapAt = c.indexOf('搜索工具名或描述');
  const s = mapAt - 2200;   // 遮罩在锚点上方 1523（实测）
  const seg = c.slice(s, mapAt + 2800);   // tool.parameters 在锚点下方 2203（实测）
  check('浮窗存在（fixed 遮罩）', s > 0 && /position: 'fixed'/.test(seg));
  check('渲染工具名', /tool\.name/.test(seg));
  check('渲染工具描述', /tool\.description/.test(seg));
  check('参数 schema 可展开', /mcpToolOpen|展开参数|参数/.test(seg));
  check('渲染 parameters', /tool\.parameters/.test(seg));
  check('有关闭入口', /setMcpTools\(null\)/.test(seg));
  check('未挂载时诚实提示（不假装空清单=没有工具）', /未挂载|还没发布工具/.test(seg));
  // 旧服务端不返回 toolDetails：必须说「需重启」，不能说「还没发布工具」（那是假陈述）
  check('旧服务端降级为重启提示（非假陈述）', /hasDetails/.test(c) && /重启应用与 Host/.test(seg));
}

console.log('');
console.log('Test 5: 既有行为不被破坏');
{
  check('mcp.list 的 tools 仍是名字数组（卡片计数没变）', /tools: toolNamesFor\(def\.serverName\)/.test(mcp));
  check('编辑抽屉入口仍在', /'编辑'/.test(c) && /openMcpDetail\(item\.serverName\)/.test(c));
  check('测试连接按钮仍在', /'测试连接'/.test(c));
  check('toolDetailsFor 不进 DESTRUCTIVE_OPS（只读）', !/DESTRUCTIVE_OPS[\s\S]{0,400}detail/.test(read('src/rpc-guard.js')));
}

console.log('');
console.log('Test 6: 语法');
{
  const { execSync } = await import('node:child_process');
  for (const f of ['client.js', 'src/mcp.js']) {
    let ok = true;
    try { execSync('node --check ' + JSON.stringify(path.join(W, f)), { stdio: 'pipe' }); } catch { ok = false; }
    check(f + ' 语法通过', ok);
  }
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
