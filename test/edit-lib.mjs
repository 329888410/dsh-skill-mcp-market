// edit-lib.mjs — 收敛「程序改文件」这条路径。
//
// 为什么要有它：手写插入脚本的笔误已连续复发多次（模板字符串占位符在外层先被求值、
// findIndex 回调尾部多写一个符号、needle 引号位置拼错、把一行拆成两个物理行）。
// 「靠下次注意」不成立，所以把纪律做成机制：锚必须唯一、行数变化必须符合预期、
// EOL 必须与源文件原约定一致且不得混用；任何一条不满足就 throw，且**不落盘**
// （先写临时文件、读回校验通过才 rename），避免半成品留在工作树里。
import fs from 'node:fs';
import path from 'node:path';

const CR = String.fromCharCode(13);
const NL = String.fromCharCode(10);

function countEol(text) {
  let crlf = 0;
  let lone = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 13 && text.charCodeAt(i + 1) === 10) { crlf++; i++; }
    else if (text.charCodeAt(i) === 10) lone++;
  }
  return { crlf, lone };
}

export function detectEol(text) {
  const { crlf, lone } = countEol(text);
  if (crlf > 0 && lone > 0) throw new Error('源文件已混用行尾（CRLF=' + crlf + ' loneLF=' + lone + '），先修复再编辑');
  return crlf > 0 ? 'crlf' : 'lf';
}

function asLines(x) {
  if (Array.isArray(x)) return x.map((s) => String(s));
  return String(x).split(/\r\n|\n/);
}

function findSpan(lines, needle) {
  const hits = [];
  outer: for (let i = 0; i + needle.length <= lines.length; i++) {
    for (let k = 0; k < needle.length; k++) if (lines[i + k] !== needle[k]) continue outer;
    hits.push(i);
  }
  return hits;
}

// edits: [{ find, replace }] —— find/replace 可以是字符串或行数组（整行精确匹配）。
export function planEdits(raw, edits) {
  const eol = detectEol(raw);
  const lines = raw.split(/\r\n|\n/);
  let delta = 0;
  const report = [];
  for (const e of edits) {
    const find = asLines(e.find);
    const rep = asLines(e.replace);
    if (!find.length) throw new Error('find 不得为空：空锚无法定位，只会静默改错地方');
    const hits = findSpan(lines, find);
    if (hits.length !== 1) {
      throw new Error('锚 ' + JSON.stringify(find[0]).slice(0, 64) + ' 命中 ' + hits.length + ' 次（要求恰好 1 次）' + (hits.length > 1 ? '，位置 ' + hits.map((h) => h + 1).join(',') : ''));
    }
    lines.splice(hits[0], find.length, ...rep);
    delta += rep.length - find.length;
    report.push({ anchor: find[0].trim().slice(0, 52), at: hits[0] + 1, delta: rep.length - find.length });
  }
  return { eol, text: lines.join(eol === 'crlf' ? CR + NL : NL), delta, report };
}

// 唯一落盘入口：校验全部通过才 rename。dryRun 只做校验与返回，用于先看结果。
export function patchFile(file, edits, opts) {
  const o = opts || {};
  const raw = fs.readFileSync(file, 'utf8');
  const r = planEdits(raw, edits);
  if (typeof o.expectDelta === 'number' && r.delta !== o.expectDelta) {
    throw new Error('行数变化 ' + r.delta + ' ≠ 预期 ' + o.expectDelta + '（插入结构可能不完整）');
  }
  if (o.dryRun) return r;
  const check = (text, where) => {
    const c = countEol(text);
    if (r.eol === 'crlf' && c.lone !== 0) throw new Error(where + ' 出现孤立 LF（' + c.lone + '），源约定 CRLF');
    if (r.eol === 'lf' && c.crlf !== 0) throw new Error(where + ' 混入 CRLF（' + c.crlf + '），源约定 LF');
  };
  check(r.text, '待写内容');
  const abs = path.resolve(file);
  const tmp = abs + '.editlib.tmp';
  fs.writeFileSync(tmp, r.text);
  const back = fs.readFileSync(tmp, 'utf8');
  check(back, '读回校验');
  if (back !== r.text) throw new Error('读回内容与待写不一致，拒绝 rename');
  if (o.expectLines) {
    const got = back.split(/\r\n|\n/).length;
    if (got !== o.expectLines) throw new Error('读回行数 ' + got + ' ≠ 预期 ' + o.expectLines);
  }
  fs.renameSync(tmp, abs);
  return r;
}

// placeBlock —— 把一整块插到锚点的**指定一侧**，落点用内容自检，不接受反直觉标志。
//
// 为什么补这个：我用 keep:'after' 表达「锚之后插入」，实际语义是「锚留在块后面」
//（= 块在锚之前），8 个块里 5 个因此落到错误一侧 —— 而产物语法完全合法、diff 上
// 也看不出问题，只有真跑才暴露。静默错位比报错危险，所以方向必须用 side 明说，
// 且写完立刻读回验证「块与锚的相邻关系」是否符合 side。

