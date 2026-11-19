#!/usr/bin/env node
// test-dead-all.mjs — TDD: 清理「全部来源」聚合的失效残留，但保留 MCP 工具仍在用的 source:"all"。
// 判据：GUI 的来源 chip 数组里没有 'all'，所以 chip 渲染里的 key==='all' 分支永远走不到；
//       LOAD_MORE_CAPABLE 只有定义、没有任何引用；而 skill_market_search 工具默认仍是 all 聚合（活的）。
import fs from 'node:fs';
import path from 'node:path';
import { safeTempDir } from '../src/home.js';

const W = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(W, f), 'utf8');

let passed = 0, failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log('  \u2713 ' + name); }
  else { failed++; console.log('  \u2717 ' + name + (detail ? '  ' + detail : '')); }
};

const client = read('client.js');

console.log('\nTest 1: 技能来源 chip 里没有 unreachable 的 all 分支');
{
  // chip 数组本身不含 'all'（前提，别改坏）
  const skillsChips = client.match(/\[('skills\.sh'[^\]]*)\]/);
  check('skills chip array has no all', skillsChips && !/['"]all['"]/.test(skillsChips[1]));
  // 渲染标签里不应再有 key === 'all' ? '全部来源'
  check('no unreachable 全部来源 chip label', !client.includes("key === 'all' ? '全部来源'"));
}

console.log('\nTest 2: LOAD_MORE_CAPABLE 死导出已移除');
{
  const sources = read('src/sources.js');
  check('LOAD_MORE_CAPABLE gone from sources.js', !sources.includes('LOAD_MORE_CAPABLE'));
}

console.log('\nTest 3: 保留 MCP 工具仍在用的 all 聚合（不能删）');
{
  const index = read('index.js');
  const sources = read('src/sources.js');
  check('tool default source all still present', index.includes('source: args.source || "all"'));
  check('dispatcher still handles all', sources.includes('source === "all"'));
  check('ALL_SOURCES still defined', sources.includes('export const ALL_SOURCES'));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
