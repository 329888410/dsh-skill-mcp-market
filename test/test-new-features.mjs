// 新功能面回归：回收站（list/restore/empty）、.zip 导入（含上限）、双轨启停、来源分级、会话日志体检、frontmatter 标志写。
// 全程在 mkdtemp 临时目录里跑，不触碰用户的技能目录、回收站与会话日志。
import { tmpdir } from "node:os";
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

import {
  emptyTrash, installSkill, listTrash, restoreFromTrash, skillFileToggleable, toggleSkillFile, uninstallSkill,
} from "../src/skills.js";
import { parseFrontmatter, setFrontmatterFlag, skillMetaFromText } from "../src/frontmatter.js";
import { scanSkillBundle } from "../src/verify.js";
import { readZip } from "../src/zip.js";
import { decodeSessionLog, findCorruption, inspectSessionLog, repairSessionLog, scanZstdFrames, encodeEvents } from "../src/session-repair.js";
import { zstdCompressSync } from "node:zlib";

let pass = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`OK   ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const root = await mkdtemp(join(tmpdir(), "dsh-market-new-"));
const skills = join(root, "skills");
const trash = join(root, "trash");
await mkdir(skills, { recursive: true });

// ---------------------------------------------------------------- frontmatter 标志写
{
  const base = "---\nname: demo\ndescription: d\n---\nbody\n";
  const off = setFrontmatterFlag(base, "disable-model-invocation", true);
  const back = parseFrontmatter(off);
  check("frontmatter：写入禁用标志", back.data["disable-model-invocation"] === "true" && skillMetaFromText(off, "x").disableModelInvocation === true, off.split("\n")[3]);
  check("frontmatter：正文与其它字段不变", back.data.name === "demo" && back.body.trim() === "body");
  const again = setFrontmatterFlag(off, "disable-model-invocation", true);
  check("frontmatter：幂等", again === off);
  const on = setFrontmatterFlag(off, "disable-model-invocation", false);
  check("frontmatter：改回 false", parseFrontmatter(on).data["disable-model-invocation"] === "false" && skillMetaFromText(on, "x").disableModelInvocation === false);
  const removed = setFrontmatterFlag(on, "disable-model-invocation", undefined);
  check("frontmatter：删除标志", !("disable-model-invocation" in parseFrontmatter(removed).data));
  const noFm = setFrontmatterFlag("plain body", "disable-model-invocation", true);
  check("frontmatter：无 frontmatter 时补一个", parseFrontmatter(noFm).data["disable-model-invocation"] === "true" && skillMetaFromText(noFm, "x").disableModelInvocation === true);
}

// ---------------------------------------------------------------- 双轨启停（文件级）
{
  await mkdir(join(skills, "demo"), { recursive: true });
  const sm = join(skills, "demo", "SKILL.md");
  await writeFile(sm, "---\nname: demo\ndescription: d\n---\nbody\n", "utf8");
  check("启停：目录型技能可文件级", skillFileToggleable([skills], "demo"));
  const off = await toggleSkillFile({ dirs: [skills], slug: "demo", enabled: false });
  const text = await readFile(sm, "utf8");
  check("启停：停用写入 frontmatter", off.scope === "file" && /disable-model-invocation: true/.test(text));
  await toggleSkillFile({ dirs: [skills], slug: "demo", enabled: true });
  check("启停：启用改回 false", /disable-model-invocation: false/.test(await readFile(sm, "utf8")));
  const leftovers = (await readdir(join(skills, "demo"))).filter((n) => n.startsWith(".toggle-tmp"));
  check("启停：无临时文件残留", leftovers.length === 0);
  await writeFile(join(skills, "solo.md"), "---\nname: solo\n---\nx\n", "utf8");
  await toggleSkillFile({ dirs: [skills], slug: "solo", enabled: false });
  check("启停：单文件技能同样生效", /disable-model-invocation: true/.test(await readFile(join(skills, "solo.md"), "utf8")));
  check("启停：不存在的技能报错", await toggleSkillFile({ dirs: [skills], slug: "nope", enabled: false }).then(() => false, () => true));
}

// ---------------------------------------------------------------- 回收站
{
  await mkdir(join(skills, "gone"), { recursive: true });
  await writeFile(join(skills, "gone", "SKILL.md"), "---\nname: gone\ndescription: g\n---\nb\n", "utf8");
  const removed = await uninstallSkill({ slug: "gone", dirs: [skills], trashDir: trash });
  check("回收站：删除移入 trash", removed.ok && !existsSync(join(skills, "gone")));
  const listed = await listTrash({ trashDir: trash, dirs: [skills] });
  check("回收站：列出条目", listed.items.length === 1, listed.items[0] && listed.items[0].slug);
  check("回收站：条目记录原始路径", Boolean(listed.items[0] && listed.items[0].originalPath));
  const restored = await restoreFromTrash({ path: listed.items[0].path, dirs: [skills], trashDir: trash });
  check("回收站：恢复到原位置", existsSync(join(skills, "gone", "SKILL.md")), restored.restoredTo);
  check("回收站：恢复后条目消失", (await listTrash({ trashDir: trash, dirs: [skills] })).items.length === 0);

  await uninstallSkill({ slug: "gone", dirs: [skills], trashDir: trash });
  const emptied = await emptyTrash({ trashDir: trash, dirs: [skills] });
  check("回收站：清空", emptied.removed > 0 && (await listTrash({ trashDir: trash, dirs: [skills] })).items.length === 0, `removed=${emptied.removed}`);
}

// ---------------------------------------------------------------- .zip 导入
function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = table[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = Buffer.from(data, "utf8");
    const comp = deflateRawSync(raw);
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(Buffer.concat([lh, nameBuf, comp]));
    centrals.push(Buffer.concat([ch, nameBuf]));
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
{
  const zipPath = join(root, "skill.zip");
  await writeFile(zipPath, makeZip([
    ["zip-skill/SKILL.md", "---\nname: zip-skill\ndescription: from zip\n---\nbody\n"],
    ["zip-skill/extra.md", "extra\n"],
  ]));
  const parsed = readZip(await readFile(zipPath));
  check("zip：解析条目", Object.keys(parsed.files).length === 2, Object.keys(parsed.files).join(","));
  const installed = await installSkill({ source: "zip", reference: zipPath, skillDirs: [skills] });
  check("zip：安装成功", installed.ok === true, `${installed.slug} ${installed.files} 个文件`);
  const onDisk = readdirSync(join(skills, installed.slug));
  check("zip：文件落盘", onDisk.includes("SKILL.md") && onDisk.includes("extra.md"), onDisk.join(","));
  check("zip：零暂存残留", readdirSync(skills).filter((n) => n.startsWith(".staging")).length === 0);

  const evil = makeZip([["../escape/SKILL.md", "---\nname: x\ndescription: y\n---\n"]]);
  const evilParsed = readZip(evil);
  check("zip：路径越界被跳过", Object.keys(evilParsed.files).length === 0 && evilParsed.skipped.length === 1, evilParsed.skipped[0] && evilParsed.skipped[0].reason);
}

// ---------------------------------------------------------------- 来源分级（rank + shadowing）
{
  const skill = async (dir, slug) => {
    await mkdir(join(dir, slug), { recursive: true });
    await writeFile(join(dir, slug, "SKILL.md"), `---\nname: ${slug}\ndescription: d\n---\nb\n`, "utf8");
  };
  const low = join(root, "rank-low");
  const high = join(root, "rank-high");
  await skill(low, "dup");
  await skill(high, "dup");
  await skill(high, "only-high");
  // 与 index.js collectInstalledGrouped 同构的裁决逻辑
  const { listInstalledSkills } = await import("../src/skills.js");
  const all = [];
  for (const [dir, rank, label] of [[low, 200, "用户目录"], [high, 500, "插件提供"]]) {
    for (const item of await listInstalledSkills([dir])) all.push({ ...item, rank, sourceLabel: label });
  }
  const winners = new Map();
  for (const item of all) {
    const cur = winners.get(item.slug);
    if (!cur || item.rank < cur.rank) winners.set(item.slug, item);
  }
  for (const item of all) {
    const w = winners.get(item.slug);
    if (w && w !== item) item.shadowedBy = `${w.sourceLabel}（rank ${w.rank}）`;
  }
  const dupLow = all.find((x) => x.slug === "dup" && x.rank === 200);
  const dupHigh = all.find((x) => x.slug === "dup" && x.rank === 500);
  check("分级：低 rank 胜出", winners.get("dup").rank === 200);
  check("分级：落败者标记 shadowedBy", Boolean(dupHigh && dupHigh.shadowedBy) && !(dupLow && dupLow.shadowedBy), dupHigh && dupHigh.shadowedBy);
  check("分级：唯一技能不标记", !all.find((x) => x.slug === "only-high").shadowedBy);
}

// ---------------------------------------------------------------- 会话日志体检
{
  const good = [
    { type: "session", version: 4 },
    { type: "assistant/message", seq: 1, data: { message: { role: "assistant", content: [{ type: "tool-call", id: "call_1", name: "run_code" }] } } },
    { type: "tool/call", seq: 2, data: { callId: "call_1", name: "run_code" } },
  ];
  const bad = { type: "assistant/message", seq: 3, data: { message: { role: "assistant", content: [{ type: "tool-call", id: "", name: "" }] } } };
  const encode = (events) => zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8"));
  const clean = encode(good);
  check("会话：帧扫描认出 1 帧", scanZstdFrames(clean).frames.length === 1);
  const cleanDecoded = decodeSessionLog(clean);
  check("会话：解码事件数", cleanDecoded.events.length === 3);
  check("会话：正常日志无损坏", findCorruption(cleanDecoded.events) === undefined);

  const dirty = Buffer.concat([encode(good), encode([bad])]);
  const dirtyDecoded = decodeSessionLog(dirty);
  const corruption = findCorruption(dirtyDecoded.events);
  check("会话：多帧拼接可解码", dirtyDecoded.events.length === 4);
  check("会话：空 tool-call 被抓到", Boolean(corruption) && corruption.seq === 3, corruption && corruption.reason);

  const file = join(root, "session.v4.jsonl.zstd");
  await writeFile(file, dirty);
  const dry = await repairSessionLog(file, { dryRun: true });
  check("会话：预演不改文件", dry.repaired === false && (await readFile(file)).length === dirty.length);
  const real = await repairSessionLog(file, {});
  check("会话：修复保留前缀", real.repaired === true && real.keepEvents === 3, `keep=${real.keepEvents} dropped=${real.dropped}`);
  check("会话：修复后有备份", Boolean(real.backup) && existsSync(real.backup));
  const after = await inspectSessionLog(file);
  check("会话：修复后不再损坏", after.corrupt === false && after.events === 3);
  check("会话：修复后单帧", after.frames === 1);

  const noop = await repairSessionLog(join(root, "session.v4.jsonl.zstd"), { dryRun: true });
  check("会话：干净日志无需修复", noop.corruption === null);
}

await rm(root, { recursive: true, force: true });

console.log(`\n${pass} 项通过，${failures.length} 项失败`);
if (failures.length > 0) {
  console.log("失败项：" + failures.join(" | "));
  process.exit(1);
}
