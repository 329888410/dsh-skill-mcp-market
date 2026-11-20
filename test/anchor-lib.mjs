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