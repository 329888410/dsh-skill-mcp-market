#!/usr/bin/env node
// test-tool-deny.mjs — 工具级禁用（差距清单 Task B，参照 Fishquito7 2.3.16 tool-filter.ts）。
//
// 目标：从「整台连接器停用」细化到「只禁用其中几个工具」。宿主官方机制已核实：
//  - ctx.tools.restrict({deny}) 要求 scoped ctx（agent.ctx）——全局调用直接抛错
//    （dsh-tools src/index.ts:165 实测）；返回精确 disposer。
//  - agent 列表：ctx.get('agents').list()（AgentRegistry.list() 实测存在；服务名 agents
//    由 dsh-agent declare module 提供）。本插件用动态 ctx.get 而非静态 inject：服务缺失
//    时功能降级，插件绝不因此挂不起来。
//  - restrict 命名未知工具会抛错 → 必须先与 view().restrictableNames 求交集。
//  - 持久化：<marketDir>/tool-filter.json（与参照同语义，路径用我们自己的 market 目录）。
//
// 本套件用假 ctx 做真单元验证（不是正则锁）：restrict 调用、未知名过滤、undo、事件订阅。
import fs from 'node:fs';
import path from 'node:path';
import { safeTempDir } from '../src/home.js';

const W = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(W, f), 'utf8');

let passed = 0, failed = 0;
const check = (n, cond, d) => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 140) + ']' : '')); } };

const modPath = path.join(W, 'src', 'tool-filter.js');
const exists = fs.existsSync(modPath);
check('src/tool-filter.js 存在', exists);

if (exists) {
  console.log('');
  console.log('Test 1: 单元行为（假 ctx 真调用）');
  const { createToolFilter } = await import('file:///' + modPath.replace(/\\/g, '/') + '?t=' + Date.now());
  check('导出 createToolFilter', typeof createToolFilter === 'function');

  const dir = fs.mkdtempSync(path.join(safeTempDir(), 'tdeny-'));
  const file = path.join(dir, 'tool-filter.json');
  const restrictCalls = [];
  const undos = [];
  const handlers = {};
  const known = new Set(['mcp__x__alpha', 'mcp__x__beta', 'run_code']);
  const makeAgent = (id) => ({
    id,
    ctx: {
      plugin(plugin) {
        const scoped = { tools: {
          view: () => ({ restrictableNames: known }),
          restrict(filter) {
            restrictCalls.push({ agent: id, deny: filter.deny.slice() });
            const u = () => undos.push(id);
            undos.push('new-' + id);
            return u;
          },
        } };
        plugin.apply(scoped);
        return { dispose() {} };
      },
    },
  });
  const agents = [makeAgent('a1')];
  const ctx = {
    get: (name) => name === 'agents' ? { list: () => agents } : undefined,
    on: (evt, fn) => { handlers[evt] = fn; return () => { delete handlers[evt]; }; },
  };
  const tf = createToolFilter({ ctx, file, log: () => {} });

  await tf.load();
  check('文件缺失时 deny 为空（不崩）', JSON.stringify(tf.getDeny()) === '[]');
  tf.start();
  check('订阅 agent/created', typeof handlers['agent/created'] === 'function');
  check('订阅 agent/disposed', typeof handlers['agent/disposed'] === 'function');

  const r1 = await tf.setDeny(['mcp__x__alpha', 'bogus__unknown']);
  check('setDeny 落盘 JSON', fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).deny.includes('mcp__x__alpha'));
  check('策略保留原始名单（含未知名）', tf.getDeny().length === 2);
  check('restrict 只收到已知名', restrictCalls.length === 1 && JSON.stringify(restrictCalls[0].deny) === JSON.stringify(['mcp__x__alpha']), JSON.stringify(restrictCalls[0] && restrictCalls[0].deny));
  check('applied 计数=1', r1.applied === 1, JSON.stringify(r1));

  await tf.setDeny(['mcp__x__alpha', 'mcp__x__beta']);
  check('变更触发重施加（第二次 restrict）', restrictCalls.length === 2 && restrictCalls[1].deny.length === 2);

  await tf.setDeny([]);
  check('清空后撤销旧限制（undo 被调）', undos.length >= 2, JSON.stringify(undos));
  check('清空后不再新 restrict', restrictCalls.length === 2);

  agents.push(makeAgent('a2'));
  handlers['agent/created']({ agent: agents[1] });
  await tf.setDeny(['mcp__x__beta']);
  check('新 agent 也被施加', restrictCalls.some((c) => c.agent === 'a2'));

  check('deniedFor 前缀过滤', JSON.stringify(tf.deniedFor('x')) === JSON.stringify(['mcp__x__beta']));
  tf.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('');
