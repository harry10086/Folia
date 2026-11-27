<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
  crosshairCursor,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { html as htmlLanguage } from "@codemirror/lang-html";
import { HighlightStyle, syntaxHighlighting, bracketMatching } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { autocompletion } from "@codemirror/autocomplete";
import {
  createMarkdownLivePreviewExtension,
  refreshLivePreviewEffect,
} from "@/core/markdown/livePreview";
import { resolveCodeLanguageForMarkdown } from "@/core/markdown/codeHighlighter";
import {
  findWikilinkFile,
  isWikilinkTargetValid,
  parseWikilinkTarget,
} from "@/core/markdown/wikilinks";
import { createImageHoverPreviewExtension } from "@/core/markdown/imageHoverPreview";
import { createMarkdownCompletionSource } from "@/core/markdown/slashCommands";
import {
  markdownFormatKeymap,
  columnEditingKeymap,
  markdownAutoSurroundExtension,
} from "@/core/markdown/formatCommands";
import { extractOutline, findAnchorLine, type HeadingItem } from "@/core/markdown/outline";
import { ipc, parseIpcError } from "@/core/ipc/client";
import type { OpenTab } from "@/stores/tabs";
import { useSettingsStore } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";
import { useTabsStore } from "@/stores/tabs";
import Minimap from "./Minimap.vue";

const props = defineProps<{ tab: OpenTab }>();

const emit = defineEmits<{
  (e: "outline-change", headings: HeadingItem[]): void;
  (e: "cursor-change", info: { line: number; col: number; words: number; chars: number }): void;
  (e: "image-lightbox", payload: { src: string; alt: string }): void;
  (e: "scroll-ratio", ratio: number): void;
}>();

const settings = useSettingsStore();
const wsStore = useWorkspaceStore();
const tabsStore = useTabsStore();

const hostRef = ref<HTMLDivElement | null>(null);
const scrollRatio = ref(0);
const viewportRatio = ref(0.25);
const activeLine = ref(1);

let view: EditorView | null = null;
let suppressDocChange = false;

const foliaHighlightStyle = HighlightStyle.define([
  { tag: [tags.heading, tags.heading1, tags.heading2, tags.heading3, tags.heading4, tags.heading5, tags.heading6], color: "var(--md-heading)", fontWeight: "700", textDecoration: "none" },
  { tag: tags.strong, color: "var(--md-bold)", fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through", color: "var(--text-muted)" },
  { tag: [tags.link, tags.url], color: "var(--md-link)", textDecoration: "none" },
  { tag: tags.monospace, color: "var(--md-code)" },
  { tag: tags.quote, color: "var(--text-secondary)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.modifier, tags.operatorKeyword, tags.self], color: "var(--syn-keyword)", fontWeight: "500" },
  { tag: [tags.string, tags.docString, tags.character, tags.attributeValue, tags.special(tags.string)], color: "var(--syn-string)" },
  { tag: [tags.regexp, tags.escape], color: "var(--syn-regexp)" },
  { tag: [tags.number, tags.integer, tags.float, tags.unit], color: "var(--syn-number)" },
  { tag: [tags.bool, tags.null, tags.atom], color: "var(--syn-bool)", fontWeight: "500" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.definition(tags.function(tags.variableName)), tags.labelName], color: "var(--syn-func)" },
  { tag: [tags.macroName, tags.meta, tags.processingInstruction, tags.annotation, tags.documentMeta], color: "var(--syn-macro)" },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.standard(tags.typeName)], color: "var(--syn-type)" },
  { tag: [tags.tagName], color: "var(--syn-tag)" },
  { tag: [tags.attributeName, tags.propertyName, tags.definition(tags.propertyName)], color: "var(--syn-attr)" },
  { tag: [tags.special(tags.variableName), tags.constant(tags.variableName), tags.definition(tags.variableName)], color: "var(--syn-var)" },
  { tag: [tags.operator, tags.compareOperator, tags.arithmeticOperator, tags.logicOperator, tags.bitwiseOperator, tags.updateOperator, tags.definitionOperator], color: "var(--syn-operator)" },
  { tag: [tags.punctuation, tags.bracket, tags.angleBracket, tags.squareBracket, tags.paren, tags.brace, tags.separator], color: "var(--syn-punct)" },
  { tag: [tags.inserted], color: "var(--syn-inserted)" },
  { tag: [tags.deleted], color: "var(--syn-deleted)" },
  { tag: [tags.variableName, tags.content], color: "var(--text-primary)" },
]);

const lineNumbersComp = new Compartment();
const wordWrapComp = new Compartment();
const livePreviewComp = new Compartment();

