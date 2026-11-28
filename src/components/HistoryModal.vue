<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { History, X, RotateCcw, Copy, Trash2, GitCompare, FileText, BookmarkPlus } from "lucide-vue-next";
import { ipc, isTauriRuntime, parseIpcError, type HistoryEntryMeta } from "@/core/ipc/client";
import { useTabsStore } from "@/stores/tabs";
import { useSettingsStore } from "@/stores/settings";
import { useI18n } from "@/core/i18n";

const { t } = useI18n();

const tabsStore = useTabsStore();
const settings = useSettingsStore();

const entries = ref<HistoryEntryMeta[]>([]);
const loadingList = ref(false);
const loadingContent = ref(false);
const selectedId = ref<string | null>(null);
const selectedContent = ref("");
const viewMode = ref<"diff" | "preview">("diff");

const mergeHostRef = ref<HTMLDivElement | null>(null);
let mergeView: MergeView | null = null;

const targetTab = computed(() => {
  if (!tabsStore.historyModalTabId) return null;
  return tabsStore.allOpenTabs.find((t) => t.id === tabsStore.historyModalTabId) ?? null;
});

const selectedEntry = computed(() => entries.value.find((e) => e.id === selectedId.value) ?? null);

const historyHighlightStyle = HighlightStyle.define([
  { tag: [tags.heading, tags.heading1, tags.heading2, tags.heading3], color: "var(--md-heading)", fontWeight: "700" },
  { tag: tags.strong, color: "var(--md-bold)", fontWeight: "700" },
  { tag: [tags.link, tags.url], color: "var(--md-link)" },
  { tag: tags.monospace, color: "var(--md-code)" },
  { tag: [tags.comment, tags.meta], color: "var(--text-muted)" },
]);

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  const todayStr = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const dStr = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  if (todayStr === dStr) return t("history.today", { time });

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const yStr = `${yesterday.getFullYear()}-${yesterday.getMonth()}-${yesterday.getDate()}`;
  if (yStr === dStr) return t("history.yesterday", { time });

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function reasonLabel(reason: string): string {
  switch (reason) {
    case "manual":
      return t("history.reasonManual");
    case "before-restore":
      return t("history.reasonBeforeRestore");
    case "open":
      return t("history.reasonOpen");
    default:
      return t("history.reasonAuto");
  }
}

function destroyMerge() {
  if (mergeView) {
    mergeView.destroy();
    mergeView = null;
  }
}

function mountDiffView() {
  destroyMerge();
  if (!mergeHostRef.value || !targetTab.value || !selectedEntry.value || viewMode.value !== "diff") {
    return;
  }

  const sharedExts = [
    lineNumbers(),
    EditorView.lineWrapping,
    EditorState.readOnly.of(true),
    markdown(),
    syntaxHighlighting(historyHighlightStyle),
  ];

  mergeView = new MergeView({
    parent: mergeHostRef.value,
    a: { doc: selectedContent.value, extensions: sharedExts },
    b: { doc: targetTab.value.content, extensions: sharedExts },
    highlightChanges: true,
    gutter: true,
  });
}

async function loadHistoryList() {
  const tab = targetTab.value;
  if (!tab || !isTauriRuntime()) {
    entries.value = [];
    selectedId.value = null;
    selectedContent.value = "";
    destroyMerge();
    return;
  }

  loadingList.value = true;
  try {
    entries.value = await ipc.historyList(tab.path);
    if (entries.value.length > 0) {
      const keepExisting = entries.value.some((e) => e.id === selectedId.value);
      await selectSnapshot(keepExisting ? selectedId.value! : entries.value[0].id);
    } else {
      selectedId.value = null;
      selectedContent.value = "";
      destroyMerge();
    }
  } catch (err) {
    tabsStore.showToast(t("history.loadFailed", { msg: parseIpcError(err).message }));
  } finally {
    loadingList.value = false;
  }
}

async function selectSnapshot(id: string) {
  const tab = targetTab.value;
  if (!tab) return;
  selectedId.value = id;
  loadingContent.value = true;
  try {
    selectedContent.value = await ipc.historyRead(tab.path, id);
    await nextTick();
    if (viewMode.value === "diff") {
      mountDiffView();
    }
  } catch (err) {
    tabsStore.showToast(t("history.readFailed", { msg: parseIpcError(err).message }));
  } finally {
    loadingContent.value = false;
  }
}

