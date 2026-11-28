<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from "vue";
import { X } from "lucide-vue-next";
import { marked } from "marked";
import { resolveImageSrc, parseAbbreviationDef } from "@/core/markdown/livePreview";
import { highlightCodeBlock } from "@/core/markdown/codeHighlighter";
import { HEADING_CUSTOM_ID_RE, slugifyHeading } from "@/core/markdown/outline";
import { useI18n } from "@/core/i18n";

const { t } = useI18n();

const props = defineProps<{
  content: string;
  notePath: string;
  scrollRatio?: number;
}>();

const emit = defineEmits<{
  (e: "image-lightbox", payload: { src: string; alt: string }): void;
  (e: "close"): void;
}>();

const hostRef = ref<HTMLDivElement | null>(null);
const renderedHtml = ref("");
let renderTimer: ReturnType<typeof setTimeout> | null = null;
let mermaidCounter = 0;

function preprocessMarkdown(raw: string): string {
  // Strip YAML frontmatter for clean preview
  let text = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  // Collect and strip abbreviation definitions (`*[HTML]: ...` or non-URL `[HTML]: ...`)
  const abbrs = new Map<string, string>();
  const keptLines: string[] = [];
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      keptLines.push(line);
      continue;
    }
    if (!inFence) {
      const def = parseAbbreviationDef(line);
      if (def) {
        abbrs.set(def.term, def.expansion);
        continue;
      }
    }
    keptLines.push(line);
  }
  text = keptLines.join("\n");

  // Convert Obsidian ![[img|alt]] to standard markdown image
  text = text.replace(/!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_m, target, alt) => {
    const cleanTarget = String(target).trim();
    const label = alt ? String(alt).trim() : cleanTarget;
    return `![${label}](${cleanTarget})`;
  });
  // Highlight ==text==, underline ++text++, sub/sup, and footnotes
  text = text.replace(/==([^=\n]+)==/g, "<mark>$1</mark>");
  text = text.replace(/\+\+([^+\n]+)\+\+/g, "<u>$1</u>");
  text = text.replace(/(?<!~)~([^~\s][^~\n]*?)~(?!~)/g, "<sub>$1</sub>");
  text = text.replace(/\^([^^\s][^^\n]*?)\^/g, "<sup>$1</sup>");
  text = text.replace(/\[\^([^\]\s]+)\]:/g, '<span class="cm-md-footnote-def">$1</span>');
  text = text.replace(/\[\^([^\]\s]+)\](?!:)/g, '<sup class="cm-md-footnote-ref">$1</sup>');

  // Apply abbreviations to plain text outside fenced blocks / inline code
  if (abbrs.size > 0) {
    const terms = Array.from(abbrs.keys()).sort((a, b) => b.length - a.length);
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const attrEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    const abbrRe = new RegExp(`(?<![A-Za-z0-9_])(${terms.map(esc).join("|")})(?![A-Za-z0-9_])`, "g");
    const segments = text.split(/(```[\s\S]*?```|`[^`\n]+`|<[^>]+>)/g);
    text = segments
      .map((seg, i) =>
        i % 2 === 1
          ? seg
          : seg.replace(abbrRe, (match) => {
              const desc = abbrs.get(match);
              return desc ? `<abbr class="cm-md-abbr" title="${attrEsc(desc)}">${match}</abbr>` : match;
            })
      )
      .join("");
  }

  return text;
}

async function renderPreview() {
  const pre = preprocessMarkdown(props.content);
  const rawHtml = await marked.parse(pre, { gfm: true, breaks: true });
  renderedHtml.value = rawHtml;
  await nextTick();
  await enhanceRenderedDom();
}

async function enhanceRenderedDom() {
  const root = hostRef.value;
  if (!root) return;

  // 1) Resolve local image URLs via folia-asset://
  for (const img of Array.from(root.querySelectorAll("img"))) {
    const srcAttr = img.getAttribute("src") || "";
    const resolved = resolveImageSrc(srcAttr, props.notePath);
    img.src = resolved;
    img.onclick = () => emit("image-lightbox", { src: resolved, alt: img.alt || "" });
  }

  // 1.2) Assign heading IDs (`{#id33}` custom IDs + GitHub-style auto slugs) & wire internal `#anchor` links
  const slugCounts = new Map<string, number>();
  for (const h of Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6"))) {
    const raw = h.innerHTML;
    const idM = HEADING_CUSTOM_ID_RE.exec(h.textContent || "");
    if (idM) {
      h.id = idM[1];
      h.innerHTML = raw.replace(HEADING_CUSTOM_ID_RE, "").trim();
    } else {
      const base = slugifyHeading(h.textContent || "");
      if (base) {
        const seen = slugCounts.get(base) ?? 0;
        slugCounts.set(base, seen + 1);
        h.id = seen === 0 ? base : `${base}-${seen}`;
      }
    }
  }
  for (const a of Array.from(root.querySelectorAll("a[href^='#']"))) {
    a.addEventListener("click", (e) => {
      const href = a.getAttribute("href") || "";
      if (!href.startsWith("#")) return;
      e.preventDefault();
      let id = href.slice(1);
      try { id = decodeURIComponent(id); } catch { /* keep */ }
      const target =
        root.querySelector(`[id="${CSS.escape(id)}"]`) ??
        root.querySelector(`[id="${CSS.escape(slugifyHeading(id))}"]`);
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  // 1.5) Transform GitHub/Obsidian callout blockquotes (`> [!NOTE] ...`)
  const iconMap: Record<string, string> = {
    NOTE: "ℹ️",
    TIP: "💡",
    IMPORTANT: "📌",
    WARNING: "⚠️",
    CAUTION: "🛑",
  };
  for (const bq of Array.from(root.querySelectorAll("blockquote"))) {
    const firstP = bq.querySelector("p");
    if (!firstP) continue;
    const html = firstP.innerHTML.trim();
    const m = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:<br\s*\/?>|\s+)?([\s\S]*)$/i.exec(html);
    if (!m) continue;
    const kind = m[1].toUpperCase();
    bq.classList.add("folia-preview-callout", `is-${kind.toLowerCase()}`);
    const titleEl = document.createElement("div");
    titleEl.className = "folia-preview-callout-title";
    titleEl.textContent = `${iconMap[kind] ?? "ℹ️"} ${kind}`;
    firstP.innerHTML = m[2].trim();
    if (!firstP.innerHTML) firstP.remove();
    bq.prepend(titleEl);
  }

  // 2) Render Mermaid fenced code blocks
  const mermaidBlocks = Array.from(root.querySelectorAll("pre > code.language-mermaid"));
  if (mermaidBlocks.length > 0) {
    try {
      const mod = await import("mermaid");
      mod.default.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: document.documentElement.dataset.themeMode === "dark" ? "dark" : "default",
      });
      for (const codeEl of mermaidBlocks) {
        const preEl = codeEl.parentElement;
        if (!preEl) continue;
        const code = codeEl.textContent || "";
        const box = document.createElement("div");
        box.className = "folia-md-mermaid";
        try {
          const { svg } = await mod.default.render(`folia-sp-mmd-${++mermaidCounter}`, code);
          box.innerHTML = svg;
        } catch (err) {
          box.classList.add("is-error");
          box.textContent = `Mermaid 语法错误: ${err instanceof Error ? err.message : String(err)}`;
        }
        preEl.replaceWith(box);
      }
    } catch {
      // ignore
    }
  }

  // 2.5) Syntax-highlight non-Mermaid fenced code blocks with CodeMirror/Lezer parsers
  const codeBlocks = Array.from(root.querySelectorAll("pre > code"));
  for (const codeEl of codeBlocks) {
    const cls = codeEl.className || "";
    const langM = /\blanguage-([^\s]+)/i.exec(cls);
    const lang = langM?.[1] ?? "";
    if (!lang || /^mermaid$/i.test(lang)) continue;
    const rawCode = codeEl.textContent ?? "";
    codeEl.classList.add("folia-hl-code");
    const highlighted = highlightCodeBlock(rawCode, lang);
    codeEl.innerHTML = highlighted.lines.join("\n");
    if (highlighted.pending) {
      void highlighted.pending.then((readyLines) => {
        if (codeEl.isConnected) {
          codeEl.innerHTML = readyLines.join("\n");
        }
      });
    }
  }

  // 3) Render block & inline KaTeX math in text nodes outside <code>/<pre>
  if (root.textContent?.includes("$")) {
    try {
      const katex = (await import("katex")).default;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      let n: Node | null;
      while ((n = walker.nextNode())) {
        const p = n.parentElement;
        if (!p || p.closest("code, pre, .katex")) continue;
        if (n.nodeValue && n.nodeValue.includes("$")) nodes.push(n as Text);
      }
      for (const textNode of nodes) {
        const val = textNode.nodeValue || "";
        const replaced = val
          .replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex) =>
            katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false })
          )
          .replace(/(?<!\$)\$([^$\n]+)\$(?!\$)/g, (_m, tex) =>
            katex.renderToString(tex.trim(), { displayMode: false, throwOnError: false })
          );
        if (replaced !== val) {
          const span = document.createElement("span");
          span.innerHTML = replaced;
          textNode.replaceWith(span);
        }
      }
    } catch {
      // ignore
    }
  }
}