function buildLivePreviewExt() {
  if (props.tab.kind !== "markdown") return [];
  return createMarkdownLivePreviewExtension({
    getNotePath: () => props.tab.path,
    isLiveMode: () => props.tab.editMode === "live",
    isLargeFile: () => props.tab.isLarge,
    isWikilinkValid: (rawTarget, docText) =>
      isWikilinkTargetValid(
        rawTarget,
        docText,
        wsStore.getFilesInWorkspace(props.tab.workspaceId)
      ),
    onNavigateLink: (href, isWiki) => void handleLinkNavigation(href, isWiki),
    onNavigateFootnote: (footnoteId) => jumpToFootnote(footnoteId),
    onImageClick: (src, alt) => emit("image-lightbox", { src, alt }),
  });
}

async function handleLinkNavigation(href: string, isWiki: boolean) {
  const target = href.trim().replace(/^<|>$/g, "");
  if (!target) return;

  if (/^https?:\/\//i.test(target)) {
    try { await ipc.openExternalUrl(target); } catch { window.open(target, "_blank"); }
    return;
  }
  if (target.startsWith("#")) {
    jumpToHeadingSlug(target.slice(1));
    return;
  }

  if (isWiki) {
    const parsed = parseWikilinkTarget(target);
    if (!parsed.filePart && parsed.anchor) {
      jumpToHeadingSlug(parsed.anchor);
      return;
    }
    const candidates = wsStore.getFilesInWorkspace(props.tab.workspaceId);
    const match = findWikilinkFile(parsed.filePart, candidates);
    if (match) {
      await tabsStore.openFile(match.path, { paneId: props.tab.paneId, workspaceId: match.workspaceId });
      if (parsed.anchor) setTimeout(() => jumpToHeadingSlug(parsed.anchor), 100);
    } else {
      tabsStore.showToast(`未在当前工作区找到笔记: ${parsed.filePart || target}`);
    }
    return;
  }

  const [filePart, anchor] = target.split("#");

  try {
    const decoded = decodeURIComponent(filePart);
    const abs = await ipc.resolveRelativePath(props.tab.path, decoded);
    const ext = abs.split(".").pop()?.toLowerCase() ?? "";
    if (["md", "markdown", "txt", "png", "jpg", "jpeg", "gif", "webp", "svg", "pdf"].includes(ext)) {
      await tabsStore.openFile(abs, { paneId: props.tab.paneId, workspaceId: props.tab.workspaceId });
      if (anchor) setTimeout(() => jumpToHeadingSlug(anchor), 120);
    } else {
      await ipc.openSystemPath(abs);
    }
  } catch (err) {
    tabsStore.showToast(`无法打开链接: ${parseIpcError(err).message}`);
  }
}

function jumpToHeadingSlug(slug: string) {
  if (!view) return;
  const lineNo = findAnchorLine(props.tab.content, slug);
  if (lineNo !== null) {
    scrollToLine(lineNo);
  } else {
    tabsStore.showToast(`未找到目标标题或锚点: #${slug}`);
  }
}

function jumpToFootnote(footnoteId: string) {
  if (!view) return;
  const escaped = footnoteId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const defRe = new RegExp(`\\[\\^${escaped}\\]:`);
  const lines = props.tab.content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (defRe.test(lines[i])) {
      scrollToLine(i + 1);
      return;
    }
  }
  tabsStore.showToast(`未找到脚注定义 [^${footnoteId}]:`);
}

function scrollToLine(lineNumber: number) {
  if (!view) return;
  const clamped = Math.max(1, Math.min(lineNumber, view.state.doc.lines));
  const line = view.state.doc.line(clamped);
  view.dispatch({
    selection: { anchor: line.from },
    effects: EditorView.scrollIntoView(line.from, { y: "center" }),
  });
  view.focus();
}

function scrollToTop() { view?.scrollDOM.scrollTo({ top: 0, behavior: "smooth" }); }
function scrollToBottom() { if (view) view.scrollDOM.scrollTo({ top: view.scrollDOM.scrollHeight, behavior: "smooth" }); }
function insertTextAtCursor(snippet: string) {
  if (!view) return;
  const sel = view.state.selection.main;
  view.dispatch({ changes: { from: sel.from, to: sel.to, insert: snippet }, selection: { anchor: sel.from + snippet.length } });
  view.focus();
}

defineExpose({ scrollToLine, scrollToTop, scrollToBottom, insertTextAtCursor });

function emitMetrics(state: EditorState) {
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  activeLine.value = line.number;
  const text = state.doc.toString();
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const latin = (text.replace(/[\u4e00-\u9fa5]/g, " ").match(/\b\w+\b/g) || []).length;
  emit("cursor-change", { line: line.number, col: pos - line.from + 1, words: cjk + latin, chars: text.length });
}

