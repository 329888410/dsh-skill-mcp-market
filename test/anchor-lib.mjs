// anchor-lib.mjs — 节点锚定位的唯一实现，供测试套件与交付核验共用。
//
// 为什么存在：0.5.129 那一轮我用裸 indexOf 手写交付核验，锚串「退出选择」在 client.js 里
// 命中 2 次，且第一次出现在窗口起点之前 → slice 得到空串 → 核验报 FALSE，而实现其实是好的。
// 「核验脚本自己出错」比实现出错更难发现：它给出的结论看起来是实测。所以核验必须走
// 与测试同一套判定：锚不唯一就不给位置，直接 throw。

export function countHits(src, needle) {
  // 空 needle 必须拒绝：V8 里 'ab'.indexOf('', 3) 被钳位返回 2 而不是 -1，
  // 计数循环会永不退出（实测把宿主 pwsh 挂到超时）。锚为空也没有意义。
  if (needle === '') throw new Error('锚串为空：无法定位，也没有任何唯一性可言');
  let hits = 0, i = src.indexOf(needle);
  while (i >= 0) { hits++; i = src.indexOf(needle, i + 1); }
  return hits;
}

// 要求 needle 在 src 里恰好命中 1 次；0 次 = 锚已失效（继续用会得到错误结论），
// 其它次数 = 锚有歧义（slice 窗口可能为空、或跨到别的节点）。两种都 throw。
export function once(src, needle, label) {
  const hits = countHits(src, needle);
  if (hits !== 1) {
    throw new Error('锚不唯一 ' + (label || needle) + '：命中 ' + hits + ' 次（要求恰好 1 次）');
  }
  return src.indexOf(needle);
}

// once 之后取整行：判断某行是否带前缀（如 !batchMode ?）时，锚常落在行中间，
// 用「行首→锚」的切片会漏掉锚前面的内容，取整行才可靠。
export function lineOf(src, idx) {
  const s = src.lastIndexOf(String.fromCharCode(10), idx) + 1;
  const e = src.indexOf(String.fromCharCode(10), idx);
  return src.slice(s, e < 0 ? src.length : e);
}

// 两个唯一锚夹出的区间，语义是 [起锚起点, 尾锚起点) —— 含起锚文本、不含尾锚文本。
// 尾锚必须晚于起锚，否则区间为负 ——
// 这正是 0.5.129 那次空窗口的形态，所以这里显式校验而不是让它静默变空串。
export function sliceBetween(src, startNeedle, endNeedle, label) {
  const a = once(src, startNeedle, label + '/起');
  const b = once(src, endNeedle, label + '/尾');
  if (b <= a) throw new Error('锚顺序颠倒 ' + label + '：尾 ' + b + ' <= 起 ' + a);
  return src.slice(a, b);
}

// absent(src, needle) —— 否定断言专用的「非冲突」判定。
//
// 为什么需要它：`!src.includes('windowed')` 这类断言想说的是「这个标识符不该再出现」，
// 但 includes() 是子串匹配：把它换成 pageWindow 这种**包含它的更长合法标识符**，
// 断言就会误红。同类假阳性本仓库连犯两次（Test 11 的 skillsTotalPages 冒充 skillsTotal、
// test-profile-sync 的 pageWindow 冒充 pageWin），所以它不是孤例而是共性风险。
//
// 规则：只有当 needle 两侧都不是标识符字符（[A-Za-z0-9_]）时才算「出现了这个标识符」。
// 两侧故意不含 $：模板插值 `X（${...}` 的 $ 紧跟中文标签，若当边界会把真存在误判成不存在。
export function absent(src, needle) {
  if (needle === "") throw new Error("absent: needle 不得为空串");
  const isId = (ch) => ch !== undefined && ch >= "0" && (ch <= "9" || (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch === "_");
  let i = -1;
  let hits = 0;
  while ((i = src.indexOf(needle, i + 1)) >= 0) {
    if (!isId(src[i - 1]) && !isId(src[i + needle.length])) hits += 1;
  }
  return hits === 0;
}

// blockEnd(src, startIdx) —— 从 startIdx（该行须含开括号）起按花括号深度找到配对
// 闭括号所在行，跳过字符串、模板串与注释。
// 为什么进库：我两次靠「扫到第一个 trim()==='}' 就停」来定位块尾，结果停在 while/for
// 的内层闭合上，删走半截函数、留下孤立 return（Illegal return statement）。深度扫描
// 是唯一可靠的写法，不该每次临时手搓。
export function blockEnd(src, startIdx, label) {
  const NL = String.fromCharCode(10);
  const lines = String(src).replace(/\r\n/g, NL).split(NL);
  if (startIdx < 0 || startIdx >= lines.length) {
    throw new Error('blockEnd: startIdx ' + startIdx + ' 越界（' + (label || '') + '）');
  }
  let depth = 0;
  let seenOpen = false;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    let q = 0;
    for (let x = 0; x < line.length; x++) {
      const ch = line.charCodeAt(x);
      if (q) { if (ch === 92) x++; else if (ch === q) q = 0; continue; }
      if (ch === 39 || ch === 34 || ch === 96) { q = ch; continue; }
      if (ch === 47 && line.charCodeAt(x + 1) === 47) break;
      if (ch === 47 && line.charCodeAt(x + 1) === 42) { const e = line.indexOf('*/', x + 2); if (e < 0) { x = line.length; } else { x = e + 1; } continue; }
      if (ch === 123) { depth += 1; seenOpen = true; }
      else if (ch === 125) {
        if (!seenOpen) throw new Error('blockEnd: 起点之前出现闭括号（' + (label || '') + '）');
        depth -= 1;
        if (depth === 0) return i;
      }
    }
  }
  throw new Error('blockEnd: 未找到配对闭括号（深度停在 ' + depth + '，' + (label || '') + '）');
}