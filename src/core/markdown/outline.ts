export interface HeadingItem {
  level: number;
  text: string;
  line: number;
  pos: number;
  slug: string;
  customId?: string;
}

export const HEADING_CUSTOM_ID_RE = /\s+\{#([A-Za-z0-9_\-\u4e00-\u9fa5]+)\}\s*$/;

export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "");
}

export function extractOutline(content: string): HeadingItem[] {
  const lines = content.split("\n");
  const items: HeadingItem[] = [];
  const slugCounts = new Map<string, number>();
  let inFence = false;
  let fenceChar = "";
  let inFrontmatter = false;
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (i === 0 && trimmed === "---") {
      inFrontmatter = true;
      offset += line.length + 1;
      continue;
    }
    if (inFrontmatter) {
      if (trimmed === "---" || trimmed === "...") {
        inFrontmatter = false;
      }
      offset += line.length + 1;
      continue;
    }

    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fenceMatch) {
      const ch = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
      } else if (ch === fenceChar) {
        inFence = false;
      }
      offset += line.length + 1;
      continue;
    }

    if (!inFence) {
      const m = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
      if (m) {
        let rawTitle = m[2].trim();
        let customId: string | undefined;
        const idM = HEADING_CUSTOM_ID_RE.exec(rawTitle);
        if (idM) {
          customId = idM[1];
          rawTitle = rawTitle.slice(0, idM.index).trim();
        }
        const cleanText = rawTitle.replace(/[*_`~]/g, "").trim();
        const baseSlug = slugifyHeading(cleanText);
        const seen = slugCounts.get(baseSlug) ?? 0;
        slugCounts.set(baseSlug, seen + 1);
        const slug = seen === 0 ? baseSlug : `${baseSlug}-${seen}`;
        items.push({
          level: m[1].length,
          text: cleanText,
          line: i + 1,
          pos: offset,
          slug,
          customId,
        });
      }
    }

    offset += line.length + 1;
  }

  return items;
}

/**
 * Resolve an internal anchor (`#id33`, `#三级标题`, `#hello-world`, `#示例-1`, or HTML `<a id="id33">`)
 * to a 1-based line number in the document.
 */
export function findAnchorLine(content: string, rawAnchor: string): number | null {
  let decoded = rawAnchor.replace(/^#/, "").trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // keep raw
  }
  if (!decoded) return null;

  const lower = decoded.toLowerCase();
  const targetSlug = slugifyHeading(decoded);
  const headings = extractOutline(content);

  // 1) Custom heading ID `{#id33}` (exact / case-insensitive)
  const byCustomId = headings.find((h) => h.customId && h.customId.toLowerCase() === lower);
  if (byCustomId) return byCustomId.line;

  // 2) Auto-generated GitHub-style slug (including duplicate `-1` suffixes)
  const bySlug = headings.find((h) => h.slug === lower || h.slug === targetSlug);
  if (bySlug) return bySlug.line;

  // 3) Plain heading text match
  const byText = headings.find((h) => h.text.toLowerCase() === lower);
  if (byText) return byText.line;

  // 4) HTML anchor `<a id="id33">` / `<span id="id33">` / `<a name="id33">`
  const escaped = decoded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const htmlIdRe = new RegExp(`<[a-zA-Z][^>]*\\b(?:id|name)\\s*=\\s*["']${escaped}["']`, "i");
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (htmlIdRe.test(lines[i])) return i + 1;
  }

  return null;
}