console.log('Test 2: index.js 接线');
{
  const ix = read('index.js');
  check('createToolFilter 被装配', /createToolFilter\(/.test(ix));
  check('policy 文件在 market 目录', /tool-filter\.json/.test(ix));
  check('case "mcp.tools.get"', ix.includes('case "mcp.tools.get"'));
  check('case "mcp.tools.set"', ix.includes('case "mcp.tools.set"'));
  check('set 走按服务器合并（replaceServerDeny）', /replaceServerDeny|mergeServerDeny/.test(ix));
  // deniedTools 由 index.js 的 dispatch 组装（toolFilter 活在 index 层；注入 src/mcp.js 会
  //   为一个可选功能给 manager 加耦合），故断言在 index.js 而非 src/mcp.js。
  check('detail 组装 deniedTools（全 return 路径）', /const deniedTools = toolFilter\.deniedFor\(local\.serverName\);/.test(ix) && /local\.deniedTools = deniedTools;/.test(ix));
}

console.log('');
console.log('Test 3: op 登记单源化（tools.get/set 无需三处同步）');
for (const f of ['test-manage-panel.mjs', 'test-install-progress.mjs', 'test-skill-subpanel-ui.mjs']) {
  const t = read('test/' + f);
  check(f + ' 从 index.js 派生（声明形态 + known 指向）', t.includes('const IX_OPS = new Set(') && t.includes('const known = IX_OPS;'), '');
  check(f + ' 无硬编码白名单副本（副本会漂移）', !t.includes("new Set(['skills.list"), '');
}

console.log('');
console.log('Test 4: 面板 UI（浮窗 checkbox + 保存）');
{
  const c = read('client.js');
  check('每工具一个 checkbox', /type: 'checkbox'/.test(c));
  check('checkbox 绑定 draft 状态', /toolDenyDraft/.test(c));
  check('保存按钮', /保存禁用列表/.test(c));
  check('已禁用计数', /已禁用 \$\{|已禁用 \d|disabledCount/.test(c) || /已禁用/.test(c));
  check('打开浮窗读取 deniedTools', /data\.deniedTools/.test(c));
  check('保存走 mcp.tools.set', /'mcp\.tools\.set'/.test(c));
  check('保存结果给会话生效数', /个会话已生效|会话已生效/.test(c));
  // 用户实测（0.5.148）：勾选=禁用但标题写「取消勾选 = 禁用」，且浮窗没有全选入口
  // （技能批量条的「全选」在另一处，管不到这里）。三条判据锁语义照实 + 浮窗自己的全选。
  check('勾选语义标题照实（勾选=禁用）', /勾选 = 禁用该工具/.test(c) && !/取消勾选 = 禁用该工具/.test(c), '标题与 checked 语义必须同向');
  const fi = c.indexOf("'保存禁用列表'");
  const foot = fi > 0 ? c.slice(Math.max(0, fi - 1600), fi + 200) : '';
  check('浮窗底部切片可取', foot.length > 800, 'foot=' + foot.length);
  check('浮窗自带全选/全不选（不是技能批量条那个）', /全选/.test(foot) && /全不选/.test(foot), foot.replace(/\s+/g, ' ').slice(0, 120));
  // 口径必须由「按钮实际改哪个集合」证明，不是由标题文案证明：M5 反向破坏把
  // names 换成 mcpTools.toolDetails（全量清单）时，标题里的 visibleTools 仍在、旧判据照样绿。
  check('全选集合取自已显示的 renderedTools', /const names = renderedTools\.map/.test(foot) && !/const names = mcpTools\.toolDetails\.map/.test(foot), foot.replace(/\s+/g, ' ').slice(0, 140));
  check('全选按钮文案同口径（按 renderedTools 判定态）', /renderedTools\.length && renderedTools\.every[\s\S]{0,80}\? '全不选' : '全选'/.test(foot), '');
  check('分批未显示完时全选口径写明只算已显示', /已显示/.test(foot) || /还有.*未显示/.test(c), '');
}

console.log('');
console.log('Test 5: 边界与既有约束');
{
  const rg = read('src/rpc-guard.js');
  check('mcp.tools.set 不进 DESTRUCTIVE_OPS（与 mcp.update 同级）', !/DESTRUCTIVE_OPS[\s\S]{0,500}"mcp\.tools\.set"/.test(rg));
  const ix = read('index.js');
  check('服务缺失时降级不抛（ctx.get 动态取 agents）', exists && /ctx\.get\(['"]agents['"]\)/.test(read('src/tool-filter.js')));
  check('不静态 inject agents（防插件挂不起来）', !/export const inject = \[[^\]]*"agents"/.test(ix));
}

console.log('');
console.log('Test 6: 语法');
{
  const { execSync } = await import('node:child_process');
  for (const f of ['client.js', 'index.js', 'src/mcp.js'].concat(exists ? ['src/tool-filter.js'] : [])) {
    let ok = true;
    try { execSync('node --check ' + JSON.stringify(path.join(W, f)), { stdio: 'pipe' }); } catch { ok = false; }
    check(f + ' 语法通过', ok);
  }
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
