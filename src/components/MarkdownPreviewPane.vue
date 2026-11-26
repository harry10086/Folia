<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from "vue";
import { marked } from "marked";
import { resolveImageSrc } from "@/core/markdown/livePreview";

const props = defineProps<{
  content: string;
  notePath: string;
  scrollRatio?: number;
}>();

const emit = defineEmits<{
  (e: "image-lightbox", payload: { src: string; alt: string }): void;
}>();

const hostRef = ref<HTMLDivElement | null>(null);
const renderedHtml = ref("");
let renderTimer: ReturnType<typeof setTimeout> | null = null;
let mermaidCounter = 0;

function preprocessMarkdown(raw: string): string {
  // Strip YAML frontmatter for clean preview
  let text = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  // Convert Obsidian ![[img|alt]] to standard markdown image
  text = text.replace(/!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_m, target, alt) => {
    const cleanTarget = String(target).trim();
    const label = alt ? String(alt).trim() : cleanTarget;
    return `![${label}](${cleanTarget})`;
  });
  // Highlight ==text== and underline ++text++
  text = text.replace(/==([^=\n]+)==/g, "<mark>$1</mark>");
  text = text.replace(/\+\+([^+\n]+)\+\+/g, "<u>$1</u>");
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
  <div ref="hostRef" class="source-preview-pane">
    <article class="preview-article" v-html="renderedHtml" />
  </div>
</template>

<style scoped>
.source-preview-pane {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  background: var(--bg-surface);
  padding: 24px 32px 120px;
}
.preview-article {
  max-width: var(--editor-max-width);
  margin: 0 auto;
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
  margin: 1.1em 0 0.5em;
}
.preview-article :deep(h1) { font-size: 1.72em; }
.preview-article :deep(h2) { font-size: 1.42em; }
.preview-article :deep(h3) { font-size: 1.2em; }
.preview-article :deep(strong) { color: var(--md-bold); }
.preview-article :deep(a) { color: var(--md-link); text-decoration: none; border-bottom: 1px dashed var(--md-link); }
.preview-article :deep(code) {
  background: var(--md-code-bg);
  color: var(--md-code);
  padding: 1px 6px;
  border-radius: 4px;
  font-family: var(--font-editor);
  font-size: 0.9em;
}
.preview-article :deep(pre) {
  background: var(--md-code-bg);
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  overflow-x: auto;
}
.preview-article :deep(pre code) {
  background: transparent;
  padding: 0;
}
.preview-article :deep(blockquote) {
  margin: 10px 0;
  padding: 4px 14px;
  border-left: 3px solid var(--md-quote-bar);
  color: var(--text-secondary);
}
.preview-article :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 12px 0;
  font-size: 0.94em;
}
.preview-article :deep(th),
.preview-article :deep(td) {
  border: 1px solid var(--border-color);
  padding: 7px 12px;
  text-align: left;
}
.preview-article :deep(th) {
  background: var(--bg-base);
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
  padding: 0 3px;
  border-radius: 3px;
}
.preview-article :deep(hr) {
  border: none;
  height: 1px;
  background: var(--border-color);
  margin: 16px 0;
}
</style>
