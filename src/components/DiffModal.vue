<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { X, GitCompare } from "lucide-vue-next";
import { useTabsStore } from "@/stores/tabs";
import { useI18n } from "@/core/i18n";

const { t } = useI18n();

const tabsStore = useTabsStore();
const mergeHostRef = ref<HTMLDivElement | null>(null);
let mergeView: MergeView | null = null;

function mountMerge() {
  if (mergeView) { mergeView.destroy(); mergeView = null; }
  if (!mergeHostRef.value || !tabsStore.diffState.open) return;

  const sharedExts = [
    lineNumbers(),
    EditorView.lineWrapping,
    EditorState.readOnly.of(true),
    markdown(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  ];

  mergeView = new MergeView({
    parent: mergeHostRef.value,
    a: { doc: tabsStore.diffState.contentLeft, extensions: sharedExts },
    b: { doc: tabsStore.diffState.contentRight, extensions: sharedExts },
    highlightChanges: true,
    gutter: true,
  });
}

watch(
  () => [tabsStore.diffState.open, tabsStore.diffState.contentLeft, tabsStore.diffState.contentRight],
  () => { setTimeout(() => mountMerge(), 20); }
);
onMounted(() => { if (tabsStore.diffState.open) mountMerge(); });
onBeforeUnmount(() => { mergeView?.destroy(); mergeView = null; });

async function useDiskVersion() {
  if (tabsStore.diffState.conflictTabId) await tabsStore.reloadTabFromDisk(tabsStore.diffState.conflictTabId);
  tabsStore.closeDiff();
}
async function keepCurrentVersion() {
  if (tabsStore.diffState.conflictTabId) await tabsStore.keepLocalAndOverwrite(tabsStore.diffState.conflictTabId);
  tabsStore.closeDiff();
}
</script>

<template>
  <Teleport to="body">
    <div v-if="tabsStore.diffState.open" class="diff-overlay" @click="tabsStore.closeDiff()">
      <div class="diff-modal" @click.stop>
        <div class="diff-header">
          <div class="diff-title"><GitCompare :size="16" /><span>{{ t("diff.title") }}</span></div>
          <div class="diff-actions">
            <template v-if="tabsStore.diffState.conflictTabId">
              <button class="btn-secondary" @click="useDiskVersion">{{ t("diff.useDisk") }}</button>
              <button class="btn-primary" @click="keepCurrentVersion">{{ t("diff.keepCurrent") }}</button>
            </template>
            <button class="icon-close" @click="tabsStore.closeDiff()" :title="t('common.close')"><X :size="17" /></button>
          </div>
        </div>
        <div class="diff-subheaders">
          <div class="sub-pane">{{ tabsStore.diffState.titleLeft }}</div>
          <div class="sub-pane">{{ tabsStore.diffState.titleRight }}</div>
        </div>
        <div ref="mergeHostRef" class="diff-body" />
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.diff-overlay { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.48); display: flex; align-items: center; justify-content: center; z-index: 3500; padding: 24px; }
.diff-modal { width: min(1240px, 94vw); height: min(820px, 88vh); background: var(--bg-elevated); border: 1px solid var(--border-color); border-radius: var(--radius-lg); box-shadow: var(--shadow-md); display: flex; flex-direction: column; overflow: hidden; }
.diff-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border-color); }
.diff-title { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; }
.diff-actions { display: flex; align-items: center; gap: 8px; }
.diff-subheaders { display: grid; grid-template-columns: 1fr 1fr; border-bottom: 1px solid var(--border-color); background: var(--bg-base); font-size: 12.5px; font-weight: 600; color: var(--text-secondary); }
.sub-pane { padding: 7px 14px; }
.sub-pane:first-child { border-right: 1px solid var(--border-color); }
.diff-body { flex: 1; min-height: 0; overflow: auto; }
.diff-body :deep(.cm-mergeView), .diff-body :deep(.cm-mergeViewEditors) { height: 100%; }
.diff-body :deep(.cm-content) { max-width: none; padding: 12px 16px; }
.btn-primary { padding: 6px 13px; border: none; border-radius: var(--radius-pill); background: var(--accent); color: #fff; font-size: 12.5px; cursor: pointer; }
.btn-secondary { padding: 6px 13px; border: 1px solid var(--border-color); border-radius: var(--radius-pill); background: var(--bg-surface); color: var(--text-primary); font-size: 12.5px; cursor: pointer; }
.icon-close { border: none; background: transparent; color: var(--text-muted); cursor: pointer; padding: 4px; border-radius: var(--radius-sm); }
.icon-close:hover { background: var(--bg-hover); color: var(--text-primary); }
</style>