function updateScrollMetrics() {
  if (!view) return;
  const dom = view.scrollDOM;
  const maxScroll = Math.max(1, dom.scrollHeight - dom.clientHeight);
  scrollRatio.value = Math.max(0, Math.min(1, dom.scrollTop / maxScroll));
  viewportRatio.value = Math.max(0.08, Math.min(1, dom.clientHeight / Math.max(1, dom.scrollHeight)));
  emit("scroll-ratio", scrollRatio.value);
}

function handleMinimapSeek(ratio: number) {
  if (!view) return;
  const dom = view.scrollDOM;
  dom.scrollTop = ratio * Math.max(0, dom.scrollHeight - dom.clientHeight);
}

async function handleImageBlobSave(blob: Blob, suggestedName?: string) {
  const ws = wsStore.findWorkspaceForPath(props.tab.path);
  const wsRoot = ws?.rootPath ?? props.tab.path.replace(/[\\/][^\\/]+$/, "");
  const ext = blob.type.split("/")[1]?.replace("jpeg", "jpg") || "png";

  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

  try {
    const saved = await ipc.savePastedImage({
      notePath: props.tab.path,
      workspaceRoot: wsRoot,
      strategy: settings.state.imageSaveStrategy,
      customDir: settings.state.imageSubfolderName,
      suggestedName: suggestedName ?? null,
      ext,
      base64Data: base64,
    });
    const rel = saved.relativePath.includes(" ") ? `<${saved.relativePath}>` : saved.relativePath;
    const alt = suggestedName ? suggestedName.replace(/\.[^.]+$/, "") : "image";
    insertTextAtCursor(`![${alt}](${rel})`);
    if (ws) void wsStore.refreshWorkspace(ws.id);
    tabsStore.showToast(`图片已保存至 ${saved.relativePath}`);
  } catch (err) {
    tabsStore.showToast(`保存图片失败: ${parseIpcError(err).message}`);
  }
}

function handleDomPaste(event: ClipboardEvent): boolean {
  const items = event.clipboardData?.items;
  if (!items) return false;
  for (const item of Array.from(items)) {
    if (item.type.startsWith("image/")) {
      const blob = item.getAsFile();
      if (blob) {
        event.preventDefault();
        void handleImageBlobSave(blob);
        return true;
      }
    }
  }
  return false;
}

function handleDomDrop(event: DragEvent): boolean {
  const dt = event.dataTransfer;
  if (!dt) return false;

  const internalPath = dt.getData("application/x-folia-path");
  if (internalPath) {
    event.preventDefault();
    const kind = dt.getData("application/x-folia-kind");
    void (async () => {
      try {
        const relRaw = await ipc.computeRelativeLink(props.tab.path, internalPath);
        const rel = relRaw.includes(" ") ? `<${relRaw}>` : relRaw;
        const name = internalPath.split(/[\\/]/).pop() || "file";
        const stem = name.replace(/\.[^.]+$/, "");
        insertTextAtCursor(kind === "image" ? `![${stem}](${rel})` : `[${stem}](${rel})`);
      } catch (err) {
        tabsStore.showToast(`插入链接失败: ${parseIpcError(err).message}`);
      }
    })();
    return true;
  }

  if (dt.files && dt.files.length > 0) {
    const file = dt.files[0];
    if (file.type.startsWith("image/")) {
      event.preventDefault();
      void handleImageBlobSave(file, file.name);
      return true;
    }
  }
  return false;
}

