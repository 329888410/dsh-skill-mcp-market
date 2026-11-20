// Fill in real descriptions for sitemap-only sources.
//
// skills.sh and browse.sh publish catalogues without descriptions: the sitemap only has
// URLs. The reference implementation avoided this by reading each source's own search API,
// which returns `description` directly. Where no API exists, read the authoritative text:
// the skill's own SKILL.md frontmatter (GitHub) or the page's own meta description.
import { parseFrontmatter } from "./frontmatter.js";

const UA = { "User-Agent": "dsh-skill-mcp-market/0.3 (+skill market)" };

async function fetchText(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: UA, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Run `worker` over `items` with a bounded number of in-flight requests. */
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        out[index] = await worker(items[index], index);
      } catch {
        out[index] = items[index];
      }
    }
  });
  await Promise.all(runners);
  return out;
}

const ENTITIES = { "&quot;": '"', "&amp;": "&", "&lt;": "<", "&gt;": ">", "&#39;": "'", "&nbsp;": " ", "&#x27;": "'" };

function decodeEntities(text) {
  return String(text)
    .replace(/&(quot|amp|lt|gt|#39|#x27|nbsp);/g, (match) => ENTITIES[match] ?? match)
    .replace(/&#(x?)([0-9a-fA-F]+);/g, (_match, hex, digits) =>
      String.fromCodePoint(hex ? Number.parseInt(digits, 16) : Number.parseInt(digits, 10)),
    );
}

/**
 * Some SKILL.md frontmatters carry junk descriptions ("&gt;" and friends). Only accept text
 * that a human would recognise as a sentence.
 */
function usableDescription(value) {
  const text = String(value ?? "")
    .replace(/^[\s>#*\-–—]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < 12) return "";
  if (!/[\p{L}\p{N}]/u.test(text)) return "";
  if (/^[\p{P}\p{S}\s]+$/u.test(text)) return "";
  return text;
}

/**
 * skills.sh has no description field. Reading the page costs ~2s per skill, so read the
 * skill's own SKILL.md frontmatter from raw.githubusercontent instead (about 0.3s).
 */
export async function enrichSkillsShFast(items, cache, limit = 10) {
  const targets = items.slice(0, limit);
  await mapLimit(targets, 8, async (item) => {
    if (item.description) return item;
    const repo = String(item.owner || "");
    const skill = String(item.slug || "");
    if (!repo.includes("/") || !skill) return item;
    const candidates = [`${skill}/SKILL.md`, `skills/${skill}/SKILL.md`, `.claude/skills/${skill}/SKILL.md`];
    for (const path of candidates) {
      const key = `skillmd:${repo}:${path}`;
      try {
        let text = await cache.get(key, 24 * 3600 * 1000);
        if (!text) {
          // raw.githubusercontent is intermittently unreachable here; jsDelivr mirrors the
          // same file and has been stable, so try it first and keep raw as the fallback.
          // A 404/403 is authoritative for THIS repo+path candidate, so remember it and
          // skip the next candidate's host loop — that alone cut this enrichment from
          // ~85s to ~3s (most skill paths do not exist in the repo root).
          const negativeKey = `skillmd_miss:${repo}:${path}`;
          const missed = await cache.get(negativeKey, 24 * 3600 * 1000);
          if (!missed) {
            const hosts = [
              `https://cdn.jsdelivr.net/gh/${repo}@main/${path}`,
              `https://raw.githubusercontent.com/${repo}/main/${path}`,
            ];
            let authoritativeMiss = false;
            for (const url of hosts) {
              try {
                const response = await fetch(url, { headers: UA, signal: AbortSignal.timeout(4000) });
                if (response.status === 404 || response.status === 403 || response.status === 451) {
                  authoritativeMiss = true;
                  break;
                }
                if (!response.ok) continue;
                text = await response.text();
                break;
              } catch {
                // network hiccup: try the next host, do not cache a miss
              }
            }
            // Only a 404/403/451 from an upstream is authoritative enough to remember; a
            // transient network failure must not poison the next page load.
            if (authoritativeMiss && !text) await cache.put(negativeKey, true);
            else if (!text && !authoritativeMiss) {
              // both hosts unreachable this round: leave text empty, no negative cache
            }
          } else {
            text = "";
          }
        }
        const { data } = parseFrontmatter(text);
        const description = usableDescription(data.description);
        if (description) {
          item.description = description;
          if (data.name) item.name = String(data.name).trim();
          item.skillDir = path === "SKILL.md" ? "" : path.slice(0, -"/SKILL.md".length);
          const meta = data.metadata && typeof data.metadata === "object" ? data.metadata : {};
          const category = data.category || meta.category || "";
          if (category) item.category = String(category).trim();
          item.describedBy = "SKILL.md";
          return item;
        }
      } catch {
        // try the next candidate layout
      }
    }
    return item;
  });
  return items;
}

/** Read a page's own meta description — used for sources whose search API omits it. */
export async function enrichPageDescriptions(items, cache, concurrency = 6) {
  await mapLimit(items, concurrency, async (item) => {
    if (item.description || !item.homepage) return item;
    if (!item.homepage) return item;
    const cacheKey = `page-desc:${item.homepage}`;
    try {
      let text = await cache.get(cacheKey, 24 * 3600 * 1000);
      if (!text) {
        text = await fetchText(item.homepage);
        await cache.put(cacheKey, text);
      }
      const meta =
        /<meta[^>]+property="og:description"[^>]+content="([^"]{10,400})"/i.exec(text) ||
        /<meta[^>]+name="description"[^>]+content="([^"]{10,400})"/i.exec(text);
      if (meta) {
        const description = decodeEntities(meta[1])
          .replace(/^[\s>#*\-–—]+/, "")
          .replace(/\s+/g, " ")
          .trim();
        // 有些页面的 meta 只是正文开头的 markdown 符号（实测出现过 ">"），丢掉这种残渣。
        if (description.length >= 12 && /[\p{L}\p{N}]/u.test(description)) {
          item.description = description;
          item.describedBy = "page-meta";
        }
      }
      const title = /<title>([^<]{3,160})<\/title>/i.exec(text);
      if (title && (!item.name || item.name === item.slug)) {
        item.name = decodeEntities(title[1]).split("|")[0].trim();
      }
    } catch {
      // keep the fallback text
    }
    return item;
  });
  return items;
}