async function handleCreateManualSnapshot() {
  const tab = targetTab.value;
  if (!tab || !isTauriRuntime()) return;
  try {
    const created = await ipc.historySaveSnapshot({
      path: tab.path,
      content: tab.content,
      reason: "manual",
      minIntervalSecs: 0,
      maxSnapshots: settings.state.historyMaxSnapshots,
      force: true,
    });
    if (created) {
      tabsStore.showToast(t("history.createdToast"));
      await loadHistoryList();
    } else {
      tabsStore.showToast(t("history.duplicateToast"));
    }
  } catch (err) {
    tabsStore.showToast(t("history.createFailed", { msg: parseIpcError(err).message }));
  }
}

async function handleDeleteEntry(entry: HistoryEntryMeta) {
  const tab = targetTab.value;
  if (!tab) return;
  try {
    await ipc.historyDeleteEntry(tab.path, entry.id);
    if (selectedId.value === entry.id) selectedId.value = null;
    await loadHistoryList();
  } catch (err) {
    tabsStore.showToast(t("history.deleteFailed", { msg: parseIpcError(err).message }));
  }
}

async function handleCopySnapshot() {
  if (!selectedEntry.value) return;
  try {
    await navigator.clipboard.writeText(selectedContent.value);
    tabsStore.showToast(t("history.copiedToast"));
  } catch {
    tabsStore.showToast(t("common.copyFailed"));
  }
}

async function handleRestoreSnapshot() {
  const tab = targetTab.value;
  const entry = selectedEntry.value;
  if (!tab || !entry) return;
  await tabsStore.restoreTabFromHistory(tab.id, selectedContent.value, formatTimestamp(entry.timestampMs));
  tabsStore.closeHistoryModal();
}

watch(
  () => tabsStore.historyModalTabId,
  (id) => {
    if (id) {
      selectedId.value = null;
      void loadHistoryList();
    } else {
      destroyMerge();
    }
  }
);

watch(viewMode, async (mode) => {
  if (mode === "diff") {
    await nextTick();
    mountDiffView();
  } else {
    destroyMerge();
  }
});

onBeforeUnmount(() => destroyMerge());
</script>

