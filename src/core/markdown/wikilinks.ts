import { findAnchorLine } from "@/core/markdown/outline";

export interface ParsedWikilink {
  raw: string;
  filePart: string;
  anchor: string;
  alias: string;
}

/**
 * Parse Obsidian-style wikilink interior:
 * - `Note` -> { filePart: "Note", anchor: "", alias: "" }
 * - `Note#Heading|Alias` -> { filePart: "Note", anchor: "Heading", alias: "Alias" }
 * - `#Heading` -> { filePart: "", anchor: "Heading", alias: "" }
 */
export function parseWikilinkTarget(rawInner: string): ParsedWikilink {
  const pipeIdx = rawInner.indexOf("|");
  const targetPart = (pipeIdx >= 0 ? rawInner.slice(0, pipeIdx) : rawInner).trim();
  const alias = pipeIdx >= 0 ? rawInner.slice(pipeIdx + 1).trim() : "";

  const hashIdx = targetPart.indexOf("#");
  const filePart = (hashIdx >= 0 ? targetPart.slice(0, hashIdx) : targetPart).trim();
  const anchor = hashIdx >= 0 ? targetPart.slice(hashIdx + 1).trim() : "";

  return { raw: rawInner, filePart, anchor, alias };
}

function normSlash(p: string): string {
  return p.replace(/\\/g, "/");
}

function getFileName(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

function getDirPath(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  return idx >= 0 ? cleaned.slice(0, idx) : "";
}

function stripMdExt(name: string): string {
  return name.replace(/\.(md|markdown)$/i, "");
}

function isMdFileName(name: string): boolean {
  return /\.(md|markdown)$/i.test(name);
}

/**
 * Resolve a wikilink target against workspace files (or current note headings for `[[#anchor]]`).
 */
export function findWikilinkFile<T extends { name: string; path: string }>(
  filePart: string,
  candidates: readonly T[]
): T | undefined {
  const clean = normSlash(filePart).replace(/^\/+/, "").toLowerCase();
  if (!clean) return undefined;

  // 1) Exact filename or filename + .md
  const byName = candidates.find((f) => {
    const fn = f.name.toLowerCase();
    return fn === clean || fn === `${clean}.md` || fn === `${clean}.markdown`;
  });
  if (byName) return byName;

  // 2) Subpath suffix match (e.g. `folder/note`)
  if (clean.includes("/")) {
    return candidates.find((f) => {
      const np = normSlash(f.path).toLowerCase();
      return (
        np.endsWith(`/${clean}`) ||
        np.endsWith(`/${clean}.md`) ||
        np.endsWith(`/${clean}.markdown`)
      );
    });
  }
  return undefined;
}

export function isWikilinkTargetValid(
  rawInner: string,
  currentDocText: string,
  workspaceFiles: readonly { name: string; path: string }[]
): boolean {
  const parsed = parseWikilinkTarget(rawInner);
  if (!parsed.filePart) {
    if (!parsed.anchor) return true;
    return findAnchorLine(currentDocText, parsed.anchor) !== null;
  }
  if (workspaceFiles.length === 0) return true;
  return Boolean(findWikilinkFile(parsed.filePart, workspaceFiles));
}

/**
 * Compute POSIX relative path from `fromDir` to `toFile`.
 */
export function computeRelativePosixPath(fromDir: string, toFile: string): string {
  const fromParts = normSlash(fromDir).replace(/\/+$/, "").split("/").filter(Boolean);
  const toParts = normSlash(toFile).replace(/\/+$/, "").split("/").filter(Boolean);

  if (fromParts.length === 0 || toParts.length === 0) return normSlash(toFile);
  if (fromParts[0].toLowerCase() !== toParts[0].toLowerCase()) {
    return normSlash(toFile);
  }

  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common].toLowerCase() === toParts[common].toLowerCase()
  ) {
    common++;
  }

  const ups = Array.from({ length: fromParts.length - common }, () => "..");
  const rest = toParts.slice(common);
  return [...ups, ...rest].join("/") || ".";
}

