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
import { highlightCodeBlock } from "@/core/markdown/codeHighlighter";

export interface LivePreviewCallbacks {
  getNotePath: () => string | null;
  isLiveMode: () => boolean;
  isLargeFile: () => boolean;
  isWikilinkValid?: (rawTarget: string, docText: string) => boolean;
  onNavigateLink: (href: string, isWiki: boolean) => void;
  onNavigateFootnote?: (footnoteId: string) => void;
  onImageClick?: (src: string, alt: string) => void;
}

export const refreshLivePreviewEffect = StateEffect.define<null>();
const editorFocusEffect = StateEffect.define<boolean>();

const editorFocusedField = StateField.define<boolean>({
  create() {
    return false;
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(editorFocusEffect)) return e.value;
    }
    return value;
  },
});

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

class BulletWidget extends WidgetType {
  constructor(readonly depth: number) {
    super();
  }
  eq(other: BulletWidget) {
    return other.depth === this.depth;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = `folia-md-bullet depth-${Math.min(this.depth, 2)}`;
    span.textContent = this.depth === 0 ? "•" : this.depth === 1 ? "◦" : "▪";
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly boxPos: number
  ) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.boxPos === this.boxPos;
  }
  toDOM(view: EditorView) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `folia-md-checkbox-btn${this.checked ? " is-checked" : ""}`;
    btn.setAttribute("aria-checked", String(this.checked));
    btn.setAttribute("role", "checkbox");
    if (this.checked) {
      btn.innerHTML = `<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><polyline points="2.2 6.3 4.9 9 9.8 3.2"/></svg>`;
    }
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const next = this.checked ? "[ ]" : "[x]";
      view.dispatch({
        changes: { from: this.boxPos, to: this.boxPos + 3, insert: next },
      });
    });
    return btn;
  }
  ignoreEvent() {
    return true;
  }
}

const widgetResizeObservers = new WeakMap<HTMLElement, ResizeObserver>();

function observeWidgetResize(el: HTMLElement, view: EditorView) {
  if (typeof ResizeObserver === "undefined") return;
  let lastH = el.getBoundingClientRect().height;
  const ro = new ResizeObserver((entries) => {
    const nextH = entries[0]?.contentRect.height ?? el.getBoundingClientRect().height;
    if (Math.abs(nextH - lastH) > 0.5 && view.dom.isConnected) {
      lastH = nextH;
      view.requestMeasure();
    }
  });
  ro.observe(el);
  widgetResizeObservers.set(el, ro);
}

function unobserveWidgetResize(el: HTMLElement) {
  const ro = widgetResizeObservers.get(el);
  if (ro) {
    ro.disconnect();
    widgetResizeObservers.delete(el);
  }
}

class ImagePreviewWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly onClick?: (src: string, alt: string) => void,
    readonly widthPx?: number
  ) {
    super();
  }
  eq(other: ImagePreviewWidget) {
    return (
      other.src === this.src &&
      other.alt === this.alt &&
      other.widthPx === this.widthPx
    );
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "folia-md-image-wrap";
    const img = document.createElement("img");
    img.src = this.src;
    img.alt = this.alt;
    img.loading = "lazy";
    img.className = "folia-md-image";
    if (this.widthPx && this.widthPx > 0) {
      img.style.width = `${this.widthPx}px`;
    }
    img.addEventListener("click", () => this.onClick?.(this.src, this.alt));
    img.addEventListener("load", () => {
      if (view.dom.isConnected) view.requestMeasure();
    });
    img.addEventListener("error", () => {
      wrap.classList.add("is-error");
      const err = document.createElement("span");
      err.className = "folia-md-image-error";
      err.textContent = `无法加载图片: ${this.alt || this.src}`;
      wrap.innerHTML = "";
      wrap.appendChild(err);
      if (view.dom.isConnected) view.requestMeasure();
    });
    wrap.appendChild(img);
    if (this.alt) {
      const cap = document.createElement("div");
      cap.className = "folia-md-image-caption";
      cap.textContent = this.alt;
      wrap.appendChild(cap);
    }
    observeWidgetResize(wrap, view);
    return wrap;
  }
  destroy(dom: HTMLElement) {
    unobserveWidgetResize(dom);
  }
  ignoreEvent() {
    return true;
  }
}

