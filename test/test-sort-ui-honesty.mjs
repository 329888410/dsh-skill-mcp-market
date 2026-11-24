#!/usr/bin/env node
// test-sort-ui-honesty.mjs — TDD: 排序 UI 诚实化（P1-5）。
//
// 缺陷链（全部实测，非推断）：
//   1) client.js 曾内联一份 CAPS 副本 → 与服务端矩阵漂移的风险常驻（0.5.101 承诺「由测试锁定」，
//      0.5.109 直接把副本删掉：能力只存在于 src/sort-capability.js，面板经 settings.get 读取）。
//   2) effSort 曾把 stars/newest/updated/trending 全塌成 ''（`sort === 'name' ? 'name' : ''`）→
//      服务端根本收不到排序意图 → 用户「选了没反应」的第一真因。
//   3) orderedSkills 曾在服务端已排序的页上再按 installs 本地重排 → 即使 (2) 修好，现象仍复现。
//   4) 切源时不重置 sort → 在 clawhub 选 trending 再切 skillsmp，下发一个该源不支持的键。
//   5) MCP registry 分支服务端完全不读 sort（index.js registry 路径无 options.sort），
//      面板却给「按名称」，那只是当前页本地重排、翻页就变回去 → 假选项（用户拍板：严格诚实，删掉）。
//   6) 能力随查询形态变化：clawhub trending 只在 browse（空查询）成立；lobehub MCP 的 --sort
//      只在带查询时透传（lobehub-market.js:143）→ 面板必须按 hasQuery 选分支，而不是给一套万能表。
import fs from 'node:fs';
import path from 'node:path';

const W = path.resolve(import.meta.dirname, '..');
const c = fs.readFileSync(path.join(W, 'client.js'), 'utf8');
const idx = fs.readFileSync(path.join(W, 'index.js'), 'utf8');

let passed = 0, failed = 0;
const check = (n, cond, d = '') => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 110) + ']' : '')); } };

