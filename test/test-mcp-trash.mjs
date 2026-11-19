#!/usr/bin/env node
// test-mcp-trash.mjs — TDD: MCP 连接器回收站（列出 / 恢复 / 清空）。
//
// 事实：src/mcp.js uninstall() 早就把定义写进 <dir>/.trash/<name>-<stamp>.json 再删原文件，
//   实测 C:\Users\...\.dsh\market\mcp\.trash 已积累 6 个条目 —— 数据一直可恢复，缺的只是 UI 与 op。
// 不能复用 skills.js 的 listTrash/restoreFromTrash：TRASH_NAME=/^(.*)-(stamp)(\.md)?$/ 不匹配
//   .json（实测 match=false），且 baseName 会强加 .md 后缀 → 恢复出来的定义文件名错误、扩展名丢失，
//   readDefs 只认 .json（src/mcp.js:92）→ 恢复等于彻底丢失。故 MCP 侧自实现。
// 恢复必须直接 reconcile()，不能只靠目录 watcher：watch(dir) 非 recursive，
//   .trash 内的变化不触发回调，且宿主重启时 startWatching 尚未安装。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMcpManager } from '../src/mcp.js';

let passed = 0, failed = 0;
const check = (n, c, d = '') => { if (c) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + d.slice(0, 90) + ']' : '')); } };

const root = fs.mkdtempSync(path.join(os.tmpdir() || '.', 'dsh-mcp-trash-'));
const mcpDir = path.join(root, 'mcp');
fs.mkdirSync(mcpDir, { recursive: true });
// stub ctx: mount must not reach the real shipped client
const ctx = { plugin: () => ({ dispose() {} }) };
const mcp = createMcpManager({ ctx, dirs: [mcpDir], shippedRoot: root, log: () => {} });

const writeDef = (name) => fs.writeFileSync(path.join(mcpDir, name + '.json'), JSON.stringify({ serverName: name, transport: 'stdio', command: 'npx', args: ['-y', 'x'] }), 'utf8');

console.log('');
console.log('Test 1: 卸载进回收站，listTrash 能列出且保留 .json 语义');
{
  writeDef('alpha');
  const before = await mcp.list();
  check('卸载前可见', before.some((x) => x.serverName === 'alpha'));
  const gone = await mcp.uninstall('alpha');
  check('uninstall 成功', gone.ok === true);
  const t = await mcp.trashList();
  check('回收站有 1 项', t.items.length === 1, JSON.stringify(t.items.map((i) => i.name)));
  check('条目名保留 .json', /\.json$/.test(t.items[0]?.name || ''), t.items[0]?.name);
  check('解析出 serverName', t.items[0]?.serverName === 'alpha', t.items[0]?.serverName);
  check('解析出 deletedAt 时间戳', /^\d{4}-\d{2}-\d{2}T/.test(t.items[0]?.deletedAt || ''), t.items[0]?.deletedAt);
  check('kind=file', t.items[0]?.kind === 'file');
}

console.log('');
console.log('Test 2: 恢复 → 定义回到 mcpDirs 且可被 list 看见（扩展名不丢）');
{
  const t = await mcp.trashList();
  const r = await mcp.trashRestore({ path: t.items[0].path });
  check('恢复成功', r.ok === true, JSON.stringify(r));
  check('恢复目标以 .json 结尾', /alpha\.json$/.test(r.restoredTo || ''), r.restoredTo);
  check('文件真的回到 mcpDir', fs.existsSync(path.join(mcpDir, 'alpha.json')));
  const after = await mcp.list();
  check('list 重新看见 alpha', after.some((x) => x.serverName === 'alpha'));
  const t2 = await mcp.trashList();
  check('回收站条目已移走', t2.items.length === 0, JSON.stringify(t2.items.map((i) => i.name)));
}

console.log('');
console.log('Test 3: 同名冲突不覆盖，产生可用别名');
{
  writeDef('beta');
  await mcp.uninstall('beta');
  writeDef('beta');
  const t = await mcp.trashList();
  const r = await mcp.trashRestore({ path: t.items.find((i) => /beta/.test(i.name)).path });
  check('恢复成功且不报错', r.ok === true, JSON.stringify(r));
  check('磁盘上 beta.json 仍是原定义', JSON.parse(fs.readFileSync(path.join(mcpDir, 'beta.json'), 'utf8')).serverName === 'beta');
  check('恢复出的别名可被 list 读到', (await mcp.list()).some((x) => x.serverName === 'beta'));
}

console.log('');
console.log('Test 4: 清空删除条目但不动在用定义');
{
  writeDef('gamma');
  await mcp.uninstall('gamma');
  writeDef('keepme');
  const t = await mcp.trashList();
  check('清空前有回收站条目', t.items.length > 0, String(t.items.length));
  const e = await mcp.trashEmpty();
  check('removed 计数 > 0', e.removed > 0, String(e.removed));
  check('清空后回收站为空', (await mcp.trashList()).items.length === 0);
  check('在用定义 keepme 未受影响', fs.existsSync(path.join(mcpDir, 'keepme.json')));
}

console.log('');
console.log('Test 5: 路径安全——越界路径必须被拒绝');
{
  let blocked = false;
  try { await mcp.trashRestore({ path: path.join(root, '..', 'outside.json') }); } catch { blocked = true; }
  check('拒绝 .trash 之外的恢复路径', blocked);
  let blocked2 = false;
  try { await mcp.trashRestore({ path: path.join(mcpDir, 'keepme.json') }); } catch { blocked2 = true; }
  check('拒绝非回收站目录内的恢复路径', blocked2);
}

console.log('');
console.log('Test 6: RPC 面接线（op 存在 + 破坏性 op 需 confirm）');
{
  const idx = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'index.js'), 'utf8');
  const guard = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'rpc-guard.js'), 'utf8');
  check('case mcp.trash', idx.includes('case "mcp.trash"'));
  check('case mcp.restore', idx.includes('case "mcp.restore"'));
  check('case mcp.trashEmpty', idx.includes('case "mcp.trashEmpty"'));
  check('mcp.trashEmpty 在 DESTRUCTIVE_OPS', /"mcp\.trashEmpty"/.test(guard));
  const client = fs.readFileSync(path.join(import.meta.dirname, '..', 'client.js'), 'utf8');
  check('client 调 mcp.trash', client.includes("call('mcp.trash'"));
  check('client 调 mcp.restore', client.includes("call('mcp.restore'"));
  check('client 调 mcp.trashEmpty 带 confirm', /call\('mcp\.trashEmpty',\s*\{\s*confirm:\s*true/.test(client));
  check('MCP 子页签渲染回收站区块', /mcpTrashList/.test(client));
}

mcp.dispose();
fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);