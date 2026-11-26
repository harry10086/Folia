export interface HeadingItem {
  level: number;
  text: string;
  line: number;
  pos: number;
  slug: string;
}

export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "");
}

export function extractOutline(content: string): HeadingItem[] {
  const lines = content.split("\n");
  const items: HeadingItem[] = [];
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
        const cleanText = m[2].replace(/[*_`~]/g, "").trim();
        items.push({
          level: m[1].length,
          text: cleanText,
          line: i + 1,
          pos: offset,
          slug: slugifyHeading(cleanText),
        });
      }
    }

    offset += line.length + 1;
  }

  return items;
}