console.log('');
console.log('Test 1: 下发键 = 选中键（缺陷 2）');
{
  check('effSort 不再把未知键塌成空串', !/sort === 'name' \? 'name' : ''/.test(c));
  check('effSort 原样透传选中键', /const effSort = reqSort === 'default' \? 'installCount' : reqSort;/.test(c));
  // 0.5.166：兜底不再是裸 sort state（搜索态残留 trending 会被下发），改走 keepSortForForm。
  // 这条锁保留的原意是「显式 options.sort 必须原样透传」——切源 onClick 传进来的新键不能被兜底吃掉。
  check('reqSort 尊重显式 options.sort（切源时传入新键）', /const reqSort = options && options\.sort !== undefined \? options\.sort :/.test(c));
  check('reqSort 兜底走 keepSortForForm（不再裸吃 sort state）', /const reqSort = options && options\.sort !== undefined \? options\.sort : keepSortForForm\(/.test(c));
}

console.log('');
console.log('Test 2: 服务端已排好的页不得被本地兜底重排（缺陷 3）');
{
  check('serverSorted 守卫存在', /const serverSorted =/.test(c));
  check('守卫排除 default/installCount/name（这三者面板自己能算）', /sort !== 'default' && sort !== 'installCount' && sort !== 'name'/.test(c));
  const seg = c.slice(c.indexOf('const orderedSkills'), c.indexOf('const orderedSkills') + 900);
  check('serverSorted 时本地返回 0（不动服务端序）', /if \(serverSorted\) return 0;/.test(seg));
  check('installable 优先仍是第一顺位（既有产品规则保留）', seg.indexOf('b.installable !== a.installable') < seg.indexOf('if (serverSorted)'));
}

console.log('');
console.log('Test 3: 切源重置不兼容的排序键（缺陷 4）');
{
  const chip = c.slice(c.indexOf('setSource(key);'), c.indexOf('setSource(key);') + 1100);
  check('chip 计算新源能力', /const nextCaps = capsFor\(/.test(chip));
  check('不兼容则回落 default', /const keep = sort === 'default' \|\| \(nextCaps != null && nextCaps\.includes\(curKey\)\);/.test(chip));
  check('回落时同步 prevSortRef（否则 sort effect 会重复搜索）', /prevSortRef\.current = 'default'; setSort\('default'\);/.test(chip));
  check('搜索带上新 sort', /category: 'all', sort: nextSort/.test(chip));
}

console.log('');
console.log('Test 4: 面板按 hasQuery 选择能力分支（缺陷 6）');
{
  check('capsFor 定义存在', /function capsFor\(entry, hasQuery\)/.test(c));
  check('browse/search 两套都能选', /hasQuery \? entry\.search : entry\.browse/.test(c));
  const n = (c.match(/capsFor\(sortCaps/g) || []).length;
  check('四处能力读取全部走 capsFor', n === 4, n);
  check('查询词判定用 trim 后的真值', /Boolean\(String\(query \|\| ''\)\.trim\(\)\)/.test(c));
}

console.log('');
console.log('Test 5: MCP registry 不再提供假排序项（缺陷 5，用户拍板严格诚实）');
{
  check('MCP 下拉无 lobehub 三元式硬编码', !/mcpSource === 'lobehub'\s*\?\s*h\('option'/.test(c));
  check('MCP 下拉无 registry 专用 name 选项', !/value: 'name' }, '按名称'\),\n\s*mcpSource/.test(c));
  check('MCP 下拉读服务端表', /sortCaps\.mcp\[mcpSource\]/.test(c));
  check('registry 分支不读 options.sort（服务端事实不变）', !/case "mcp\.search"[\s\S]{0,900}options\.sort/.test(idx));
}

console.log('');
console.log('Test 6: settings.get 下发按路径的两套能力表（服务端契约）');
{
  check('sortCapabilities 存在', /sortCapabilities: \{/.test(idx));
  check('skills 每源含 browse/search', /skills: Object\.fromEntries\(ALL_SOURCES\.map\(\(src\) => \[src, \{/.test(idx));
  check('browse 分支用无参 sortKeysFor', /browse: sortKeysFor\(src\)/.test(idx));
  check('search 分支带 hasQuery', /search: sortKeysFor\(src, \{ hasQuery: true \}\)/.test(idx));
  check('mcp 两源同样双分支', /registry: \{ browse: sortKeysForMcp\("registry"\), search: sortKeysForMcp\("registry", \{ hasQuery: true \}\) \}/.test(idx));
  check('search 返回体不夹带能力表（避免污染缓存键）', !/case "skills\.search"[\s\S]{0,1200}sortCapabilities/.test(idx));
}

console.log('');
console.log('Test 7: 能力表服务端语义（直接 import 纯函数）');
{
  const { sortKeysFor, sortKeysForMcp } = await import('../src/sort-capability.js');
  check('clawhub browse 含 trending', sortKeysFor('clawhub').includes('trending'));
  check('clawhub search 不含 trending（search 行无字段支撑）', !sortKeysFor('clawhub', { hasQuery: true }).includes('trending'));
  const clawSearch = sortKeysFor('clawhub', { hasQuery: true });
  // 名实不符已纠正：能力表不再宣称 installCount，改宣称真实可排的 downloadCount。
  check('clawhub search 不含 installCount（纠正后）', clawSearch.indexOf('installCount') === -1, clawSearch.join(','));
  check('clawhub search 含 downloadCount', clawSearch.indexOf('downloadCount') >= 0, clawSearch.join(','));
  check('clawhub search 其余 4 键仍在', ['stars', 'newest', 'updated', 'name'].every((k) => clawSearch.indexOf(k) >= 0), clawSearch.join(','));
  check('lobehub MCP 无查询为空（CLI 拒收 --sort）', sortKeysForMcp('lobehub').length === 0);
  check('lobehub MCP 带查询两键', JSON.stringify(sortKeysForMcp('lobehub', { hasQuery: true })) === '["installCount","ratingAverage"]');
  check('registry MCP 两路径都空', sortKeysForMcp('registry').length === 0 && sortKeysForMcp('registry', { hasQuery: true }).length === 0);
  check('未知源不给假能力', sortKeysFor('nope').length === 1 && sortKeysForMcp('nope').length === 0);
  // S3（0.5.164）：skills.sh 的 browse 路径排的是 sitemap 目录（src/sources.js:148 只存 owner/slug，
  // :124 skillsShCard 把 installs 写死 0）⇒ sortSkillsShRows 的 installCount 分支是全 0 比较 = 静默不排。
  // 实测（宿主 61246，2026-11-24 17:19，flat RPC body）：browse 空查询下 sort=installCount 与默认序
  // 24 条 slug 序列逐位相同、installs 全 0；带查询走 search API 才真有值（pdf 236,138 / docx 224,636 /
  // canvas-design 138,809）。与 clawhub trending 同一口径：能力随查询形态变化，browse 分支不给排不动的键。
  check('skills.sh browse 不含 installCount（目录行无 installs 字段）', sortKeysFor('skills.sh').indexOf('installCount') === -1, sortKeysFor('skills.sh').join(','));
  check('skills.sh search 仍含 installCount（search API 行带真 installs）', sortKeysFor('skills.sh', { hasQuery: true }).indexOf('installCount') >= 0, sortKeysFor('skills.sh', { hasQuery: true }).join(','));
  check('skills.sh browse 仍给 name（目录可按名字本地排）', sortKeysFor('skills.sh').indexOf('name') >= 0, sortKeysFor('skills.sh').join(','));
}

console.log('');
console.log('Test 8: 语法门');
{
  check('client.js 可解析', !/const CAPS = \{/.test(c));
  check('无裸 require 服务端模块（面板只能走 call）', !/require\('\.\/src/.test(c) && !/require\("\.\/src/.test(c));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
