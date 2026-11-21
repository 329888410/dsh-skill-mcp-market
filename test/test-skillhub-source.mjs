#!/usr/bin/env node
// test-skillhub-source.mjs — SkillHub 来源适配的行为锁（fetch 桩，零真实网络）。
//
// 三条实测确证的口径缺陷（2026-11-21，直接打 api.skillhub.cn 取证）：
//   ① installs 被覆盖：上游有真实安装数（self-improving-agent installs=86140、
//      find-skills=75956），代码里却写 installs = downloads，于是面板「· N 次安装」
//      显示的是下载数（12,164,786 那个量级）—— 数字与标签不符。
//   ② 排序映射错误：sortBy=installs 服务端有效且跨页单调（实测 30 条 86140…8444），
//      代码却把 installCount 映射到 sortBy=downloads。两种排序首条不同
//      （installs→self-improving-agent，downloads→dev-god），所以用户点「按安装数」
//      实际拿到的是「按下载数」的列表。
//   ③ 搜索参数名错误：传的是 q，上游只认 keyword。实测 q=pdf 返回 total=233498
//      （≈全量 233,498，等于没搜），keyword=pdf 返回 5614。也就是 SkillHub 的
//      关键词搜索一直是无效的，只是返回的仍是「一堆条目」所以看起来像成功。
//   ④ categories() 无任何调用方，且打的 /api/skills/categories 实测 405；
//      真实端点是 /api/v1/categories（返回 {count,items}，**没有 code 字段**）。
//      死导出 + 错误端点 = 该删，而不是接进面板（面板分类来自当前页条目的 category）。
import assert from 'node:assert';

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed += 1; console.log('  OK ' + name); }
  else { failed += 1; console.log('  FAIL ' + name + (detail ? '  [' + String(detail).slice(0, 170) + ']' : '')); }
};

// ── fetch 桩：记录 URL，返回可控 payload ──
const origFetch = globalThis.fetch;
let urls = [];
function stubList(skills, extra) {
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ code: 0, message: 'success', data: Object.assign({ skills, total: skills.length }, extra || {}) }) };
  };
}
function stubEmpty() {
  globalThis.fetch = async (url) => { urls.push(String(url)); return { ok: true, status: 200, json: async () => ({ code: 0, data: { skills: [], total: 0 } }) }; };
}

// 上游真实形状（字段名与实测一致）
const REAL = [
  { slug: 'self-improving-agent', name: 'self-improving agent', description: 'd', downloads: 1736606, installs: 86140, stars: 4551, category: 'ai-agent', namespace: { canonicalName: 'ns/self-improving-agent' } },
  { slug: 'find-skills', name: 'Find Skills', description: 'd', downloads: 1781314, installs: 75956, stars: 1828, category: 'ai-agent', namespace: { canonicalName: 'ns/find-skills' } },
];
// 上游 installs 缺失/为 0 的条目（实测占多数：60 条样本里只有 18 条有值）
const NOINSTALLS = [
  { slug: 'zero', name: 'zero installs', description: 'd', downloads: 999, installs: 0, stars: 3, namespace: { canonicalName: 'ns/zero' } },
];

const mod = await import('../src/skillhub.js');

console.log('Test 1: installs 必须取上游 installs，不被 downloads 覆盖');
{
  urls = [];
  stubList(REAL);
  const r = await mod.searchSkills({ query: '', page: 1, pageSize: 20 });
  const a = r.items[0];
  check('installs 取真实安装数 86140', a.installs === 86140, 'installs=' + a.installs);
  check('downloads 仍保留上游下载数', a.downloads === 1736606, 'downloads=' + a.downloads);
  check('第二条 installs=75956', r.items[1].installs === 75956, r.items[1].installs);
}

console.log('');
console.log('Test 2: installs 为 0 时不得回落到 downloads（宁可不显示，也不显示错数）');
{
  urls = [];
  stubList(NOINSTALLS);
  const r = await mod.searchSkills({ query: '', page: 1, pageSize: 20 });
  check('installs 保持 0', r.items[0].installs === 0, 'installs=' + r.items[0].installs);
  // 卡片是 item.installs ? 显示 : null，0 就是不显示 —— 这是诚实降级，不是缺陷
  check('installs 不等于 downloads', r.items[0].installs !== r.items[0].downloads, 'downloads=' + r.items[0].downloads);
}