// applyOps —— 幂等的块替换：同一份 ops 连跑两次，文件字节必须完全一致。
//
// 事故背景（0.5.134 返工实测）：ops 表里 17 条已应用的 op 仍留在表内，重放把同一块
// 插了两遍（重复 const 声明 → SyntaxError）；另一条 span=2 把 const CAPABILITIES = {
// 整行吃掉。两者都静默发生：语法合法的那次要靠读 diff 才发现。因此：
//   ① 已应用的 op（needle 已不在、块恰好出现一次）→ skip；
//   ② span 覆盖到的声明性行（const/let/var/function/class/export）若未被块原样回归 → throw；
//      needle 本身那行豁免（它是被显式指名要替换的）；
//   ③ needle 0 命中且块不在 → throw（不许静默跳过）；
//   ④ needle 或块多命中 → throw；区间重叠 → throw。任何一条不满足就整体不动文件。
const STRUCTURAL = /^(?:export\s+)?(?:async\s+)?(?:function\s+[\w$]|const\s+[\w$]|let\s+[\w$]|var\s+[\w$]|class\s+[\w$])/;

export function applyOps(file, ops, opts) {
  const o = opts || {};
  const raw = fs.readFileSync(file, 'utf8');
  const eol = detectEol(raw);
  const A = raw.replace(/\r\n/g, NL).split(NL);
  const problems = [];
  const plan = [];
  const spans = [];
  let skipped = 0;
  for (const op of ops) {
    let block = Array.isArray(op.block) ? op.block.map(String) : String(op.block === undefined ? '' : op.block).split(NL);
    while (block.length && block[block.length - 1] === '') block.pop();
    const needle = String(op.needle === undefined ? '' : op.needle);
    if (!needle) { problems.push('applyOps: needle 为空'); continue; }
    if (!block.length) { problems.push('applyOps: 空块 ' + JSON.stringify(needle.slice(0, 40))); continue; }
    if (block.some((l) => /[\r\n]/.test(l))) { problems.push('applyOps: 块内含真实换行（载荷被降级）'); continue; }
    const needleHits = [];
    for (let i = 0; i < A.length; i++) if (A[i].includes(needle)) needleHits.push(i);
    let blockHits = 0;
    for (let i = 0; i + block.length <= A.length; i++) {
      let same = true;
      for (let k = 0; k < block.length; k++) if (A[i + k] !== block[k]) { same = false; break; }
      if (same) blockHits++;
    }
    if (needleHits.length === 0 && blockHits === 1) { skipped++; continue; }
    if (needleHits.length !== 1) { problems.push('applyOps: needle ' + JSON.stringify(needle.slice(0, 44)) + ' 命中 ' + needleHits.length + '（要求恰好 1）'); continue; }
    if (blockHits >= 1) { problems.push('applyOps: 块已在文件中出现 ' + blockHits + ' 次，拒绝重插'); continue; }
    const from = needleHits[0];
    const span = Math.max(1, Number(op.span) || 1);
    const to = from + span - 1;
    if (to >= A.length) { problems.push('applyOps: span 越界'); continue; }
    for (const s of spans) { if (!(to < s.from || from > s.to)) problems.push('applyOps: 区间重叠 ' + (from + 1) + '-' + (to + 1) + ' 与 ' + (s.from + 1) + '-' + (s.to + 1)); }
    const removed = A.slice(from, to + 1);
    const lost = removed.slice(1).filter((l) => {
      const t = l.trim();
      return t !== '' && STRUCTURAL.test(t) && !block.some((b) => b.trim() === t);
    });
    if (lost.length) { problems.push('applyOps: span 吃掉结构锚且块未回归: ' + lost.map((l) => JSON.stringify(l.trim().slice(0, 44))).join(' ')); continue; }
    spans.push({ from: from, to: to });
    plan.push({ from: from, to: to, block: block });
  }
  if (problems.length) throw new Error('applyOps 拒绝执行（文件未改动）: ' + problems.join(' | '));
  plan.sort((x, y) => y.from - x.from);
  for (const p of plan) A.splice(p.from, p.to - p.from + 1, ...p.block);
  if (plan.length && !o.dryRun) {
    const text = A.join(eol === 'crlf' ? CR + NL : NL);
    const tmpPath = path.resolve(file) + '.opstmp';
    fs.writeFileSync(tmpPath, text);
    const back = fs.readFileSync(tmpPath, 'utf8');
    const c = countEol(back);
    if (back !== text || (eol === 'crlf' && c.lone !== 0) || (eol === 'lf' && c.crlf !== 0)) {
      fs.rmSync(tmpPath, { force: true });
      throw new Error('applyOps: 读回校验失败（CRLF=' + c.crlf + ' loneLF=' + c.lone + '），已放弃落盘');
    }
    fs.renameSync(tmpPath, path.resolve(file));
  }
  return { applied: plan.length, skipped: skipped, lines: A.length };
}