<template>
  <Teleport to="body">
    <div v-if="targetTab" class="history-overlay" @click="tabsStore.closeHistoryModal()">
      <div class="history-modal" @click.stop>
        <div class="history-header">
          <div class="history-title">
            <History :size="16" />
            <span>{{ t("history.title", { name: targetTab.name }) }}</span>
            <span class="history-badge-note">{{ t("history.badge") }}</span>
          </div>
          <div class="history-header-actions">
            <button class="h-btn" @click="handleCreateManualSnapshot" :data-tip="t('history.createTip')">
              <BookmarkPlus :size="14" /> {{ t("history.createBtn") }}
            </button>
            <button class="h-close" @click="tabsStore.closeHistoryModal()" :title="t('common.close')">
              <X :size="17" />
            </button>
          </div>
        </div>

        <div class="history-body">
          <!-- Left Timeline -->
          <aside class="history-timeline">
            <div v-if="loadingList" class="h-empty">{{ t("history.loading") }}</div>
            <div v-else-if="entries.length === 0" class="h-empty">
              <p>{{ t("history.emptyTitle") }}</p>
              <p class="h-empty-sub">
                {{ t("history.emptySub", { mins: settings.state.historyIntervalMinutes }) }}
              </p>
            </div>
            <div
              v-for="entry in entries"
              :key="entry.id"
              class="h-entry"
              :class="{ active: entry.id === selectedId }"
              @click="selectSnapshot(entry.id)"
            >
              <div class="h-entry-top">
                <span class="h-entry-time">{{ formatTimestamp(entry.timestampMs) }}</span>
                <button
                  class="h-entry-del"
                  :title="t('history.deleteTip')"
                  @click.stop="handleDeleteEntry(entry)"
                >
                  <Trash2 :size="12" />
                </button>
              </div>
              <div class="h-entry-meta">
                <span class="h-reason" :class="`is-${entry.reason}`">{{ reasonLabel(entry.reason) }}</span>
                <span>{{ t("history.metaCharsLines", { chars: entry.chars, lines: entry.lines }) }}</span>
              </div>
            </div>
          </aside>

          <!-- Right Viewer / Diff -->
          <section class="history-viewer">
            <div class="viewer-toolbar">
              <div class="segmented">
                <button :class="{ active: viewMode === 'diff' }" @click="viewMode = 'diff'">
                  <GitCompare :size="13" /> {{ t("history.diffWithCurrent") }}
                </button>
                <button :class="{ active: viewMode === 'preview' }" @click="viewMode = 'preview'">
                  <FileText :size="13" /> {{ t("history.viewFull") }}
                </button>
              </div>
              <div v-if="selectedEntry" class="viewer-actions">
                <button class="h-btn" @click="handleCopySnapshot">
                  <Copy :size="13" /> {{ t("history.copyVersion") }}
                </button>
                <button class="h-btn primary" @click="handleRestoreSnapshot">
                  <RotateCcw :size="13" /> {{ t("history.restoreVersion") }}
                </button>
              </div>
            </div>

            <div v-if="!selectedEntry" class="viewer-empty">
              {{ t("history.selectHint") }}
            </div>
            <template v-else>
              <div v-if="viewMode === 'diff'" class="diff-subheaders">
                <div class="sub-pane">{{ t("history.paneHistorical", { time: formatTimestamp(selectedEntry.timestampMs) }) }}</div>
                <div class="sub-pane">{{ t("history.paneCurrent") }}</div>
              </div>
              <div v-if="loadingContent" class="viewer-empty">{{ t("history.loading") }}</div>
              <div v-else-if="viewMode === 'diff'" ref="mergeHostRef" class="history-diff-host" />
              <pre v-else class="history-preview-pre">{{ selectedContent }}</pre>
            </template>
          </section>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.history-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.48);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 3500;
  padding: 24px;
}
.history-modal {
  width: min(1240px, 94vw);
  height: min(820px, 88vh);
  background: var(--bg-elevated);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.history-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
  gap: 12px;
}
.history-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 14px;
  min-width: 0;
}
.history-badge-note {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted);
  background: var(--bg-base);
  border: 1px solid var(--border-color);
  padding: 2px 8px;
  border-radius: var(--radius-pill);
}
.history-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.history-body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.history-timeline {
  width: 268px;
  flex-shrink: 0;
  border-right: 1px solid var(--border-color);
  background: var(--bg-base);
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.h-empty {
  padding: 28px 14px;
  text-align: center;
  color: var(--text-muted);
  font-size: 12.5px;
}
.h-empty-sub {
  font-size: 11.5px;
  line-height: 1.5;
  margin-top: 8px;
}
.h-entry {
  padding: 9px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.h-entry:hover {
  background: var(--bg-hover);
}
.h-entry.active {
  background: var(--bg-surface);
  border-color: var(--accent);
}
.h-entry-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.h-entry-time {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-primary);
  font-family: var(--font-code);
}
.h-entry-del {
  opacity: 0;
  border: none;
  background: transparent;
  color: var(--text-muted);
  width: 20px;
  height: 20px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.h-entry:hover .h-entry-del {
  opacity: 0.85;
}
.h-entry-del:hover {
  background: color-mix(in srgb, var(--danger) 15%, transparent);
  color: var(--danger);
  opacity: 1;
}
.h-entry-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 5px;
  font-size: 11px;
  color: var(--text-muted);
}
.h-reason {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--bg-hover);
  color: var(--text-secondary);
}
.h-reason.is-manual {
  background: var(--accent-soft);
  color: var(--accent);
}
.h-reason.is-before-restore {
  background: rgba(217, 119, 6, 0.14);
  color: #d97706;
}
.history-viewer {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-surface);
}
.viewer-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-base);
  gap: 10px;
}
.segmented {
  display: inline-flex;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-pill);
  padding: 2px;
  background: var(--bg-surface);
  gap: 2px;
}
.segmented button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: none;
  background: transparent;
  padding: 4px 12px;
  border-radius: var(--radius-pill);
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
}
.segmented button.active {
  background: var(--bg-active);
  color: var(--text-primary);
  font-weight: 600;
}
.viewer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.h-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-pill);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
}
.h-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.h-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.h-btn.primary:hover {
  opacity: 0.92;
  color: #fff;
}
.h-close {
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  padding: 4px;
  border-radius: var(--radius-sm);
}
.h-close:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.diff-subheaders {
  display: grid;
  grid-template-columns: 1fr 1fr;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-base);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}
.sub-pane {
  padding: 6px 14px;
}
.sub-pane:first-child {
  border-right: 1px solid var(--border-color);
}
.viewer-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 13px;
}
.history-diff-host {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.history-diff-host :deep(.cm-mergeView),
.history-diff-host :deep(.cm-mergeViewEditors) {
  height: 100%;
}
.history-diff-host :deep(.cm-content) {
  max-width: none !important;
  margin-left: 8px !important;
  margin-right: 12px !important;
  padding: 12px 0 !important;
}
.history-preview-pre {
  flex: 1;
  min-height: 0;
  overflow: auto;
  margin: 0;
  padding: 18px 24px;
  font-family: var(--font-code);
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