function resolveSimpleRelative(baseDir: string, relHref: string): string {
  const baseParts = normSlash(baseDir).replace(/\/+$/, "").split("/").filter(Boolean);
  const relParts = normSlash(relHref).split("/");
  const stack = [...baseParts];
  for (const part of relParts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (stack.length > 1) stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join("/");
}

export interface LinkRewriteOptions {
  notePath: string;
  oldPath: string;
  newPath: string;
}

export interface LinkRewriteResult {
  updated: string;
  count: number;
}

/**
 * Safely rewrite both Obsidian wikilinks (`[[...]]` / `![[...]]`) and relative Markdown links
 * (`[label](rel)` / `![alt](rel)`) pointing to `oldPath` -> `newPath`, while NEVER touching
 * fenced code blocks or inline code spans.
 */
export function rewriteLinksInMarkdown(
  content: string,
  opts: LinkRewriteOptions
): LinkRewriteResult {
  const oldName = getFileName(opts.oldPath);
  const newName = getFileName(opts.newPath);
  if (!oldName || !newName || oldName.toLowerCase() === newName.toLowerCase()) {
    return { updated: content, count: 0 };
  }

  const oldNameLower = oldName.toLowerCase();
  const oldIsMd = isMdFileName(oldName);
  const oldStem = oldIsMd ? stripMdExt(oldName) : oldName;
  const oldStemLower = oldStem.toLowerCase();
  const newIsMd = isMdFileName(newName);
  const newStem = newIsMd ? stripMdExt(newName) : newName;

  const noteDir = getDirPath(opts.notePath);
  const oldNormKey = normSlash(opts.oldPath).replace(/^\/+/, "").toLowerCase();
  const newRelPosix = computeRelativePosixPath(noteDir, opts.newPath);

  let count = 0;

  const rewriteTextSegment = (segment: string): string => {
    // 1) Wikilinks `[[...]]` and embedded wikilinks `![[...]]`
    let out = segment.replace(/(!?)\[\[([^\]\r\n]+)\]\]/g, (full, bang: string, inner: string) => {
      const parsed = parseWikilinkTarget(inner);
      if (!parsed.filePart) return full;

      const normFile = normSlash(parsed.filePart);
      const lastSlash = normFile.lastIndexOf("/");
      const dirPrefix = lastSlash >= 0 ? normFile.slice(0, lastSlash + 1) : "";
      const leaf = lastSlash >= 0 ? normFile.slice(lastSlash + 1) : normFile;
      const leafLower = leaf.toLowerCase();

      let replacementLeaf: string | null = null;
      if (leafLower === oldNameLower) {
        replacementLeaf = newName;
      } else if (oldIsMd && leafLower === oldStemLower) {
        replacementLeaf = newStem;
      }

      if (!replacementLeaf) return full;

      // If link had a subpath (e.g. `docs/Old`), make sure it actually matches `oldPath`
      if (dirPrefix) {
        const candidateSuffix = `${dirPrefix}${oldName}`.toLowerCase();
        if (!oldNormKey.endsWith(candidateSuffix) && !oldNormKey.endsWith(`/${candidateSuffix}`)) {
          return full;
        }
      }

      count++;
      const rebuiltTarget = `${dirPrefix}${replacementLeaf}${parsed.anchor ? `#${parsed.anchor}` : ""}`;
      const rebuiltInner = parsed.alias ? `${rebuiltTarget}|${parsed.alias}` : rebuiltTarget;
      return `${bang}[[${rebuiltInner}]]`;
    });

    // 2) Standard Markdown relative links `[label](href)` / `![alt](href)`
    out = out.replace(/(!?\[[^\]]*\])\(([^)\r\n]+)\)/g, (full, labelPart: string, rawDest: string) => {
      const destTrim = rawDest.trim();
      if (!destTrim || /^(?:https?:\/\/|mailto:|tel:|data:|#)/i.test(destTrim)) {
        return full;
      }

      // Separate optional title ` "title"`
      const titleM = /^(\S+|<\s*[^>]+\s*>)(\s+"[^"]*"|\s+'[^']*')?$/.exec(destTrim);
      if (!titleM) return full;
      const rawUrlToken = titleM[1];
      const titleSuffix = titleM[2] ?? "";
      const hadAngles = rawUrlToken.startsWith("<") && rawUrlToken.endsWith(">");
      const unwrapped = hadAngles ? rawUrlToken.slice(1, -1).trim() : rawUrlToken;

      const hashIdx = unwrapped.indexOf("#");
      const pathPart = hashIdx >= 0 ? unwrapped.slice(0, hashIdx) : unwrapped;
      const anchorSuffix = hashIdx >= 0 ? unwrapped.slice(hashIdx) : "";
      if (!pathPart) return full;

      let decodedPath = pathPart;
      try {
        decodedPath = decodeURIComponent(pathPart);
      } catch {
        // keep as-is
      }

      const resolvedKey = resolveSimpleRelative(noteDir, decodedPath).toLowerCase();
      if (resolvedKey !== oldNormKey) return full;

      count++;
      const hadDotSlash = pathPart.startsWith("./");
      let nextPath = newRelPosix;
      if (hadDotSlash && !nextPath.startsWith(".") && !nextPath.startsWith("/")) {
        nextPath = `./${nextPath}`;
      }
      const needsAngles = hadAngles || nextPath.includes(" ");
      const formattedPath = needsAngles
        ? `<${nextPath}${anchorSuffix}>`
        : `${nextPath}${anchorSuffix}`;
      return `${labelPart}(${formattedPath}${titleSuffix})`;
    });

    return out;
  };

  // Preserve fenced code blocks and inline code spans untouched
  const lines = content.split("\n");
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;

  const updatedLines = lines.map((line) => {
    const trimmed = line.trim();
    const fenceM = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fenceM) {
      if (!inFence) {
        inFence = true;
        fenceChar = fenceM[1][0];
        fenceLen = fenceM[1].length;
      } else if (
        fenceM[1][0] === fenceChar &&
        fenceM[1].length >= fenceLen &&
        trimmed.replace(new RegExp(`\\${fenceChar}`, "g"), "").trim() === ""
      ) {
        inFence = false;
      }
      return line;
    }
    if (inFence) return line;

    // Split line by inline code spans so `` `[[Old]]` `` is never rewritten
    const parts = line.split(/(`+[^`\r\n]+`+)/g);
    for (let i = 0; i < parts.length; i += 2) {
      if (parts[i]) parts[i] = rewriteTextSegment(parts[i]);
    }
    return parts.join("");
  });

  return {
    updated: count > 0 ? updatedLines.join("\n") : content,
    count,
  };
}