// runOpsFile —— 一次性消费 ops 清单：应用成功的条目回写 done:true。ops 文件从此不是
// 「每次重放的脚本」（重复插入事故的源头），而是有状态的工作清单。opsPath 在仓库外
//（核验临时件纪律）；条目格式 { file, needle, span, blockFile, done? }，blockFile 相对 ops 文件。
export function runOpsFile(opsPath) {
  const absOps = path.resolve(opsPath);
  const dir = path.dirname(absOps);
  const entries = JSON.parse(fs.readFileSync(absOps, 'utf8'));
  const tally = { applied: 0, skipped: 0, alreadyDone: 0 };
  for (const e of entries) {
    if (e.done === true) { tally.alreadyDone++; continue; }
    let block = fs.readFileSync(path.resolve(dir, e.blockFile), 'utf8').replace(/\r\n/g, NL).split(NL);
    while (block.length && block[block.length - 1] === '') block.pop();
    applyOps(e.file, [{ needle: e.needle, span: e.span, block: block }]);
    tally.applied++;
    e.done = true;
    fs.writeFileSync(absOps, JSON.stringify(entries, null, 1));
  }
  return tally;
}
export function placeBlock(file, opts) {
  const o = opts || {};
  const block = Array.isArray(o.block) ? o.block.map(String) : null;
  if (!block || !block.length) throw new Error('placeBlock: block 必须是非空行数组');
  for (const l of block) if (/[\r\n]/.test(l)) throw new Error('placeBlock: block 内含真实换行，载荷已被降级');
  const side = o.side;
  if (side !== 'before' && side !== 'after') {
    throw new Error('placeBlock: side 只能是 ' + JSON.stringify('before') + ' 或 ' + JSON.stringify('after') + '，收到 ' + JSON.stringify(side) + '（拒绝猜测方向）');
  }
  if (typeof o.anchor !== 'string' || !o.anchor) throw new Error('placeBlock: anchor 必须是完整行原文');
  const raw = fs.readFileSync(file, 'utf8');
  const eol = detectEol(raw);
  const lines = raw.split(/\r\n|\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) if (lines[i] === o.anchor) hits.push(i);
  if (hits.length !== 1) throw new Error('placeBlock: 锚命中 ' + hits.length + ' 次，要求恰好 1 次');
  const ai = hits[0];
  const at = side === 'before' ? ai : ai + 1;
  const next = lines.slice();
  next.splice(at, 0, ...block);
  // 落点自检（写之前）：块与锚必须按 side 相邻
  if (side === 'before') {
    if (next[at] !== block[0]) throw new Error('placeBlock 自检失败：块首行不在插入位');
    if (next[at + block.length] !== o.anchor) throw new Error('placeBlock 自检失败：side=before 时锚应在块之后');
  } else {
    if (next[ai] !== o.anchor) throw new Error('placeBlock 自检失败：side=after 时锚应在原位');
    if (next[ai + 1] !== block[0]) throw new Error('placeBlock 自检失败：side=after 时块应紧跟锚之后');
  }
  // 邻居内容断言（可选，但强烈建议给）：把「块应挨着什么」写成期望而不是靠肉眼看 diff
  if (o.expectFirstAfter) {
    const probe = side === 'before' ? next[at + block.length + 1] : next[at + block.length];
    if (!probe || probe.indexOf(o.expectFirstAfter) < 0) {
      throw new Error('placeBlock 邻居断言失败：块后应含 ' + JSON.stringify(o.expectFirstAfter).slice(0, 60) + '，实际 ' + JSON.stringify(String(probe)).slice(0, 60));
    }
  }
  if (o.expectLastBefore) {
    const probe = side === 'before' ? next[at - 1] : next[ai];
    if (!probe || probe.indexOf(o.expectLastBefore) < 0) {
      throw new Error('placeBlock 邻居断言失败：块前应含 ' + JSON.stringify(o.expectLastBefore).slice(0, 60) + '，实际 ' + JSON.stringify(String(probe)).slice(0, 60));
    }
  }
  const text = next.join(eol === 'crlf' ? CR + NL : NL);
  if (typeof o.expectDelta === 'number' && next.length - lines.length !== o.expectDelta) {
    throw new Error('placeBlock: 行数变化 ' + (next.length - lines.length) + ' ≠ 预期 ' + o.expectDelta);
  }
  if (o.dryRun) return { lines: next.length - lines.length, text: text };
  const abs = path.resolve(file);
  const tmp = abs + '.placetmp';
  fs.writeFileSync(tmp, text);
  const back = fs.readFileSync(tmp, 'utf8').split(/\r\n|\n/);
  const bi = back.indexOf(o.anchor);
  if (bi < 0) { fs.unlinkSync(tmp); throw new Error('placeBlock: 读回后锚消失，已放弃落盘'); }
  const okBack = side === 'before'
    ? back[bi - block.length] === block[0]
    : back[bi + 1] === block[0];
  if (!okBack) { fs.rmSync(tmp, { force: true }); throw new Error('placeBlock: 读回落点与 side 不符，已放弃落盘'); }
  fs.renameSync(tmp, abs);
  return { lines: next.length - lines.length, at: at + 1 };
}