class HrWidget extends WidgetType {
  toDOM() {
    const hr = document.createElement("div");
    hr.className = "folia-md-hr";
    const line = document.createElement("div");
    line.className = "folia-md-hr-line";
    hr.appendChild(line);
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
  toDOM(view: EditorView) {
    if (!this.displayMode) {
      const span = document.createElement("span");
      span.className = "folia-md-math-inline";
      span.textContent = this.tex;
      loadKatex()
        .then((katex) => {
          katex.default.render(this.tex, span, {
            displayMode: false,
            throwOnError: false,
            strict: false,
          });
          if (view.dom.isConnected) {
            requestAnimationFrame(() => view.requestMeasure());
          }
        })
        .catch(() => {
          span.textContent = this.tex;
        });
      return span;
    }

    // Wrap block widget in a zero-margin padded shell so CodeMirror 6's
    // getBoundingClientRect().height measurement includes all vertical spacing!
    const shell = document.createElement("div");
    shell.className = "folia-block-shell";
    const el = document.createElement("div");
    el.className = "folia-md-math-block";
    el.textContent = this.tex;
    shell.appendChild(el);
    observeWidgetResize(shell, view);
    loadKatex()
      .then((katex) => {
        katex.default.render(this.tex, el, {
          displayMode: true,
          throwOnError: false,
          strict: false,
        });
        if (view.dom.isConnected) {
          requestAnimationFrame(() => view.requestMeasure());
        }
      })
      .catch(() => {
        el.textContent = this.tex;
      });
    return shell;
  }
  destroy(dom: HTMLElement) {
    unobserveWidgetResize(dom);
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
  toDOM(view: EditorView) {
    const shell = document.createElement("div");
    shell.className = "folia-block-shell";
    const box = document.createElement("div");
    box.className = "folia-md-mermaid";
    box.textContent = "正在渲染 Mermaid 图表...";
    shell.appendChild(box);
    observeWidgetResize(shell, view);
    const renderId = `folia-mmd-${Math.random().toString(36).slice(2, 9)}`;
    loadMermaid()
      .then(async (mermaid) => {
        const { svg } = await mermaid.render(renderId, this.code);
        box.innerHTML = svg;
        const svgEl = box.querySelector("svg");
        if (svgEl) {
          if (svgEl.getAttribute("viewBox")) {
            svgEl.removeAttribute("height");
          }
          svgEl.style.maxWidth = "100%";
          svgEl.style.height = "auto";
        }
        // CRITICAL: Inform CodeMirror 6 to re-measure the block height after async SVG render!
        if (view.dom.isConnected) {
          requestAnimationFrame(() => {
            view.requestMeasure();
            setTimeout(() => {
              if (view.dom.isConnected) view.requestMeasure();
            }, 60);
          });
        }
      })
      .catch((err) => {
        box.classList.add("is-error");
        box.textContent = `Mermaid 语法错误: ${err?.message ?? err}`;
        if (view.dom.isConnected) view.requestMeasure();
      });
    return shell;
  }
  destroy(dom: HTMLElement) {
    unobserveWidgetResize(dom);
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

class CodeBlockWidget extends WidgetType {
  constructor(
    readonly code: string,
    readonly lang: string
  ) {
    super();
  }
  eq(other: CodeBlockWidget) {
    return other.code === this.code && other.lang === this.lang;
  }
  toDOM() {
    const shell = document.createElement("div");
    shell.className = "folia-block-shell";
    const card = document.createElement("div");
    card.className = "folia-code-card";

    // Top-right toolbar: line-number toggle + copy button + uppercase language label
    const bar = document.createElement("div");
    bar.className = "folia-code-bar";

    const lnBtn = document.createElement("button");
    lnBtn.type = "button";
    lnBtn.className = "folia-code-action-btn";
    lnBtn.setAttribute("data-tip", "切换代码块行号");
    lnBtn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/></svg>`;
    lnBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      card.classList.toggle("hide-line-nums");
    });

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "folia-code-action-btn";
    copyBtn.setAttribute("data-tip", "复制代码");
    const copySvg = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
    const checkSvg = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    copyBtn.innerHTML = copySvg;
    copyBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void navigator.clipboard.writeText(this.code).catch(() => {});
      copyBtn.innerHTML = checkSvg;
      copyBtn.classList.add("is-copied");
      setTimeout(() => {
        copyBtn.innerHTML = copySvg;
        copyBtn.classList.remove("is-copied");
      }, 1500);
    });

    const langBadge = document.createElement("span");
    langBadge.className = "folia-code-lang";
    langBadge.textContent = (this.lang || "TEXT").toUpperCase();

    bar.appendChild(lnBtn);
    bar.appendChild(copyBtn);
    bar.appendChild(langBadge);
    card.appendChild(bar);

    const body = document.createElement("div");
    body.className = "folia-code-body";

    const highlighted = highlightCodeBlock(this.code, this.lang);
    const codeEls: HTMLSpanElement[] = [];

    for (let i = 0; i < highlighted.lines.length; i++) {
      const row = document.createElement("div");
      row.className = "folia-code-row";
      const ln = document.createElement("span");
      ln.className = "folia-code-ln";
      ln.textContent = String(i + 1);
      const codeEl = document.createElement("span");
      codeEl.className = "folia-code-text";
      codeEl.innerHTML = highlighted.lines[i];
      codeEls.push(codeEl);
      row.appendChild(ln);
      row.appendChild(codeEl);
      body.appendChild(row);
    }

    if (highlighted.pending) {
      void highlighted.pending.then((readyLines) => {
        if (!shell.isConnected) return;
        const count = Math.min(codeEls.length, readyLines.length);
        for (let i = 0; i < count; i++) {
          codeEls[i].innerHTML = readyLines[i];
        }
      });
    }

    card.appendChild(body);
    shell.appendChild(card);
    return shell;
  }
  ignoreEvent(event: Event) {
    const target = event.target as HTMLElement | null;
    if (target?.closest(".folia-code-action-btn")) return true;
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
    const shell = document.createElement("div");
    shell.className = "folia-block-shell";
    const wrap = document.createElement("div");
    wrap.className = "folia-md-table-wrap";
    shell.appendChild(wrap);
    const lines = this.rawMarkdown.trim().split("\n");
    if (lines.length < 2) return shell;

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
    return shell;
  }
  ignoreEvent() {
    return false;
  }
}

function renderSimpleInlineHtml(text: string): string {
  const codeTokens: string[] = [];
  let out = escapeHtml(text).replace(/`([^`]+)`/g, (_m, inner) => {
    const idx = codeTokens.push(`<code>${inner}</code>`) - 1;
    return `\u0000CODE${idx}\u0000`;
  });
  out = out.replace(/\*\*\*((?:[^*]|\*(?!\*\*))+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  out = out.replace(/\*\*((?:[^*]|\*(?!\*))+?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
  out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  out = out.replace(/\+\+([^+]+)\+\+/g, "<u>$1</u>");
  out = out.replace(/==([^=]+)==/g, "<mark>$1</mark>");
  out = out.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx) => codeTokens[Number(idx)] ?? "");
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
  // When the editor is not focused (e.g., right after opening a document, where CM6
  // defaults selection to pos 0), render every line cleanly in Live Preview without
  // revealing raw Markdown syntax on line 1.
  if (!view.hasFocus) return false;
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

  replaceItems.sort((a, b) => a.from - b.from || b.to - a.to);
  const acceptedReplaces: DecoItem[] = [];
  let lastReplaceEnd = -1;
  for (const r of replaceItems) {
    if (r.from < lastReplaceEnd) continue;
    acceptedReplaces.push(r);
    lastReplaceEnd = r.to;
  }

  const insideAnyReplace = (pos: number) =>
    acceptedReplaces.some((r) => r.from < pos && pos < r.to);

  const finalItems: DecoItem[] = [...lineItems, ...acceptedReplaces];
  for (const m of markItems) {
    // Split wrapping marks cleanly around inner replace ranges so nested inline
    // formatting (e.g. `**增量编译，不要 \`make dirclean\`**`) preserves both the
    // outer style and hidden inner delimiters without RangeSetBuilder collisions.
    let cur = m.from;
    for (const r of acceptedReplaces) {
      if (r.to <= cur) continue;
      if (r.from >= m.to) break;
      if (r.from > cur) {
        finalItems.push({ from: cur, to: r.from, kind: "mark", deco: m.deco });
      }
      cur = Math.max(cur, r.to);
      if (cur >= m.to) break;
    }
    if (cur < m.to) {
      finalItems.push({ from: cur, to: m.to, kind: "mark", deco: m.deco });
    }
  }
  for (const w of widgetItems) {
    if (!insideAnyReplace(w.from)) {
      finalItems.push(w);
    }
  }

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

export interface ParsedAbbreviation {
  term: string;
  expansion: string;
  isStandard: boolean;
  termStart: number;
  termEnd: number;
  colonEnd: number;
}

/**
 * Parse Markdown abbreviation definitions:
 * - Standard Markdown Extra: `*[HTML]: Hyper Text Markup Language`
 * - Shorthand (non-URL description): `[HTML]: Hyper Text Markup Language`
 */
export function parseAbbreviationDef(text: string): ParsedAbbreviation | null {
  const stdM = /^\*\[([^\]\r\n]+)\]:(\s+)(.+)$/.exec(text);
  if (stdM) {
    const term = stdM[1].trim();
    const expansion = stdM[3].trim();
    if (!term || !expansion) return null;
    return {
      term,
      expansion,
      isStandard: true,
      termStart: 2,
      termEnd: 2 + stdM[1].length,
      colonEnd: 2 + stdM[1].length + 2 + stdM[2].length,
    };
  }

  // Shorthand `[HTML]: Hyper Text Markup Language` (ignore footnote `[^id]:` and link refs `[id]: https://...`)
  const shortM = /^\[([^\]\r\n^]+)\]:(\s+)(.+)$/.exec(text);
  if (shortM) {
    const term = shortM[1].trim();
    const expansion = shortM[3].trim();
    if (!term || !expansion) return null;
    // Exclude URLs, relative paths, anchor refs, and angle-bracket link destinations
    if (/^(?:https?:\/\/|mailto:|tel:|ftp:\/\/|\/|\.\.?\/|#|<)/i.test(expansion)) {
      return null;
    }
    // Exclude bare single-token file links like `foo.md` or `img.png`
    if (!/\s/.test(expansion) && /\.[a-z0-9]{2,5}(?:[#?].*)?$/i.test(expansion)) {
      return null;
    }
    return {
      term,
      expansion,
      isStandard: false,
      termStart: 1,
      termEnd: 1 + shortM[1].length,
      colonEnd: 1 + shortM[1].length + 2 + shortM[2].length,
    };
  }

  return null;
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
    let activeCalloutKind: string | null = null;

    interface LineCtx {
      inFrontmatter: boolean;
      inCodeFence: boolean;
      codeFenceLang: string;
      inMathBlock: boolean;
      calloutKind: string | null;
      calloutRole: "head" | "body" | null;
      calloutIsTail: boolean;
    }

    const lineContext = new Map<number, LineCtx>();
    const abbrMap = new Map<string, string>();
    const abbrDefLines = new Set<number>();

    const scanLimit = cb.isLargeFile() ? maxEndLine : doc.lines;
    const calloutStartRe = /^\s*>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s+.*|\s*)$/i;

    for (let ln = 1; ln <= scanLimit; ln++) {
      const text = doc.line(ln).text;
      const trimmed = text.trim();

      if (ln === 1 && trimmed === "---") {
        inFrontmatter = true;
        activeCalloutKind = null;
        if (ln <= maxEndLine) {
          lineContext.set(ln, {
            inFrontmatter: true,
            inCodeFence: false,
            codeFenceLang: "",
            inMathBlock: false,
            calloutKind: null,
            calloutRole: null,
            calloutIsTail: false,
          });
        }
        continue;
      }
      if (inFrontmatter) {
        if (ln <= maxEndLine) {
          lineContext.set(ln, {
            inFrontmatter: true,
            inCodeFence: false,
            codeFenceLang: "",
            inMathBlock: false,
            calloutKind: null,
            calloutRole: null,
            calloutIsTail: false,
          });
        }
        if (trimmed === "---" || trimmed === "...") inFrontmatter = false;
        continue;
      }

      const fence = /^(`{3,}|~{3,})(.*)$/.exec(trimmed);
      if (fence && !inMathBlock) {
        activeCalloutKind = null;
        if (!inCodeFence) {
          inCodeFence = true;
          codeFenceLang = fence[2].trim().toLowerCase();
        } else {
          inCodeFence = false;
          codeFenceLang = "";
        }
        if (ln <= maxEndLine) {
          lineContext.set(ln, {
            inFrontmatter: false,
            inCodeFence: true,
            codeFenceLang,
            inMathBlock: false,
            calloutKind: null,
            calloutRole: null,
            calloutIsTail: false,
          });
        }
        continue;
      }

      if (!inCodeFence && trimmed === "$$") {
        activeCalloutKind = null;
        inMathBlock = !inMathBlock;
        if (ln <= maxEndLine) {
          lineContext.set(ln, {
            inFrontmatter: false,
            inCodeFence: false,
            codeFenceLang: "",
            inMathBlock: true,
            calloutKind: null,
            calloutRole: null,
            calloutIsTail: false,
          });
        }
        continue;
      }

      if (!inCodeFence && !inMathBlock) {
        const abbrDef = parseAbbreviationDef(text);
        if (abbrDef) {
          abbrMap.set(abbrDef.term, abbrDef.expansion);
          abbrDefLines.add(ln);
        }

        const cHead = calloutStartRe.exec(text);
        if (cHead) {
          activeCalloutKind = cHead[1].toLowerCase();
          if (ln <= maxEndLine) {
            const nextIsQuote = ln < doc.lines && /^\s*>/.test(doc.line(ln + 1).text) && !calloutStartRe.test(doc.line(ln + 1).text);
            lineContext.set(ln, {
              inFrontmatter: false,
              inCodeFence: false,
              codeFenceLang: "",
              inMathBlock: false,
              calloutKind: activeCalloutKind,
              calloutRole: "head",
              calloutIsTail: !nextIsQuote,
            });
          }
          continue;
        }

        if (activeCalloutKind && /^\s*>/.test(text)) {
          if (ln <= maxEndLine) {
            const nextIsQuote = ln < doc.lines && /^\s*>/.test(doc.line(ln + 1).text) && !calloutStartRe.test(doc.line(ln + 1).text);
            lineContext.set(ln, {
              inFrontmatter: false,
              inCodeFence: false,
              codeFenceLang: "",
              inMathBlock: false,
              calloutKind: activeCalloutKind,
              calloutRole: "body",
              calloutIsTail: !nextIsQuote,
            });
          }
          continue;
        } else {
          activeCalloutKind = null;
        }
      }

      if (ln <= maxEndLine) {
        lineContext.set(ln, {
          inFrontmatter,
          inCodeFence,
          codeFenceLang,
          inMathBlock,
          calloutKind: null,
          calloutRole: null,
          calloutIsTail: false,
        });
      }
    }

    const processedLines = new Set<number>();
    const fullDocText = cb.isWikilinkValid ? doc.toString() : "";
    const wikilinkValidator = cb.isWikilinkValid
      ? (rawTarget: string) => cb.isWikilinkValid!(rawTarget, fullDocText)
      : undefined;

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
          decorateYamlFrontmatterLine(line.from, text, items);
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

          // Hide or dim custom heading anchor IDs (`### 三级标题 {#id33}`)
          const customIdM = /\s+\{#([A-Za-z0-9_\-\u4e00-\u9fa5]+)\}\s*$/.exec(text);
          if (customIdM) {
            const idFrom = line.from + customIdM.index;
            const idTo = line.from + text.length;
            protectedSpans.push({ start: idFrom, end: idTo });
            if (live && !lineActive) {
              items.push({ from: idFrom, to: idTo, kind: "replace", deco: Decoration.replace({}) });
            } else {
              items.push({ from: idFrom, to: idTo, kind: "mark", deco: Decoration.mark({ class: "cm-md-syntax" }) });
            }
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
          const tailCls = ctx?.calloutIsTail ? " cm-md-callout-tail" : "";
          items.push({
            from: line.from,
            to: line.from,
            kind: "line",
            deco: Decoration.line({ class: `cm-md-callout cm-md-callout-${kind.toLowerCase()} cm-md-callout-head${tailCls}` }),
          });
          protectedSpans.push({ start: line.from, end: line.from + prefixLen });
          if (live && !lineActive) {
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
        } else if (ctx?.calloutKind && ctx.calloutRole === "body" && /^\s*>/.test(text)) {
          const tailCls = ctx.calloutIsTail ? " cm-md-callout-tail" : "";
          items.push({
            from: line.from,
            to: line.from,
            kind: "line",
            deco: Decoration.line({ class: `cm-md-callout cm-md-callout-${ctx.calloutKind} cm-md-callout-body${tailCls}` }),
          });
          const qm = /^\s*>\s?/.exec(text);
          if (qm) {
            protectedSpans.push({ start: line.from, end: line.from + qm[0].length });
            if (live && !lineActive) {
              items.push({ from: line.from, to: line.from + qm[0].length, kind: "replace", deco: Decoration.replace({}) });
            } else {
              items.push({ from: line.from, to: line.from + qm[0].length, kind: "mark", deco: Decoration.mark({ class: "cm-md-syntax" }) });
            }
          }
        } else if (/^\s*>/.test(text)) {
          items.push({ from: line.from, to: line.from, kind: "line", deco: Decoration.line({ class: "cm-md-quote-line" }) });
          const qm = /^\s*>\s?/.exec(text);
          if (qm) {
            protectedSpans.push({ start: line.from, end: line.from + qm[0].length });
            if (live && !lineActive) {
              items.push({ from: line.from, to: line.from + qm[0].length, kind: "replace", deco: Decoration.replace({}) });
            } else {
              items.push({ from: line.from, to: line.from + qm[0].length, kind: "mark", deco: Decoration.mark({ class: "cm-md-syntax" }) });
            }
          }
        }

        // Abbreviation definition line (`*[HTML]: Hyper Text Markup Language` or `[HTML]: ...`)
        if (abbrDefLines.has(ln)) {
          const def = parseAbbreviationDef(text);
          if (def) {
            items.push({ from: line.from, to: line.from, kind: "line", deco: Decoration.line({ class: "cm-md-abbr-def-line" }) });
            const tStart = line.from + def.termStart;
            const tEnd = line.from + def.termEnd;
            const cEnd = line.from + def.colonEnd;
            if (live && !lineActive) {
              if (tStart > line.from) {
                items.push({ from: line.from, to: tStart, kind: "replace", deco: Decoration.replace({}) });
              }
              items.push({ from: tStart, to: tEnd, kind: "mark", deco: Decoration.mark({ class: "cm-md-abbr-def-term" }) });
              items.push({ from: tEnd, to: cEnd, kind: "replace", deco: Decoration.replace({}) });
              if (cEnd < line.to) {
                items.push({ from: cEnd, to: line.to, kind: "mark", deco: Decoration.mark({ class: "cm-md-abbr-def-desc" }) });
              }
              continue;
            } else {
              items.push({ from: line.from, to: tStart, kind: "mark", deco: Decoration.mark({ class: "cm-md-syntax" }) });
              items.push({ from: tStart, to: tEnd, kind: "mark", deco: Decoration.mark({ class: "cm-md-abbr-def-term" }) });
              items.push({ from: tEnd, to: cEnd, kind: "mark", deco: Decoration.mark({ class: "cm-md-syntax" }) });
              continue;
            }
          }
        }

        // Task list: replace `- [x]` (hiding `- ` prefix!) with custom rounded checkbox button
        const taskMatch = /^(\s*)([-*+]\s+)(\[[ xX]\])/.exec(text);
        if (taskMatch) {
          const indentLen = taskMatch[1].length;
          const dashStart = line.from + indentLen;
          const boxStart = dashStart + taskMatch[2].length;
          const boxEnd = boxStart + 3;
          const checked = taskMatch[3].toLowerCase() === "[x]";
          protectedSpans.push({ start: dashStart, end: boxEnd });
          items.push({ from: line.from, to: line.from, kind: "line", deco: Decoration.line({ class: "cm-md-list-line cm-md-task-line" }) });
          if (live && !lineActive) {
            items.push({
              from: dashStart,
              to: boxEnd,
              kind: "replace",
              deco: Decoration.replace({ widget: new CheckboxWidget(checked, boxStart) }),
            });
          }
          if (checked && boxEnd < line.to) {
            items.push({ from: boxEnd, to: line.to, kind: "mark", deco: Decoration.mark({ class: "cm-md-task-done" }) });
          }
        } else {
          // Unordered list bullet dots (• / ◦ / ▪) by nesting depth
          const ulMatch = /^(\s*)([-*+])(\s+)/.exec(text);
          if (ulMatch) {
            const indentSpaces = ulMatch[1].replace(/\t/g, "  ").length;
            const depth = Math.floor(indentSpaces / 2);
            const markerFrom = line.from + ulMatch[1].length;
            const markerTo = markerFrom + ulMatch[2].length;
            protectedSpans.push({ start: markerFrom, end: markerTo });
            items.push({ from: line.from, to: line.from, kind: "line", deco: Decoration.line({ class: "cm-md-list-line" }) });
            if (live && !lineActive) {
              items.push({
                from: markerFrom,
                to: markerTo,
                kind: "replace",
                deco: Decoration.replace({ widget: new BulletWidget(depth) }),
              });
            } else {
              items.push({
                from: markerFrom,
                to: markerTo,
                kind: "mark",
                deco: Decoration.mark({ class: "cm-md-syntax" }),
              });
            }
          } else {
            // Ordered list numbers (`1.`, `2.`) with crisp bold monospace accent styling
            const olMatch = /^(\s*)(\d+\.)(\s+)/.exec(text);
            if (olMatch) {
              const numFrom = line.from + olMatch[1].length;
              const numTo = numFrom + olMatch[2].length;
              protectedSpans.push({ start: numFrom, end: numTo });
              items.push({ from: line.from, to: line.from, kind: "line", deco: Decoration.line({ class: "cm-md-list-line" }) });
              items.push({
                from: numFrom,
                to: numTo,
                kind: "mark",
                deco: Decoration.mark({ class: "cm-md-ol-marker" }),
              });
            }
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

        // HTML <img src="..." alt="..." width="...">
        const htmlImgRe = /<img\s+([^>]*?)\s*\/?>/gi;
        let him: RegExpExecArray | null;
        while ((him = htmlImgRe.exec(text)) !== null) {
          const from = line.from + him.index;
          const to = from + him[0].length;
          if (protectedSpans.some((s) => from < s.end && to > s.start)) continue;
          const attrs = him[1];
          const srcM = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
          if (!srcM) continue;
          const altM = /\balt\s*=\s*["']([^"']*)["']/i.exec(attrs);
          const widthM = /\bwidth\s*=\s*["']?(\d+)/i.exec(attrs);
          const widthPx = widthM ? Number(widthM[1]) : undefined;
          protectedSpans.push({ start: from, end: to });
          if (live) {
            const resolved = resolveImageSrc(srcM[1], notePath);
            const widget = new ImagePreviewWidget(resolved, altM?.[1] ?? "", cb.onImageClick, widthPx);
            if (!lineActive && him[0].trim() === text.trim()) {
              items.push({ from, to, kind: "replace", deco: Decoration.replace({ widget }) });
            } else {
              items.push({ from: to, to, kind: "widget", deco: Decoration.widget({ widget, side: 1 }) });
            }
          }
        }

        // Single-line centered HTML: <center>...</center>, <p align="center">...</p>, <div align="center">...</div>
        const centerHtmlRe = /^<(center|(?:p|div)\s+[^>]*align=["']center["'][^>]*)>(.*)<\/(?:center|p|div)>$/i;
        const centerM = centerHtmlRe.exec(text.trim());
        if (centerM) {
          const leadWs = text.indexOf("<");
          const openEnd = text.indexOf(">", leadWs) + 1;
          const closeStart = text.lastIndexOf("</");
          if (openEnd > leadWs && closeStart >= openEnd) {
            items.push({ from: line.from, to: line.from, kind: "line", deco: Decoration.line({ class: "cm-md-align-center" }) });
            const openFrom = line.from + leadWs;
            const openTo = line.from + openEnd;
            const closeFrom = line.from + closeStart;
            const closeTo = line.from + text.trimEnd().length;
            protectedSpans.push({ start: openFrom, end: openTo });
            protectedSpans.push({ start: closeFrom, end: closeTo });
            if (live && !lineActive) {
              items.push({ from: openFrom, to: openTo, kind: "replace", deco: Decoration.replace({}) });
              items.push({ from: closeFrom, to: closeTo, kind: "replace", deco: Decoration.replace({}) });
            } else {
              items.push({ from: openFrom, to: openTo, kind: "mark", deco: Decoration.mark({ class: "cm-md-syntax" }) });
              items.push({ from: closeFrom, to: closeTo, kind: "mark", deco: Decoration.mark({ class: "cm-md-syntax" }) });
            }
          }
        }

        decorateInlinePatterns(
          line.from,
          text,
          live && !lineActive,
          items,
          protectedSpans,
          abbrMap,
          wikilinkValidator
        );
      }
    }

    return assembleSafeDecorationSet(items);
  } catch (err) {
    console.error("Folia live preview decoration error:", err);
    return Decoration.none;
  }
}

function decorateYamlValue(baseFrom: number, rawVal: string, items: DecoItem[]) {
  if (!rawVal) return;
  const leadLen = rawVal.length - rawVal.trimStart().length;
  const valStart = baseFrom + leadLen;
  const trimmed = rawVal.trim();
  if (!trimmed) return;
  const valEnd = valStart + trimmed.length;

  // Comment-only value
  if (trimmed.startsWith("#")) {
    items.push({ from: valStart, to: valEnd, kind: "mark", deco: Decoration.mark({ class: "cm-yaml-comment" }) });
    return;
  }

  // Quoted string ('...' or "...")
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)
  ) {
    items.push({ from: valStart, to: valEnd, kind: "mark", deco: Decoration.mark({ class: "cm-yaml-string" }) });
    return;
  }

  // Booleans / null
  if (/^(?:true|false|yes|no|null|~)$/i.test(trimmed)) {
    items.push({ from: valStart, to: valEnd, kind: "mark", deco: Decoration.mark({ class: "cm-yaml-bool" }) });
    return;
  }

  // Numbers or ISO dates
  if (/^(?:-?\d+(?:\.\d+)?|\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?)$/.test(trimmed)) {
    items.push({ from: valStart, to: valEnd, kind: "mark", deco: Decoration.mark({ class: "cm-yaml-number" }) });
    return;
  }

  // Plain unquoted string value (e.g. title, author, tags item)
  items.push({ from: valStart, to: valEnd, kind: "mark", deco: Decoration.mark({ class: "cm-yaml-value" }) });
}

function decorateYamlFrontmatterLine(lineFrom: number, text: string, items: DecoItem[]) {
  const trimmed = text.trim();
  if (!trimmed) return;

  if (trimmed === "---" || trimmed === "...") {
    items.push({ from: lineFrom, to: lineFrom + text.length, kind: "mark", deco: Decoration.mark({ class: "cm-yaml-delim" }) });
    return;
  }

  if (trimmed.startsWith("#")) {
    items.push({ from: lineFrom, to: lineFrom + text.length, kind: "mark", deco: Decoration.mark({ class: "cm-yaml-comment" }) });
    return;
  }

  // YAML list item: `  - ALTRun`
  const listM = /^(\s*)(-)(\s+)(.*)$/.exec(text);
  if (listM) {
    const dashFrom = lineFrom + listM[1].length;
    const dashTo = dashFrom + 1;
    items.push({ from: dashFrom, to: dashTo, kind: "mark", deco: Decoration.mark({ class: "cm-yaml-punct" }) });
    const valOffset = listM[1].length + listM[2].length + listM[3].length;
    decorateYamlValue(lineFrom + valOffset, listM[4], items);
    return;
  }

  // YAML key: value pair
  const kvM = /^(\s*)([^:#\n][^:\n]*?)(:)(.*)$/.exec(text);
  if (kvM) {
    const keyFrom = lineFrom + kvM[1].length;
    const keyTo = keyFrom + kvM[2].length;
    const colonTo = keyTo + 1;
    items.push({ from: keyFrom, to: keyTo, kind: "mark", deco: Decoration.mark({ class: "cm-yaml-key" }) });
    items.push({ from: keyTo, to: colonTo, kind: "mark", deco: Decoration.mark({ class: "cm-yaml-punct" }) });
    decorateYamlValue(colonTo, kvM[4], items);
    return;
  }

  items.push({ from: lineFrom, to: lineFrom + text.length, kind: "mark", deco: Decoration.mark({ class: "cm-yaml-value" }) });
}

export function decorateInlinePatterns(
  lineFrom: number,
  text: string,
  hideMarkers: boolean,
  items: DecoItem[],
  protectedSpans: Array<{ start: number; end: number }> = [],
  abbrMap?: Map<string, string>,
  isWikilinkValid?: (rawTarget: string) => boolean
) {
  // Two-tier span protection so nested Markdown formatting works cleanly:
  // - `atomicSpans`: opaque ranges (inline code, math, images, link URLs, line prefixes)
  //   whose interior cannot be parsed as Markdown, while outer formatting CAN wrap around them.
  // - `claimedMarkers`: delimiter token ranges only (`**`, `*`, `[`, `<u>`, `</u>`, etc.),
  //   preventing delimiter collision while allowing inner content to be nested freely.
  const atomicSpans: Array<{ start: number; end: number }> = [...protectedSpans];
  const claimedMarkers: Array<{ start: number; end: number }> = [];

  const overlapsAtomic = (start: number, end: number) =>
    atomicSpans.some((s) => start < s.end && end > s.start);

  const overlapsMarkers = (start: number, end: number) =>
    claimedMarkers.some((s) => start < s.end && end > s.start);

  const isBlocked = (start: number, end: number) =>
    overlapsAtomic(start, end) || overlapsMarkers(start, end);

  const claimAtomic = (start: number, end: number) => {
    if (end > start) atomicSpans.push({ start, end });
  };

  const claimMarker = (start: number, end: number) => {
    if (end > start) claimedMarkers.push({ start, end });
  };

  const emitWrapped = (
    start: number,
    innerStart: number,
    innerEnd: number,
    end: number,
    contentDeco: Decoration
  ) => {
    if (hideMarkers) {
      if (innerStart > start) {
        items.push({ from: start, to: innerStart, kind: "replace", deco: Decoration.replace({}) });
      }
      if (innerEnd > innerStart) {
        items.push({ from: innerStart, to: innerEnd, kind: "mark", deco: contentDeco });
      }
      if (end > innerEnd) {
        items.push({ from: innerEnd, to: end, kind: "replace", deco: Decoration.replace({}) });
      }
    } else {
      if (innerStart > start) {
        items.push({ from: start, to: innerStart, kind: "mark", deco: Decoration.mark({ class: "cm-md-syntax" }) });
      }
      if (innerEnd > innerStart) {
        items.push({ from: innerStart, to: innerEnd, kind: "mark", deco: contentDeco });
      }
      if (end > innerEnd) {
        items.push({ from: innerEnd, to: end, kind: "mark", deco: Decoration.mark({ class: "cm-md-syntax" }) });
      }
    }
  };

  // 1) Inline code FIRST (supports single and multi-backtick spans like ``a ` b``)
  const codeRe = /(`+)(?!`)([^\n]+?)(?<!`)\1(?!`)/g;
  let cm: RegExpExecArray | null;
  while ((cm = codeRe.exec(text)) !== null) {
    const start = lineFrom + cm.index;
    const end = start + cm[0].length;
    if (isBlocked(start, end)) continue;
    const tickLen = cm[1].length;
    const innerStart = start + tickLen;
    const innerEnd = end - tickLen;
    if (innerStart >= innerEnd) continue;
    claimAtomic(start, end);
    emitWrapped(start, innerStart, innerEnd, end, Decoration.mark({ class: "cm-md-inline-code" }));
  }

  // 2) Inline KaTeX math ($...$) - always atomic so `*`, `_`, `^` inside math are never parsed as Markdown
  const mathRe = /(?<!\$)\$([^$\n]+)\$(?!\$)/g;
  let mm: RegExpExecArray | null;
  while ((mm = mathRe.exec(text)) !== null) {
    const start = lineFrom + mm.index;
    const end = start + mm[0].length;
    if (isBlocked(start, end)) continue;
    if (!mm[1].trim()) continue;
    claimAtomic(start, end);
    if (hideMarkers) {
      items.push({
        from: start,
        to: end,
        kind: "replace",
        deco: Decoration.replace({ widget: new MathWidget(mm[1], false) }),
      });
    } else {
      items.push({ from: start, to: start + 1, kind: "mark", deco: Decoration.mark({ class: "cm-md-syntax" }) });
      items.push({ from: end - 1, to: end, kind: "mark", deco: Decoration.mark({ class: "cm-md-syntax" }) });
    }
  }

  // 3) Standard Markdown links [label](url) & Wikilinks [[target]]
  const linkRe = /(?<!!)\[([^\]\n]+)\]\(([^)\n]+)\)/g;
  let lm: RegExpExecArray | null;
  while ((lm = linkRe.exec(text)) !== null) {
    const start = lineFrom + lm.index;
    const end = start + lm[0].length;
    const labelStart = start + 1;
    const labelEnd = labelStart + lm[1].length;
    // Allow inline code or bold/italic inside `[label]`, while protecting `[` and `](url)`
    if (isBlocked(start, labelStart) || isBlocked(labelEnd, end)) continue;
    claimMarker(start, labelStart);
    claimAtomic(labelEnd, end);
    const attrs = { "data-folia-href": lm[2], "data-folia-wiki": "false", title: `Ctrl/Cmd + 点击打开: ${lm[2]}` };
    emitWrapped(start, labelStart, labelEnd, end, Decoration.mark({ class: "cm-md-link", attributes: attrs }));
  }

  const wikiRe = /(?<!!)\[\[([^\]\n]+)\]\]/g;
  let wm: RegExpExecArray | null;
  while ((wm = wikiRe.exec(text)) !== null) {
    const start = lineFrom + wm.index;
    const end = start + wm[0].length;
    if (isBlocked(start, end)) continue;
    claimAtomic(start, end);
    const innerStart = start + 2;
    const innerEnd = end - 2;
    const valid = isWikilinkValid ? isWikilinkValid(wm[1]) : true;
    const cls = valid ? "cm-md-link cm-md-wikilink" : "cm-md-link cm-md-wikilink cm-md-link-broken";
    const tip = valid
      ? `Ctrl/Cmd + 点击跳转: ${wm[1]}`
      : `目标笔记不存在（可能已删除或重命名）：${wm[1]}`;
    const attrs: Record<string, string> = {
      "data-folia-href": wm[1],
      "data-folia-wiki": "true",
      title: tip,
    };
    if (!valid) {
      attrs["data-tip"] = tip;
    }
    emitWrapped(start, innerStart, innerEnd, end, Decoration.mark({ class: cls, attributes: attrs }));
  }

  // 4) Footnote definitions (`[^id]:`) and footnote references (`[^id]`)
  const fnDefRe = /\[\^([^\]\s]+)\]:/g;
  let fdm: RegExpExecArray | null;
  while ((fdm = fnDefRe.exec(text)) !== null) {
    const start = lineFrom + fdm.index;
    const end = start + fdm[0].length;
    if (isBlocked(start, end)) continue;
    claimAtomic(start, end);
    const idStart = start + 2;
    const idEnd = start + 2 + fdm[1].length;
    if (hideMarkers) {
      items.push({ from: start, to: idStart, kind: "replace", deco: Decoration.replace({}) });
      items.push({
        from: idStart,
        to: idEnd,
        kind: "mark",
        deco: Decoration.mark({
          class: "cm-md-footnote-def",
          attributes: { "data-folia-footnote-def": fdm[1] },
        }),
      });
      items.push({ from: idEnd, to: end, kind: "replace", deco: Decoration.replace({}) });
    } else {
      items.push({ from: start, to: end, kind: "mark", deco: Decoration.mark({ class: "cm-md-syntax" }) });
    }
  }

  const fnRefRe = /(?<!!)\[\^([^\]\s]+)\](?!:)/g;
  let frm: RegExpExecArray | null;
  while ((frm = fnRefRe.exec(text)) !== null) {
    const start = lineFrom + frm.index;
    const end = start + frm[0].length;
    if (isBlocked(start, end)) continue;
    claimAtomic(start, end);
    const idStart = start + 2;
    const idEnd = end - 1;
    const attrs = {
      "data-folia-footnote": frm[1],
      title: `Ctrl/Cmd + 点击跳转到脚注 [^${frm[1]}]`,
    };
    emitWrapped(start, idStart, idEnd, end, Decoration.mark({ class: "cm-md-footnote-ref", attributes: attrs }));
  }

  // 5) Common Inline HTML tags: <u>, <ins>, <b>, <strong>, <i>, <em>, <s>, <del>, <mark>, <sub>, <sup>, <code>, <kbd>, <a href>, <span style>, <font color>
  const htmlPairTags: Array<[RegExp, string, boolean]> = [
    [/<(code)>([^\n]+?)<\/\1>/gi, "cm-md-inline-code", true],
    [/<(kbd)>([^\n]+?)<\/\1>/gi, "cm-md-kbd", false],
    [/<(u|ins)>([^\n]+?)<\/\1>/gi, "cm-md-underline", false],
    [/<(b|strong)>([^\n]+?)<\/\1>/gi, "cm-md-bold", false],
    [/<(i|em)>([^\n]+?)<\/\1>/gi, "cm-md-italic", false],
    [/<(s|del)>([^\n]+?)<\/\1>/gi, "cm-md-strike", false],
    [/<(mark)>([^\n]+?)<\/\1>/gi, "cm-md-highlight", false],
    [/<(sub)>([^\n]+?)<\/\1>/gi, "cm-md-sub", false],
    [/<(sup)>([^\n]+?)<\/\1>/gi, "cm-md-sup", false],
  ];

  for (const [tagRe, cls, isAtomicTag] of htmlPairTags) {
    let hm: RegExpExecArray | null;
    while ((hm = tagRe.exec(text)) !== null) {
      const start = lineFrom + hm.index;
      const end = start + hm[0].length;
      const openEndOffset = hm[0].indexOf(">") + 1;
      const closeStartOffset = hm[0].lastIndexOf("</");
      if (openEndOffset <= 0 || closeStartOffset <= openEndOffset) continue;
      const innerStart = start + openEndOffset;
      const innerEnd = start + closeStartOffset;
      if (isAtomicTag) {
        if (isBlocked(start, end)) continue;
        claimAtomic(start, end);
      } else {
        if (isBlocked(start, innerStart) || isBlocked(innerEnd, end)) continue;
        claimAtomic(start, innerStart);
        claimAtomic(innerEnd, end);
      }
      emitWrapped(start, innerStart, innerEnd, end, Decoration.mark({ class: cls }));
    }
  }

  // Inline HTML <a href="...">text</a>
  const htmlAnchorRe = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([^\n]+?)<\/a>/gi;
  let am: RegExpExecArray | null;
  while ((am = htmlAnchorRe.exec(text)) !== null) {
    const start = lineFrom + am.index;
    const end = start + am[0].length;
    const openEndOffset = am[0].indexOf(">") + 1;
    const closeStartOffset = am[0].lastIndexOf("</");
    if (openEndOffset <= 0 || closeStartOffset <= openEndOffset) continue;
    const innerStart = start + openEndOffset;
    const innerEnd = start + closeStartOffset;
    if (isBlocked(start, innerStart) || isBlocked(innerEnd, end)) continue;
    claimAtomic(start, innerStart);
    claimAtomic(innerEnd, end);
    const attrs = { "data-folia-href": am[1], "data-folia-wiki": "false", title: `Ctrl/Cmd + 点击打开: ${am[1]}` };
    emitWrapped(start, innerStart, innerEnd, end, Decoration.mark({ class: "cm-md-link", attributes: attrs }));
  }

  // Inline HTML <span style="color:...; background:...">text</span> or <font color="...">text</font>
  const htmlColorRe = /<(span|font)\s+([^>]+)>([^\n]+?)<\/\1>/gi;
  let hcm: RegExpExecArray | null;
  while ((hcm = htmlColorRe.exec(text)) !== null) {
    const start = lineFrom + hcm.index;
    const end = start + hcm[0].length;
    const attrStr = hcm[2];
    const safeStyles: string[] = [];
    const colorAttr = /\bcolor\s*=\s*["']?([#a-zA-Z0-9(),.\s%-]+?)["']?(?:\s|$)/i.exec(attrStr);
    if (colorAttr) safeStyles.push(`color:${colorAttr[1].trim()}`);
    const styleAttr = /\bstyle\s*=\s*["']([^"']+)["']/i.exec(attrStr);
    if (styleAttr) {
      for (const decl of styleAttr[1].split(";")) {
        const [propRaw, valRaw] = decl.split(":");
        if (!propRaw || !valRaw) continue;
        const prop = propRaw.trim().toLowerCase();
        const val = valRaw.trim();
        if (
          (prop === "color" || prop === "background" || prop === "background-color") &&
          /^[#a-zA-Z0-9(),.\s%-]+$/.test(val)
        ) {
          safeStyles.push(`${prop}:${val}`);
        }
      }
    }
    if (safeStyles.length === 0) continue;
    const openEndOffset = hcm[0].indexOf(">") + 1;
    const closeStartOffset = hcm[0].lastIndexOf("</");
    if (openEndOffset <= 0 || closeStartOffset <= openEndOffset) continue;
    const innerStart = start + openEndOffset;
    const innerEnd = start + closeStartOffset;
    if (isBlocked(start, innerStart) || isBlocked(innerEnd, end)) continue;
    claimAtomic(start, innerStart);
    claimAtomic(innerEnd, end);
    const styleStr = safeStyles.join(";");
    emitWrapped(start, innerStart, innerEnd, end, Decoration.mark({ attributes: { style: styleStr } }));
  }

  // 6) Emoji shortcodes (:rocket:)
  if (hideMarkers) {
    const emojiRe = /:([a-z0-9_+-]+):/g;
    let em: RegExpExecArray | null;
    while ((em = emojiRe.exec(text)) !== null) {
      const ch = EMOJI_SHORTCODES[em[1]];
      if (!ch) continue;
      const start = lineFrom + em.index;
      const end = start + em[0].length;
      if (isBlocked(start, end)) continue;
      claimAtomic(start, end);
      items.push({
        from: start,
        to: end,
        kind: "replace",
        deco: Decoration.replace({ widget: new EmojiWidget(ch) }),
      });
    }
  }

  // 7) Paired inline formatting via delimiter scanner (supports arbitrary nesting around
  //    inline code, links, math, emoji, HTML tags, and other emphasis markers!)
  interface DelimPairOpts {
    disallowInnerWhitespaceFlanking?: boolean;
    disallowWordBoundary?: boolean;
  }

  const pushDelimPair = (delim: string, contentClass: string, opts: DelimPairOpts = {}) => {
    const len = delim.length;
    const ch = delim[0];
    let openPos = -1;
    let i = 0;

    while (i <= text.length - len) {
      if (text[i] === "\\") {
        i += 2;
        continue;
      }
      if (text[i] !== ch) {
        i++;
        continue;
      }
      if (isBlocked(lineFrom + i, lineFrom + i + 1)) {
        i++;
        continue;
      }

      // Measure contiguous unclaimed run of `ch`
      let runEnd = i;
      while (
        runEnd < text.length &&
        text[runEnd] === ch &&
        !isBlocked(lineFrom + runEnd, lineFrom + runEnd + 1)
      ) {
        runEnd++;
      }
      const runLen = runEnd - i;
      if (runLen < len) {
        i = runEnd;
        continue;
      }

      // Single-char delimiters (e.g. `*`, `~`, `_`) must not split an unclaimed longer run (`**`, `~~`, `__`)
      if (len === 1 && runLen > 1) {
        i = runEnd;
        continue;
      }

      if (openPos === -1) {
        const openEnd = i + len;
        const prevCh = i > 0 ? text[i - 1] : "";
        const nextCh = openEnd < text.length ? text[openEnd] : "";
        const standaloneSpaces =
          (!prevCh || /\s/.test(prevCh)) && (!nextCh || /\s/.test(nextCh));

        if (
          !nextCh ||
          standaloneSpaces ||
          (opts.disallowWordBoundary && /[A-Za-z0-9_]/.test(prevCh)) ||
          (opts.disallowInnerWhitespaceFlanking && /\s/.test(nextCh))
        ) {
          i = runEnd;
          continue;
        }

        openPos = i;
        i = openEnd;
      } else {
        // When closing `**` on a `***` run (e.g. `**bold *italic***`), claim the rightmost 2 chars
        // so the inner `*` remains free to close `*italic*`.
        const closeStart = runLen === len + 1 ? runEnd - len : i;
        const closeEnd = closeStart + len;
        const openEnd = openPos + len;
        const prevCh = closeStart > 0 ? text[closeStart - 1] : "";
        const nextCh = closeEnd < text.length ? text[closeEnd] : "";
        const standaloneSpaces =
          (!prevCh || /\s/.test(prevCh)) && (!nextCh || /\s/.test(nextCh));

        if (
          closeStart <= openEnd ||
          standaloneSpaces ||
          (opts.disallowWordBoundary && /[A-Za-z0-9_]/.test(nextCh)) ||
          (opts.disallowInnerWhitespaceFlanking && /\s/.test(prevCh)) ||
          !text.slice(openEnd, closeStart).trim()
        ) {
          i = runEnd;
          continue;
        }

        const absOpenStart = lineFrom + openPos;
        const absOpenEnd = lineFrom + openEnd;
        const absCloseStart = lineFrom + closeStart;
        const absCloseEnd = lineFrom + closeEnd;
        claimMarker(absOpenStart, absOpenEnd);
        claimMarker(absCloseStart, absCloseEnd);
        emitWrapped(
          absOpenStart,
          absOpenEnd,
          absCloseStart,
          absCloseEnd,
          Decoration.mark({ class: contentClass })
        );
        openPos = -1;
        i = closeEnd;
      }
    }
  };

  pushDelimPair("***", "cm-md-bold cm-md-italic");
  pushDelimPair("___", "cm-md-bold cm-md-italic", { disallowWordBoundary: true });
  pushDelimPair("**", "cm-md-bold");
  pushDelimPair("__", "cm-md-bold", { disallowWordBoundary: true });
  pushDelimPair("~~", "cm-md-strike");
  pushDelimPair("++", "cm-md-underline");
  pushDelimPair("==", "cm-md-highlight");
  pushDelimPair("*", "cm-md-italic", { disallowInnerWhitespaceFlanking: true });
  pushDelimPair("_", "cm-md-italic", { disallowInnerWhitespaceFlanking: true, disallowWordBoundary: true });
  pushDelimPair("~", "cm-md-sub", { disallowInnerWhitespaceFlanking: true });
  pushDelimPair("^", "cm-md-sup", { disallowInnerWhitespaceFlanking: true });

  // 8) Defined abbreviations (`*[HTML]: ...` / `[HTML]: ...`) with hover tooltip via GlobalTooltip
  if (abbrMap && abbrMap.size > 0) {
    const terms = Array.from(abbrMap.keys()).sort((a, b) => b.length - a.length);
    const escapedTerms = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const abbrRe = new RegExp(`(?<![A-Za-z0-9_])(${escapedTerms.join("|")})(?![A-Za-z0-9_])`, "g");
    let abm: RegExpExecArray | null;
    while ((abm = abbrRe.exec(text)) !== null) {
      const start = lineFrom + abm.index;
      const end = start + abm[0].length;
      if (isBlocked(start, end)) continue;
      const desc = abbrMap.get(abm[1]);
      if (!desc) continue;
      items.push({
        from: start,
        to: end,
        kind: "mark",
        deco: Decoration.mark({
          class: "cm-md-abbr",
          attributes: { "data-tip": `${abm[1]}：${desc}` },
        }),
      });
    }
  }
}

function createBlockWidgetsField(cb: LivePreviewCallbacks) {
  const compute = (state: EditorView["state"]): DecorationSet => {
    try {
      if (!cb.isLiveMode() || cb.isLargeFile()) return Decoration.none;
      const doc = state.doc;
    const builder = new RangeSetBuilder<Decoration>();
    const focused = state.field(editorFocusedField, false) ?? false;
    const selRanges = state.selection.ranges;
    const isSelIn = (from: number, to: number) =>
      focused && selRanges.some((r) => r.from <= to && r.to >= from);

    let ln = 1;
    while (ln <= doc.lines) {
      const line = doc.line(ln);
      const trimmed = line.text.trim();

      // Fenced code blocks (Mermaid diagrams + Editorial Code Block Cards!)
      const fenceMatch = /^(`{3,}|~{3,})(.*)$/.exec(trimmed);
      if (fenceMatch) {
        const fenceChar = fenceMatch[1][0];
        const lang = fenceMatch[2].trim();
        let endLn = ln + 1;
        while (endLn <= doc.lines) {
          const t = doc.line(endLn).text.trim();
          if (t.startsWith(fenceChar.repeat(3)) && t.replace(new RegExp(`\\${fenceChar}`, "g"), "").trim() === "") {
            break;
          }
          endLn++;
        }
        if (endLn <= doc.lines) {
          const blockFrom = line.from;
          const blockTo = doc.line(endLn).to;
          if (!isSelIn(blockFrom, blockTo)) {
            const innerStart = Math.min(line.to + 1, doc.line(endLn).from);
            const innerEnd = Math.max(innerStart, doc.line(endLn).from - 1);
            const code = innerStart <= doc.line(endLn).from ? state.sliceDoc(innerStart, innerEnd) : "";
            if (/^mermaid$/i.test(lang)) {
              builder.add(blockFrom, blockTo, Decoration.replace({ widget: new MermaidWidget(code.trim()), block: true }));
            } else {
              builder.add(blockFrom, blockTo, Decoration.replace({ widget: new CodeBlockWidget(code, lang), block: true }));
            }
          }
          ln = endLn + 1;
          continue;
        }
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
    } catch (err) {
      console.error("Folia block widget decoration error:", err);
      return Decoration.none;
    }
  };

  return StateField.define<DecorationSet>({
    create(state) {
      return compute(state);
    },
    update(deco, tr) {
      const focusChanged = tr.effects.some((e) => e.is(editorFocusEffect));
      if (tr.docChanged || tr.selection || tr.reconfigured || focusChanged) {
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
          update.focusChanged ||
          update.geometryChanged
        ) {
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

      const fnEl = target?.closest("[data-folia-footnote]") as HTMLElement | null;
      if (fnEl) {
        event.preventDefault();
        const fnId = fnEl.dataset.foliaFootnote || "";
        if (fnId) cb.onNavigateFootnote?.(fnId);
        return true;
      }

      const linkEl = target?.closest("[data-folia-href]") as HTMLElement | null;
      if (!linkEl) return false;
      event.preventDefault();
      const href = linkEl.dataset.foliaHref || "";
      const isWiki = linkEl.dataset.foliaWiki === "true";
      cb.onNavigateLink(href, isWiki);
      return true;
    },
  });

  const focusTracker = EditorView.focusChangeEffect.of((_state, focusing) =>
    editorFocusEffect.of(focusing)
  );

  return [editorFocusedField, focusTracker, inlinePlugin, createBlockWidgetsField(cb), linkClickHandler];
}