console.log('');
console.log('Test 3: 关键词必须用上游真正支持的 keyword 参数（q 被忽略＝搜索无效）');
{
  urls = [];
  stubEmpty();
  await mod.searchSkills({ query: 'pdf', page: 1, pageSize: 20 });
  const u = urls[0] || '';
  check('URL 带 keyword=pdf', u.includes('keyword=pdf'), u);
  check('URL 不再带 q=（被上游忽略）', !/[?&]q=/.test(u), u);
}

console.log('');
console.log('Test 4: installCount 必须映射到上游 sortBy=installs，并显式带 order');
{
  urls = [];
  stubEmpty();
  await mod.searchSkills({ query: '', page: 1, pageSize: 20, sort: 'installCount' });
  const u = urls[0] || '';
  check('sortBy=installs', u.includes('sortBy=installs'), u);
  check('不再映射到 downloads', !u.includes('sortBy=downloads'), u);
  check('显式 order=desc', u.includes('order=desc'), u);
}

console.log('');
console.log('Test 5: 其余排序键按上游文档取值（updated_at 而非被忽略的 updated）');
{
  urls = [];
  stubEmpty();
  await mod.searchSkills({ query: '', page: 1, pageSize: 20, sort: 'updated' });
  const u = urls[0] || '';
  check('updated → sortBy=updated_at', u.includes('sortBy=updated_at'), u);
  urls = [];
  stubEmpty();
  await mod.searchSkills({ query: '', page: 1, pageSize: 20, sort: 'stars' });
  check('stars → sortBy=stars', (urls[0] || '').includes('sortBy=stars'), urls[0]);
  // name 上游返回 400（实测），必须仍走本地排、不发 sortBy=name
  urls = [];
  stubList(REAL);
  const rn = await mod.searchSkills({ query: '', page: 1, pageSize: 20, sort: 'name' });
  check('name 不发 sortBy=name（上游 400）', !(urls[0] || '').includes('sortBy=name'), urls[0]);
  check('name 本地排生效（按名称升序）', rn.items[0].name < rn.items[1].name, rn.items.map((x) => x.name).join(','));
}

console.log('');
console.log('Test 6: 死导出必须移除（无调用方 + 端点 405）');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'skillhub.js'), 'utf8');
  check('不再导出 categories()', !/export async function categories/.test(src), '');
  // 判定范围必须是代码：我写的说明注释里就含 /api/skills/categories 与
  // /api/v1/categories 这两个字面串，拿整份文本 includes 会把「解释为什么删」
  // 误判成「还在请求」—— 正是本轮 Test 7 守卫要防的那类散文冒充命中。
  const code = src.split(/\r?\n/).filter((l) => {
    const s = l.trimStart();
    return !s.startsWith('//') && !s.startsWith('*') && !s.startsWith('/*');
  }).join('\n');
  check('代码里不再请求 categories 端点（实测 405）', !code.includes('/categories'), '');
  // v1 端点的响应没有 code 字段，getJson 的 code!==0 判定会把它当错误 ——
  // 记录这个约束，将来若要接 /api/v1/categories 必须走独立取数路径。
  check('getJson 仍要求 code===0（v1 端点无此字段）', /payload\?\.code !== 0/.test(src), '');
}

console.log('');
console.log('Test 7: 计数口径仍与真实集合一致（total 来自上游，不被本地改动污染）');
{
  urls = [];
  stubList(REAL, { total: 5614 });
  const r = await mod.searchSkills({ query: 'pdf', page: 1, pageSize: 20 });
  check('total 取上游 5614', r.total === 5614, r.total);
  check('items 数与上游返回一致', r.items.length === REAL.length, r.items.length);
  check('页码回显', r.page === 1, r.page);
}

globalThis.fetch = origFetch;
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