watch(
  () => [props.content, props.notePath],
  () => {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(() => void renderPreview(), 140);
  }
);

watch(
  () => props.scrollRatio,
  (ratio) => {
    if (ratio === undefined || !hostRef.value) return;
    const el = hostRef.value;
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = ratio * maxScroll;
  }
);

onMounted(() => {
  void renderPreview();
});
</script>

<template>
  <div class="source-preview-shell">
    <div class="source-preview-header">
      <span class="source-preview-title">{{ t("editor.previewTitle") }}</span>
      <button
        type="button"
        class="source-preview-close"
        :data-tip="t('editor.previewCloseTip')"
        @click="emit('close')"
      >
        <X :size="14" />
      </button>
    </div>
    <div ref="hostRef" class="source-preview-pane">
      <article class="preview-article" v-html="renderedHtml" />
    </div>
  </div>
</template>

<style scoped>
.source-preview-shell {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--bg-surface);
}
.source-preview-header {
  height: 30px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px 0 16px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-base);
}
.source-preview-title {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-muted);
  letter-spacing: 0.02em;
}
.source-preview-close {
  width: 22px;
  height: 22px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.source-preview-close:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.source-preview-pane {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  background: var(--bg-surface);
  padding: 20px 32px 120px;
}
.preview-article {
  max-width: none;
  margin: 0;
  font-family: var(--font-prose);
  font-size: var(--editor-font-size);
  line-height: var(--editor-line-height);
  color: var(--text-primary);
  word-break: break-word;
}
.preview-article :deep(h1),
.preview-article :deep(h2),
.preview-article :deep(h3),
.preview-article :deep(h4) {
  color: var(--md-heading);
  font-weight: 700;
  line-height: 1.4;
  margin: 1.15em 0 0.5em;
}
.preview-article :deep(h1) { font-size: 1.72em; }
.preview-article :deep(h2) { font-size: 1.38em; }
.preview-article :deep(h3) { font-size: 1.18em; }
.preview-article :deep(strong) { color: var(--md-bold); }
.preview-article :deep(a) { color: var(--md-link); text-decoration: none; border-bottom: 1px dashed var(--md-link); }
.preview-article :deep(ol li::marker) {
  font-family: var(--font-code);
  font-weight: 700;
  color: var(--md-heading);
}
.preview-article :deep(ul li::marker) {
  color: var(--md-heading);
}
.preview-article :deep(code) {
  background: color-mix(in srgb, var(--md-code-bg) 85%, transparent);
  color: var(--md-code);
  padding: 2px 6px;
  border-radius: 5px;
  font-family: var(--font-code);
  font-size: 0.88em;
}
.preview-article :deep(pre) {
  background: color-mix(in srgb, var(--md-code-bg) 52%, var(--bg-base));
  border: 1px solid var(--border-color);
  padding: 12px 16px;
  border-radius: 8px;
  overflow-x: auto;
  font-family: var(--font-code);
}
.preview-article :deep(pre code) {
  background: transparent;
  padding: 0;
  color: var(--text-primary);
}
.preview-article :deep(blockquote) {
  margin: 10px 0;
  padding: 4px 14px;
  border-left: 3px solid var(--md-quote-bar);
  color: var(--text-secondary);
}
.preview-article :deep(blockquote.folia-preview-callout) {
  padding: 10px 14px;
  border-radius: 0 6px 6px 0;
  border-left-color: #2563eb;
  background: rgba(37, 99, 235, 0.08);
  color: var(--text-primary);
}
.preview-article :deep(blockquote.folia-preview-callout.is-tip) { border-left-color: #16a34a; background: rgba(22, 163, 74, 0.09); }
.preview-article :deep(blockquote.folia-preview-callout.is-important) { border-left-color: #7c3aed; background: rgba(124, 58, 237, 0.09); }
.preview-article :deep(blockquote.folia-preview-callout.is-warning) { border-left-color: #d97706; background: rgba(217, 119, 6, 0.1); }
.preview-article :deep(blockquote.folia-preview-callout.is-caution) { border-left-color: #dc2626; background: rgba(220, 38, 38, 0.09); }
.preview-article :deep(.folia-preview-callout-title) {
  font-weight: 700;
  margin-bottom: 4px;
}
.preview-article :deep(blockquote.folia-preview-callout p) {
  margin: 2px 0 0;
}
.preview-article :deep(table) {
  border-collapse: separate;
  border-spacing: 0;
  width: 100%;
  margin: 12px 0;
  font-size: 0.94em;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  overflow: hidden;
}
.preview-article :deep(th),
.preview-article :deep(td) {
  border-bottom: 1px solid var(--border-color);
  border-right: 1px solid var(--border-color);
  padding: 9px 14px;
  text-align: left;
}
.preview-article :deep(th:last-child),
.preview-article :deep(td:last-child) {
  border-right: none;
}
.preview-article :deep(tbody tr:last-child td) {
  border-bottom: none;
}
.preview-article :deep(th) {
  background: color-mix(in srgb, var(--bg-base) 75%, var(--bg-hover));
  font-weight: 600;
}
.preview-article :deep(img) {
  max-width: 100%;
  max-height: 460px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-color);
  cursor: zoom-in;
}
.preview-article :deep(mark) {
  background: var(--mark-bg);
  padding: 1px 4px;
  border-radius: 4px;
}
.preview-article :deep(hr) {
  border: none;
  border-top: 1.5px dashed color-mix(in srgb, var(--border-color) 90%, var(--text-muted));
  margin: 18px 0;
}
</style>