function mountEditor() {
  if (!hostRef.value) return;

  const completionSource = createMarkdownCompletionSource({
    getCurrentNotePath: () => props.tab.path,
    getWorkspaceFiles: () => wsStore.getFilesInWorkspace(props.tab.workspaceId),
    getLinkFormat: () => settings.state.linkInsertFormat,
  });

  const isMarkdown = props.tab.kind === "markdown";
  const langExt =
    props.tab.kind === "html"
      ? htmlLanguage()
      : markdown({ base: markdownLanguage, codeLanguages: resolveCodeLanguageForMarkdown });

  const state = EditorState.create({
    doc: props.tab.content,
    extensions: [
      lineNumbersComp.of(settings.state.showLineNumbers ? lineNumbers() : []),
      wordWrapComp.of(settings.state.wordWrap ? EditorView.lineWrapping : []),
      history(),
      EditorState.allowMultipleSelections.of(true),
      drawSelection(),
      rectangularSelection({ eventFilter: (e) => e.altKey && e.button === 0 }),
      crosshairCursor({ key: "Alt" }),
      EditorView.clickAddsSelectionRange.of((e) => e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      highlightSelectionMatches(),
      bracketMatching(),
      syntaxHighlighting(foliaHighlightStyle),
      langExt,
      ...(isMarkdown ? [autocompletion({ override: [completionSource], activateOnTyping: true })] : []),
      keymap.of([
        ...columnEditingKeymap,
        ...(isMarkdown ? markdownFormatKeymap : []),
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
      ]),
      livePreviewComp.of(buildLivePreviewExt()),
      ...(isMarkdown
        ? [
            markdownAutoSurroundExtension,
            createImageHoverPreviewExtension(() => props.tab.path, () => props.tab.editMode),
          ]
        : []),
      EditorView.domEventHandlers({
        paste: (e) => (isMarkdown ? handleDomPaste(e) : false),
        drop: (e) => (isMarkdown ? handleDomDrop(e) : false),
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !suppressDocChange) {
          const text = update.state.doc.toString();
          tabsStore.updateTabContent(props.tab.id, text);
          if (isMarkdown) emit("outline-change", extractOutline(text));
        }
        if (update.docChanged || update.selectionSet) emitMetrics(update.state);
      }),
    ],
  });

  view = new EditorView({ state, parent: hostRef.value });
  view.scrollDOM.addEventListener("scroll", updateScrollMetrics, { passive: true });
  emit("outline-change", extractOutline(props.tab.content));
  emitMetrics(view.state);
  updateScrollMetrics();
  if (props.tab.jumpToLine) scrollToLine(props.tab.jumpToLine);
}

onMounted(() => mountEditor());
onBeforeUnmount(() => {
  if (view) {
    view.scrollDOM.removeEventListener("scroll", updateScrollMetrics);
    view.destroy();
    view = null;
  }
});

watch(() => props.tab.content, (newVal) => {
  if (!view) return;
  const cur = view.state.doc.toString();
  if (cur === newVal) return;
  suppressDocChange = true;
  const cursor = Math.min(view.state.selection.main.head, newVal.length);
  view.dispatch({ changes: { from: 0, to: cur.length, insert: newVal }, selection: { anchor: cursor } });
  suppressDocChange = false;
  emit("outline-change", extractOutline(newVal));
});

watch(() => props.tab.editMode, () => {
  view?.dispatch({ effects: livePreviewComp.reconfigure(buildLivePreviewExt()) });
});

// Re-validate wikilink existence whenever the workspace's file tree changes (delete/rename/create)
watch(
  () => (props.tab.workspaceId ? wsStore.workspaceRevisions[props.tab.workspaceId] ?? 0 : 0),
  () => {
    if (view && props.tab.kind === "markdown") {
      view.dispatch({ effects: refreshLivePreviewEffect.of(null) });
    }
  }
);
watch(() => settings.state.showLineNumbers, (show) => {
  view?.dispatch({ effects: lineNumbersComp.reconfigure(show ? lineNumbers() : []) });
});
watch(() => settings.state.wordWrap, (wrap) => {
  view?.dispatch({ effects: wordWrapComp.reconfigure(wrap ? EditorView.lineWrapping : []) });
});
watch(
  () => [settings.state.editorPageLayout, settings.state.editorMaxWidth],
  () => {
    requestAnimationFrame(() => view?.requestMeasure());
  }
);
watch(() => props.tab.jumpNonce, () => {
  if (props.tab.jumpToLine) scrollToLine(props.tab.jumpToLine);
});
</script>

<template>
  <div class="editor-wrapper" :data-edit-mode="tab.editMode">
    <div v-if="tab.isLarge" class="large-file-banner">
      当前文件较大（{{ (tab.sizeBytes / 1024).toFixed(0) }} KB），已自动切换为高性能源码模式以保障流畅编辑。
    </div>
    <div class="editor-body">
      <div ref="hostRef" class="cm-host" />
      <Minimap
        v-if="settings.state.showMinimap && !tab.isLarge"
        :content="tab.content"
        :scroll-ratio="scrollRatio"
        :viewport-ratio="viewportRatio"
        :active-line="activeLine"
        @seek="handleMinimapSeek"
      />
    </div>
  </div>
</template>

<style scoped>
.editor-wrapper { flex: 1; display: flex; flex-direction: column; min-height: 0; min-width: 0; background: var(--bg-surface); }
.large-file-banner { padding: 5px 14px; font-size: 12px; background: var(--accent-soft); color: var(--accent); border-bottom: 1px solid var(--border-color); }
.editor-body { flex: 1; display: flex; min-height: 0; min-width: 0; overflow: hidden; }
.cm-host { flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
</style>
