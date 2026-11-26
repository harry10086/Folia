import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { toAssetUrl } from "@/core/ipc/client";

export interface LivePreviewCallbacks {
  getNotePath: () => string | null;
  isLiveMode: () => boolean;
  isLargeFile: () => boolean;
  onNavigateLink: (href: string, isWiki: boolean) => void;
  onImageClick?: (src: string, alt: string) => void;
}

const refreshLivePreviewEffect = StateEffect.define<null>();

const EMOJI_SHORTCODES: Record<string, string> = {
  rocket: "🚀",
  sparkles: "✨",
  fire: "🔥",
  check: "✅",
  warning: "⚠️",
  bulb: "💡",
  memo: "📝",
  book: "📖",
  star: "⭐",
  heart: "❤️",
  tada: "🎉",
  bug: "🐛",
  wrench: "🔧",
  pin: "📌",
  folder: "📁",
  lock: "🔒",
  thumbsup: "👍",
};

let katexModulePromise: Promise<typeof import("katex")> | null = null;
function loadKatex() {
  if (!katexModulePromise) {
    katexModulePromise = import("katex");
  }
  return katexModulePromise;
}

let mermaidModulePromise: Promise<typeof import("mermaid")> | null = null;
let mermaidInitialized = false;
async function loadMermaid() {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import("mermaid");
  }
  const mod = await mermaidModulePromise;
  if (!mermaidInitialized) {
    mod.default.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: document.documentElement.dataset.themeMode === "dark" ? "dark" : "default",
    });
    mermaidInitialized = true;
  }
  return mod.default;
}

export function resolveImageSrc(rawSrc: string, notePath: string | null): string {
  const cleaned = rawSrc.trim().replace(/^<|>$/g, "");
  if (/^(https?:|data:|blob:|folia-asset:)/i.test(cleaned)) {
    return cleaned;
  }
  if (!notePath) return cleaned;

  const noteNorm = notePath.replace(/\\/g, "/");
  const parts = noteNorm.split("/");
  parts.pop();

  let decodedRel = cleaned;
  try {
    decodedRel = decodeURIComponent(cleaned);
  } catch {
    // keep raw
  }

  for (const seg of decodedRel.replace(/\\/g, "/").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 1) parts.pop();
    } else {
      parts.push(seg);
    }
  }
  const abs = parts.join("/");
  return toAssetUrl(abs, undefined, notePath);
}

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly pos: number
  ) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.pos === this.pos;
  }
  toDOM(view: EditorView) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = this.checked;
    input.className = "folia-md-checkbox";
    input.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const next = this.checked ? "[ ]" : "[x]";
      view.dispatch({
        changes: { from: this.pos, to: this.pos + 3, insert: next },
      });
    });
    return input;
  }
  ignoreEvent() {
    return true;
  }
}

class ImagePreviewWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly onClick?: (src: string, alt: string) => void
  ) {
    super();
  }
  eq(other: ImagePreviewWidget) {
    return other.src === this.src && other.alt === this.alt;
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "folia-md-image-wrap";
    const img = document.createElement("img");
    img.src = this.src;
    img.alt = this.alt;
    img.loading = "lazy";
    img.className = "folia-md-image";
    img.addEventListener("click", () => this.onClick?.(this.src, this.alt));
    img.addEventListener("error", () => {
      wrap.classList.add("is-error");
      const err = document.createElement("span");
      err.className = "folia-md-image-error";
      err.textContent = `无法加载图片: ${this.alt || this.src}`;
      wrap.innerHTML = "";
      wrap.appendChild(err);
    });
    wrap.appendChild(img);
    if (this.alt) {
      const cap = document.createElement("div");
      cap.className = "folia-md-image-caption";
      cap.textContent = this.alt;
      wrap.appendChild(cap);
    }
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

class HrWidget extends WidgetType {
  toDOM() {
    const hr = document.createElement("div");
    hr.className = "folia-md-hr";
    return hr;
  }
  ignoreEvent() {
    return false;
  }
}

class EmojiWidget extends WidgetType {
  constructor(readonly emoji: string) {
    super();
  }
  eq(other: EmojiWidget) {
    return other.emoji === this.emoji;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "folia-md-emoji";
    span.textContent = this.emoji;
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly displayMode: boolean
  ) {
    super();
  }
  eq(other: MathWidget) {
    return other.tex === this.tex && other.displayMode === this.displayMode;
  }
  toDOM() {
    const el = document.createElement(this.displayMode ? "div" : "span");
    el.className = this.displayMode ? "folia-md-math-block" : "folia-md-math-inline";
    el.textContent = this.tex;
    loadKatex()
      .then((katex) => {
        katex.default.render(this.tex, el, {
          displayMode: this.displayMode,
          throwOnError: false,
          strict: false,
        });
      })
      .catch(() => {
        el.textContent = this.tex;
      });
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

class MermaidWidget extends WidgetType {
  constructor(readonly code: string) {
    super();
  }
  eq(other: MermaidWidget) {
    return other.code === this.code;
  }
  toDOM() {
    const box = document.createElement("div");
    box.className = "folia-md-mermaid";
    box.textContent = "正在渲染 Mermaid 图表...";
    const renderId = `folia-mmd-${Math.random().toString(36).slice(2, 9)}`;
    loadMermaid()
      .then(async (mermaid) => {
        const { svg } = await mermaid.render(renderId, this.code);
        box.innerHTML = svg;
      })
      .catch((err) => {
        box.classList.add("is-error");
        box.textContent = `Mermaid 语法错误: ${err?.message ?? err}`;
      });
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

class TableWidget extends WidgetType {
  constructor(readonly rawMarkdown: string) {
    super();
  }
  eq(other: TableWidget) {
    return other.rawMarkdown === this.rawMarkdown;
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "folia-md-table-wrap";
    const lines = this.rawMarkdown.trim().split("\n");
    if (lines.length < 2) return wrap;

    const parseRow = (row: string) =>
      row
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim());

    const headers = parseRow(lines[0]);
    const table = document.createElement("table");
    table.className = "folia-md-table";

    const thead = document.createElement("thead");
    const trHead = document.createElement("tr");
    for (const h of headers) {
      const th = document.createElement("th");
      th.innerHTML = renderSimpleInlineHtml(h);
      trHead.appendChild(th);
    }
    thead.appendChild(trHead);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (let i = 2; i < lines.length; i++) {
      const cells = parseRow(lines[i]);
      const tr = document.createElement("tr");
      for (let c = 0; c < headers.length; c++) {
        const td = document.createElement("td");
        td.innerHTML = renderSimpleInlineHtml(cells[c] ?? "");
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderSimpleInlineHtml(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  out = out.replace(/==([^=]+)==/g, "<mark>$1</mark>");
  return out;
}

class CalloutBadgeWidget extends WidgetType {
  constructor(
    readonly kind: string,
    readonly showKindText: boolean
  ) {
    super();
  }
  eq(other: CalloutBadgeWidget) {
    return other.kind === this.kind && other.showKindText === this.showKindText;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = `folia-callout-badge is-${this.kind.toLowerCase()}`;
    const iconMap: Record<string, string> = {
      TIP: "💡",
      NOTE: "ℹ️",
      IMPORTANT: "📌",
      WARNING: "⚠️",
      CAUTION: "🛑",
    };
    const icon = iconMap[this.kind.toUpperCase()] ?? "ℹ️";
    el.textContent = this.showKindText ? `${icon} ${this.kind}` : `${icon} `;
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

type DecoKind = "line" | "replace" | "mark" | "widget";

interface DecoItem {
  from: number;
  to: number;
  kind: DecoKind;
  deco: Decoration;
}

function isRangeActive(
  view: EditorView,
  from: number,
  to: number,
  expandOnlyWhenCollapsed: boolean
): boolean {
  for (const range of view.state.selection.ranges) {
    if (expandOnlyWhenCollapsed && !range.empty) continue;
    if (range.from <= to && range.to >= from) return true;
  }
  return false;
}

export function assembleSafeDecorationSet(items: DecoItem[]): DecorationSet {
  const lineItems: DecoItem[] = [];
  const replaceItems: DecoItem[] = [];
  const markItems: DecoItem[] = [];
  const widgetItems: DecoItem[] = [];

  for (const item of items) {
    if (item.from < 0 || item.to < item.from) continue;
    if (item.kind === "line") {
      if (item.from === item.to) lineItems.push(item);
    } else if (item.kind === "replace") {
      if (item.from < item.to) replaceItems.push(item);
    } else if (item.kind === "mark") {
      if (item.from < item.to) markItems.push(item);
    } else {
      widgetItems.push(item);
    }
  }

  // 1) Resolve non-overlapping replace ranges (earlier start wins; longer span wins on tie)
  replaceItems.sort((a, b) => a.from - b.from || b.to - a.to);
  const acceptedReplaces: DecoItem[] = [];
  let lastReplaceEnd = -1;
  for (const r of replaceItems) {
    if (r.from < lastReplaceEnd) continue;
    acceptedReplaces.push(r);
    lastReplaceEnd = r.to;
  }

  const overlapsAnyReplace = (from: number, to: number) =>
    acceptedReplaces.some((r) => r.from < to && r.to > from);

  const insideAnyReplace = (pos: number) =>
    acceptedReplaces.some((r) => r.from < pos && pos < r.to);

  // 2) Keep only marks & point widgets that do not collide with any replace range
  const finalItems: DecoItem[] = [...lineItems, ...acceptedReplaces];
  for (const m of markItems) {
    if (!overlapsAnyReplace(m.from, m.to)) {
      finalItems.push(m);
    }
  }
  for (const w of widgetItems) {
    if (!insideAnyReplace(w.from)) {
      finalItems.push(w);
    }
  }

  // 3) Sort strictly by CodeMirror 6 RangeSetBuilder ordering: from ASC, startSide ASC, to ASC
  finalItems.sort(
    (a, b) =>
      a.from - b.from ||
      a.deco.startSide - b.deco.startSide ||
      a.to - b.to
  );

  const builder = new RangeSetBuilder<Decoration>();
  let prevFrom = -1;
  let prevStartSide = -Infinity;
  for (const item of finalItems) {
    const startSide = item.deco.startSide;
    if (item.from < prevFrom) continue;
    if (item.from === prevFrom && startSide < prevStartSide) continue;
    builder.add(item.from, item.to, item.deco);
    prevFrom = item.from;
    prevStartSide = startSide;
  }
  return builder.finish();
}

function buildLineAndInlineDecorations(
  view: EditorView,
  cb: LivePreviewCallbacks,
  expandOnlyWhenCollapsed = false
): DecorationSet {
  try {
    const doc = view.state.doc;
    const live = cb.isLiveMode() && !cb.isLargeFile();
    const notePath = cb.getNotePath();
    const items: DecoItem[] = [];

    const maxEndLine = view.visibleRanges.reduce(
      (acc, r) => Math.max(acc, doc.lineAt(r.to).number),
      1
    );

    let inFrontmatter = false;
    let inCodeFence = false;
    let codeFenceLang = "";
    let inMathBlock = false;

    const lineContext = new Map<
      number,
      { inFrontmatter: boolean; inCodeFence: boolean; codeFenceLang: string; inMathBlock: boolean }
    >();

    for (let ln = 1; ln <= maxEndLine; ln++) {
      const text = doc.line(ln).text;
      const trimmed = text.trim();

      if (ln === 1 && trimmed === "---") {
        inFrontmatter = true;
        lineContext.set(ln, { inFrontmatter: true, inCodeFence: false, codeFenceLang: "", inMathBlock: false });
        continue;
      }
      if (inFrontmatter) {
        lineContext.set(ln, { inFrontmatter: true, inCodeFence: false, codeFenceLang: "", inMathBlock: false });
        if (trimmed === "---" || trimmed === "...") inFrontmatter = false;
        continue;
      }

      const fence = /^(`{3,}|~{3,})(.*)$/.exec(trimmed);
      if (fence && !inMathBlock) {
        if (!inCodeFence) {
          inCodeFence = true;
          codeFenceLang = fence[2].trim().toLowerCase();
        } else {
          inCodeFence = false;
          codeFenceLang = "";
        }
        lineContext.set(ln, { inFrontmatter: false, inCodeFence: true, codeFenceLang, inMathBlock: false });
        continue;
      }

      if (!inCodeFence && trimmed === "$$") {
        inMathBlock = !inMathBlock;
        lineContext.set(ln, { inFrontmatter: false, inCodeFence: false, codeFenceLang: "", inMathBlock: true });
        continue;
      }

      lineContext.set(ln, { inFrontmatter, inCodeFence, codeFenceLang, inMathBlock });
    }

    const processedLines = new Set<number>();

    for (const range of view.visibleRanges) {
      const startLine = doc.lineAt(range.from).number;
      const endLine = doc.lineAt(range.to).number;

      for (let ln = startLine; ln <= endLine; ln++) {
        if (processedLines.has(ln)) continue;
        processedLines.add(ln);

        const line = doc.line(ln);
        const text = line.text;
        const ctx = lineContext.get(ln);
        const lineActive = isRangeActive(view, line.from, line.to, expandOnlyWhenCollapsed);

        if (ctx?.inFrontmatter) {
          items.push({ from: line.from, to: line.from, kind: "line", deco: Decoration.line({ class: "cm-md-frontmatter-line" }) });
          continue;
        }
        if (ctx?.inCodeFence) {
          items.push({ from: line.from, to: line.from, kind: "line", deco: Decoration.line({ class: "cm-md-codeblock-line" }) });
          continue;
        }
        if (ctx?.inMathBlock) {
          items.push({ from: line.from, to: line.from, kind: "line", deco: Decoration.line({ class: "cm-md-math-source-line" }) });
          continue;
        }

        const protectedSpans: Array<{ start: number; end: number }> = [];

        const headingMatch = /^(#{1,6})(\s+)(.*)$/.exec(text);
        if (headingMatch) {
          const level = headingMatch[1].length;
          items.push({ from: line.from, to: line.from, kind: "line", deco: Decoration.line({ class: `cm-md-h cm-md-h${level}` }) });
          const markerEnd = line.from + headingMatch[1].length + headingMatch[2].length;
          protectedSpans.push({ start: line.from, end: markerEnd });
          if (live && !lineActive) {
            items.push({ from: line.from, to: markerEnd, kind: "replace", deco: Decoration.replace({}) });
          } else {
            items.push({ from: line.from, to: markerEnd, kind: "mark", deco: Decoration.mark({ class: "cm-md-syntax" }) });
          }
        }

        if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(text.trim())) {
          if (live && !lineActive) {
            items.push({ from: line.from, to: line.to, kind: "replace", deco: Decoration.replace({ widget: new HrWidget() }) });
            continue;
          } else {
            items.push({ from: line.from, to: line.to, kind: "mark", deco: Decoration.mark({ class: "cm-md-syntax" }) });
            continue;
          }
        }

        const calloutMatch = /^(\s*>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*)(.*)$/i.exec(text);
        if (calloutMatch) {
          const prefixLen = calloutMatch[1].length;
          const kind = calloutMatch[2].toUpperCase();
          const hasTitle = calloutMatch[3].trim().length > 0;
          items.push({ from: line.from, to: line.from, kind: "line", deco: Decoration.line({ class: `cm-md-callout cm-md-callout-${kind.toLowerCase()}` }) });
          protectedSpans.push({ start: line.from, end: line.from + prefixLen });
          if (live && !lineActive) {
            // Only replace the `> [!TIP] ` syntax prefix; keep the title text directly selectable & copyable!
            items.push({
              from: line.from,
              to: line.from + prefixLen,
              kind: "replace",
              deco: Decoration.replace({ widget: new CalloutBadgeWidget(kind, !hasTitle) }),
            });
            if (hasTitle) {
              items.push({
                from: line.from + prefixLen,
                to: line.to,
                kind: "mark",
                deco: Decoration.mark({ class: "cm-md-callout-title" }),
              });
            }
            continue;
          } else {
            items.push({
              from: line.from,
              to: line.from + prefixLen,
              kind: "mark",
              deco: Decoration.mark({ class: "cm-md-syntax" }),
            });
          }
        } else if (/^\s*>/.test(text)) {
          items.push({ from: line.from, to: line.from, kind: "line", deco: Decoration.line({ class: "cm-md-quote-line" }) });
          const qm = /^\s*>\s?/.exec(text);
          if (qm) {
            protectedSpans.push({ start: line.from, end: line.from + qm[0].length });
            items.push({ from: line.from, to: line.from + qm[0].length, kind: "mark", deco: Decoration.mark({ class: "cm-md-syntax" }) });
          }
        }

        const taskMatch = /^(\s*[-*+]\s+)(\[[ xX]\])/.exec(text);
        if (taskMatch) {
          const boxStart = line.from + taskMatch[1].length;
          const checked = taskMatch[2].toLowerCase() === "[x]";
          protectedSpans.push({ start: boxStart, end: boxStart + 3 });
          if (live && !lineActive) {
            items.push({
              from: boxStart,
              to: boxStart + 3,
              kind: "replace",
              deco: Decoration.replace({ widget: new CheckboxWidget(checked, boxStart) }),
            });
          }
          if (checked && boxStart + 3 < line.to) {
            items.push({ from: boxStart + 3, to: line.to, kind: "mark", deco: Decoration.mark({ class: "cm-md-task-done" }) });
          }
        }

        // Images: standard ![alt](src), linked image [![alt](src)](href), and Obsidian ![[image.png|width]]
        const linkedImgRegex = /\[!\[([^\]]*)\]\(([^)\s]+(?:\s+"[^"]*")?)\)\]\(([^)]+)\)/g;
        let lim: RegExpExecArray | null;
        while ((lim = linkedImgRegex.exec(text)) !== null) {
          const from = line.from + lim.index;
          const to = from + lim[0].length;
          protectedSpans.push({ start: from, end: to });
          if (live) {
            const rawUrl = lim[2].replace(/\s+"[^"]*"$/, "");
            const resolved = resolveImageSrc(rawUrl, notePath);
            const widget = new ImagePreviewWidget(resolved, lim[1], cb.onImageClick);
            if (!lineActive && lim[0].trim() === text.trim()) {
              items.push({ from, to, kind: "replace", deco: Decoration.replace({ widget }) });
            } else {
              items.push({ from: to, to, kind: "widget", deco: Decoration.widget({ widget, side: 1 }) });
            }
          }
        }

        const imgRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
        let imgM: RegExpExecArray | null;
        while ((imgM = imgRegex.exec(text)) !== null) {
          const from = line.from + imgM.index;
          const to = from + imgM[0].length;
          if (protectedSpans.some((s) => from < s.end && to > s.start)) continue;
          protectedSpans.push({ start: from, end: to });
          if (live) {
            const rawUrl = imgM[2].trim().replace(/\s+"[^"]*"$/, "");
            const resolved = resolveImageSrc(rawUrl, notePath);
            const widget = new ImagePreviewWidget(resolved, imgM[1], cb.onImageClick);
            if (!lineActive && imgM[0].trim() === text.trim()) {
              items.push({ from, to, kind: "replace", deco: Decoration.replace({ widget }) });
            } else {
              items.push({ from: to, to, kind: "widget", deco: Decoration.widget({ widget, side: 1 }) });
            }
          }
        }

        const wikiImgRegex = /!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;
        let wim: RegExpExecArray | null;
        while ((wim = wikiImgRegex.exec(text)) !== null) {
          const from = line.from + wim.index;
          const to = from + wim[0].length;
          if (protectedSpans.some((s) => from < s.end && to > s.start)) continue;
          protectedSpans.push({ start: from, end: to });
          if (live) {
            const targetFile = wim[1].trim();
            const alt = wim[2]?.trim() || targetFile;
            const resolved = resolveImageSrc(targetFile, notePath);
            const widget = new ImagePreviewWidget(resolved, alt, cb.onImageClick);
            if (!lineActive && wim[0].trim() === text.trim()) {
              items.push({ from, to, kind: "replace", deco: Decoration.replace({ widget }) });
            } else {
              items.push({ from: to, to, kind: "widget", deco: Decoration.widget({ widget, side: 1 }) });
            }
          }
        }

        decorateInlinePatterns(line.from, text, live && !lineActive, items, protectedSpans);
      }
    }

    return assembleSafeDecorationSet(items);
  } catch (err) {
    console.error("Folia live preview decoration error:", err);
    return Decoration.none;
  }
}

function decorateInlinePatterns(
  lineFrom: number,
  text: string,
  hideMarkers: boolean,
  items: DecoItem[],
  protectedSpans: Array<{ start: number; end: number }> = []
) {
  const overlapsProtected = (start: number, end: number) =>
    protectedSpans.some((s) => start < s.end && end > s.start);

  const claimSpan = (start: number, end: number) => {
    protectedSpans.push({ start, end });
  };

  // 1) Inline code FIRST — content inside backticks must NEVER be parsed as math/emoji/bold/links!
  const codeRe = /`([^`\n]+)`/g;
  let cm: RegExpExecArray | null;
  while ((cm = codeRe.exec(text)) !== null) {
    const start = lineFrom + cm.index;
    const end = start + cm[0].length;
    if (overlapsProtected(start, end)) continue;
    claimSpan(start, end);
    const innerStart = start + 1;
    const innerEnd = end - 1;
    if (hideMarkers) {
      items.push({ from: start, to: innerStart, kind: "replace", deco: Decoration.replace({}) });
      items.push({ from: innerStart, to: innerEnd, kind: "mark", deco: Decoration.mark({ class: "cm-md-inline-code" }) });
      items.push({ from: innerEnd, to: end, kind: "replace", deco: Decoration.replace({}) });
    } else {
      items.push({ from: start, to: innerStart, kind: "mark", deco: Decoration.mark({ class: "cm-md-syntax" }) });
      items.push({ from: innerStart, to: innerEnd, kind: "mark", deco: Decoration.mark({ class: "cm-md-inline-code" }) });
      items.push({ from: innerEnd, to: end, kind: "mark", deco: Decoration.mark({ class: "cm-md-syntax" }) });
    }
  }

  // 2) Inline KaTeX math ($...$) — claim span so *, ^, ~ inside math are never treated as Markdown!
  if (hideMarkers) {
    const mathRe = /(?<!\$)\$([^$\n]+)\$(?!\$)/g;
    let mm: RegExpExecArray | null;
    while ((mm = mathRe.exec(text)) !== null) {
      const start = lineFrom + mm.index;
      const end = start + mm[0].length;
      if (overlapsProtected(start, end)) continue;
      if (!mm[1].trim()) continue;
      claimSpan(start, end);
      items.push({
        from: start,
        to: end,
        kind: "replace",
        deco: Decoration.replace({ widget: new MathWidget(mm[1], false) }),
      });
    }
  }

  // 3) Standard Markdown links [label](url) & Wikilinks [[target]]
  const linkRe = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;
  let lm: RegExpExecArray | null;
  while ((lm = linkRe.exec(text)) !== null) {
    const start = lineFrom + lm.index;
    const end = start + lm[0].length;
    if (overlapsProtected(start, end)) continue;
    claimSpan(start, end);
    const labelStart = start + 1;
    const labelEnd = labelStart + lm[1].length;
    const attrs = { "data-folia-href": lm[2], "data-folia-wiki": "false", title: `Ctrl/Cmd + 点击打开: ${lm[2]}` };

    if (hideMarkers) {
      items.push({ from: start, to: labelStart, kind: "replace", deco: Decoration.replace({}) });
      items.push({ from: labelStart, to: labelEnd, kind: "mark", deco: Decoration.mark({ class: "cm-md-link", attributes: attrs }) });
      items.push({ from: labelEnd, to: end, kind: "replace", deco: Decoration.replace({}) });
    } else {
      items.push({ from: start, to: labelStart, kind: "mark", deco: Decoration.mark({ class: "cm-md-syntax" }) });
      items.push({ from: labelStart, to: labelEnd, kind: "mark", deco: Decoration.mark({ class: "cm-md-link", attributes: attrs }) });
      items.push({ from: labelEnd, to: end, kind: "mark", deco: Decoration.mark({ class: "cm-md-syntax" }) });
    }
  }

  const wikiRe = /(?<!!)\[\[([^\]]+)\]\]/g;
  let wm: RegExpExecArray | null;
  while ((wm = wikiRe.exec(text)) !== null) {
    const start = lineFrom + wm.index;
    const end = start + wm[0].length;
    if (overlapsProtected(start, end)) continue;
    claimSpan(start, end);
    const innerStart = start + 2;
    const innerEnd = start + wm[0].length - 2;
    const attrs = { "data-folia-href": wm[1], "data-folia-wiki": "true", title: `Ctrl/Cmd + 点击跳转: ${wm[1]}` };

    if (hideMarkers) {
      items.push({ from: start, to: innerStart, kind: "replace", deco: Decoration.replace({}) });
      items.push({ from: innerStart, to: innerEnd, kind: "mark", deco: Decoration.mark({ class: "cm-md-link cm-md-wikilink", attributes: attrs }) });
      items.push({ from: innerEnd, to: end, kind: "replace", deco: Decoration.replace({}) });
    } else {
      items.push({ from: start, to: innerStart, kind: "mark", deco: Decoration.mark({ class: "cm-md-syntax" }) });
      items.push({ from: innerStart, to: innerEnd, kind: "mark", deco: Decoration.mark({ class: "cm-md-link cm-md-wikilink", attributes: attrs }) });
      items.push({ from: innerEnd, to: end, kind: "mark", deco: Decoration.mark({ class: "cm-md-syntax" }) });
    }
  }

  // 4) Emoji shortcodes (:rocket:) outside code/math/links
  if (hideMarkers) {
    const emojiRe = /:([a-z0-9_+-]+):/g;
    let em: RegExpExecArray | null;
    while ((em = emojiRe.exec(text)) !== null) {
      const ch = EMOJI_SHORTCODES[em[1]];
      if (!ch) continue;
      const start = lineFrom + em.index;
      const end = start + em[0].length;
      if (overlapsProtected(start, end)) continue;
      claimSpan(start, end);
      items.push({
        from: start,
        to: end,
        kind: "replace",
        deco: Decoration.replace({ widget: new EmojiWidget(ch) }),
      });
    }
  }

  // 5) Paired inline formatting (bold, strike, underline, highlight, italic, sub, sup)
  const pushPair = (regex: RegExp, markerLen: number, contentClass: string) => {
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      const start = lineFrom + m.index;
      const end = start + m[0].length;
      if (overlapsProtected(start, end)) continue;
      const innerStart = start + markerLen;
      const innerEnd = end - markerLen;
      if (innerStart >= innerEnd) continue;
      // Claim markers (or full span) so overlapping/duplicate pairs never collide
      claimSpan(start, end);
      if (hideMarkers) {
        items.push({ from: start, to: innerStart, kind: "replace", deco: Decoration.replace({}) });
        items.push({ from: innerStart, to: innerEnd, kind: "mark", deco: Decoration.mark({ class: contentClass }) });
        items.push({ from: innerEnd, to: end, kind: "replace", deco: Decoration.replace({}) });
      } else {
        items.push({ from: start, to: innerStart, kind: "mark", deco: Decoration.mark({ class: "cm-md-syntax" }) });
        items.push({ from: innerStart, to: innerEnd, kind: "mark", deco: Decoration.mark({ class: contentClass }) });
        items.push({ from: innerEnd, to: end, kind: "mark", deco: Decoration.mark({ class: "cm-md-syntax" }) });
      }
    }
  };

  pushPair(/\*\*([^*\n]+)\*\*/g, 2, "cm-md-bold");
  pushPair(/~~([^~\n]+)~~/g, 2, "cm-md-strike");
  pushPair(/\+\+([^+\n]+)\+\+/g, 2, "cm-md-underline");
  pushPair(/==([^=\n]+)==/g, 2, "cm-md-highlight");
  pushPair(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, 1, "cm-md-italic");
  pushPair(/(?<!~)~([^~\s][^~\n]*?)~(?!~)/g, 1, "cm-md-sub");
  pushPair(/\^([^^\s][^^\n]*?)\^/g, 1, "cm-md-sup");
}

function createBlockWidgetsField(cb: LivePreviewCallbacks) {
  const compute = (state: EditorView["state"]): DecorationSet => {
    if (!cb.isLiveMode() || cb.isLargeFile()) return Decoration.none;
    const doc = state.doc;
    const builder = new RangeSetBuilder<Decoration>();
    const selRanges = state.selection.ranges;
    const isSelIn = (from: number, to: number) =>
      selRanges.some((r) => r.from <= to && r.to >= from);

    let ln = 1;
    while (ln <= doc.lines) {
      const line = doc.line(ln);
      const trimmed = line.text.trim();

      if (/^```mermaid\s*$/i.test(trimmed)) {
        let endLn = ln + 1;
        while (endLn <= doc.lines && !/^```\s*$/.test(doc.line(endLn).text.trim())) endLn++;
        if (endLn <= doc.lines) {
          const blockFrom = line.from;
          const blockTo = doc.line(endLn).to;
          if (!isSelIn(blockFrom, blockTo)) {
            const code = state.sliceDoc(line.to + 1, doc.line(endLn).from).trim();
            builder.add(blockFrom, blockTo, Decoration.replace({ widget: new MermaidWidget(code), block: true }));
          }
          ln = endLn + 1;
          continue;
        }
      }

      // Skip non-mermaid fenced code blocks so tables/$$ inside code blocks are never replaced
      if (/^(`{3,}|~{3,})/.test(trimmed)) {
        const fenceChar = trimmed[0];
        let endLn = ln + 1;
        while (endLn <= doc.lines) {
          const t = doc.line(endLn).text.trim();
          if (t.startsWith(fenceChar.repeat(3))) break;
          endLn++;
        }
        ln = endLn + 1;
        continue;
      }

      if (trimmed === "$$") {
        let endLn = ln + 1;
        while (endLn <= doc.lines && doc.line(endLn).text.trim() !== "$$") endLn++;
        if (endLn <= doc.lines) {
          const blockFrom = line.from;
          const blockTo = doc.line(endLn).to;
          if (!isSelIn(blockFrom, blockTo)) {
            const tex = state.sliceDoc(line.to + 1, doc.line(endLn).from).trim();
            builder.add(blockFrom, blockTo, Decoration.replace({ widget: new MathWidget(tex, true), block: true }));
          }
          ln = endLn + 1;
          continue;
        }
      }

      if (
        trimmed.includes("|") &&
        ln + 1 <= doc.lines &&
        /^\|?[\s:-]+\|[\s|:-]+$/.test(doc.line(ln + 1).text.trim())
      ) {
        let endLn = ln + 1;
        while (endLn + 1 <= doc.lines && doc.line(endLn + 1).text.trim().includes("|")) endLn++;
        const blockFrom = line.from;
        const blockTo = doc.line(endLn).to;
        if (!isSelIn(blockFrom, blockTo)) {
          const rawTable = state.sliceDoc(blockFrom, blockTo);
          builder.add(blockFrom, blockTo, Decoration.replace({ widget: new TableWidget(rawTable), block: true }));
        }
        ln = endLn + 1;
        continue;
      }

      ln++;
    }

    return builder.finish();
  };

  return StateField.define<DecorationSet>({
    create(state) {
      return compute(state);
    },
    update(deco, tr) {
      if (tr.docChanged || tr.selection || tr.reconfigured) {
        return compute(tr.state);
      }
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

export function createMarkdownLivePreviewExtension(cb: LivePreviewCallbacks): Extension {
  const inlinePlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private pointerSelecting = false;
      private view: EditorView;
      private onMouseDownBound: () => void;
      private onWindowMouseUpBound: () => void;

      constructor(view: EditorView) {
        this.view = view;
        this.decorations = buildLineAndInlineDecorations(view, cb, true);

        this.onMouseDownBound = () => {
          this.pointerSelecting = true;
        };
        this.onWindowMouseUpBound = () => {
          if (!this.pointerSelecting) return;
          this.pointerSelecting = false;
          // Refresh after pointer release: collapsed click reveals syntax for editing,
          // while non-empty drag/double-click selection keeps heading/text stable for copying!
          requestAnimationFrame(() => {
            if (this.view.dom.isConnected) {
              this.view.dispatch({ effects: refreshLivePreviewEffect.of(null) });
            }
          });
        };

        view.contentDOM.addEventListener("mousedown", this.onMouseDownBound);
        window.addEventListener("mouseup", this.onWindowMouseUpBound);
      }

      update(update: ViewUpdate) {
        const forcedRefresh = update.transactions.some((tr) =>
          tr.effects.some((e) => e.is(refreshLivePreviewEffect))
        );

        // During mouse drag-selection, avoid expanding `# ` / `**` markers mid-drag so text never jumps under the cursor
        if (
          this.pointerSelecting &&
          !update.docChanged &&
          !update.viewportChanged &&
          !forcedRefresh
        ) {
          return;
        }

        if (
          forcedRefresh ||
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          update.geometryChanged
        ) {
          // When selection is non-empty after a mouse drag/double-click, keep syntax hidden so copied text & highlights stay clean
          const hasNonEmptySelection = update.state.selection.ranges.some((r) => !r.empty);
          const expandOnlyWhenCollapsed = hasNonEmptySelection && !update.docChanged;
          this.decorations = buildLineAndInlineDecorations(
            update.view,
            cb,
            expandOnlyWhenCollapsed
          );
        }
      }

      destroy() {
        this.view.contentDOM.removeEventListener("mousedown", this.onMouseDownBound);
        window.removeEventListener("mouseup", this.onWindowMouseUpBound);
      }
    },
    { decorations: (v) => v.decorations }
  );

  const linkClickHandler = EditorView.domEventHandlers({
    mousedown(event) {
      if (!(event.ctrlKey || event.metaKey)) return false;
      const target = event.target as HTMLElement | null;
      const linkEl = target?.closest("[data-folia-href]") as HTMLElement | null;
      if (!linkEl) return false;
      event.preventDefault();
      const href = linkEl.dataset.foliaHref || "";
      const isWiki = linkEl.dataset.foliaWiki === "true";
      cb.onNavigateLink(href, isWiki);
      return true;
    },
  });

  return [inlinePlugin, createBlockWidgetsField(cb), linkClickHandler];
}
