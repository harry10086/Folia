<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Search, FileText, Image as ImageIcon, File as FileIcon } from "lucide-vue-next";
import { useWorkspaceStore } from "@/stores/workspace";
import { useTabsStore } from "@/stores/tabs";
import { useI18n } from "@/core/i18n";

const { t } = useI18n();

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: "close"): void }>();

const wsStore = useWorkspaceStore();
const tabsStore = useTabsStore();
const query = ref("");
const activeIndex = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);

const results = computed(() => {
  const q = query.value.trim().toLowerCase();
  const list = wsStore.allFiles;
  if (!q) return list.slice(0, 30);
  return list.filter((f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)).slice(0, 35);
});

watch(() => props.open, async (val) => {
  if (val) {
    query.value = "";
    activeIndex.value = 0;
    await nextTick();
    inputRef.value?.focus();
  }
});
watch(query, () => { activeIndex.value = 0; });

function onKeyDown(e: KeyboardEvent) {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (results.value.length > 0) activeIndex.value = (activeIndex.value + 1) % results.value.length;
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (results.value.length > 0) activeIndex.value = (activeIndex.value - 1 + results.value.length) % results.value.length;
  } else if (e.key === "Enter") {
    e.preventDefault();
    const item = results.value[activeIndex.value];
    if (item) selectItem(item.path, item.workspaceId);
  } else if (e.key === "Escape") {
    emit("close");
  }
}

function selectItem(path: string, workspaceId: string) {
  void tabsStore.openFile(path, { workspaceId });
  emit("close");
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="qo-backdrop" @click="emit('close')">
      <div class="qo-modal" @click.stop @keydown="onKeyDown">
        <div class="qo-input-row">
          <Search :size="16" class="qo-icon" />
          <input ref="inputRef" v-model="query" :placeholder="t('quickOpen.placeholder')" class="qo-input" />
          <kbd class="qo-kbd">ESC</kbd>
        </div>
        <div class="qo-list">
          <div v-if="results.length === 0" class="qo-empty">{{ t("quickOpen.empty") }}</div>
          <button
            v-for="(item, idx) in results"
            :key="item.path"
            class="qo-item"
            :class="{ active: idx === activeIndex }"
            @mouseenter="activeIndex = idx"
            @click="selectItem(item.path, item.workspaceId)"
          >
            <FileText v-if="item.kind === 'markdown'" :size="15" />
            <ImageIcon v-else-if="item.kind === 'image'" :size="15" />
            <FileIcon v-else :size="15" />
            <div class="qo-info">
              <div class="qo-name">{{ item.name }}</div>
              <div class="qo-path">{{ item.path }}</div>
            </div>
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.qo-backdrop { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.32); display: flex; justify-content: center; align-items: flex-start; padding-top: 12vh; z-index: 3400; }
.qo-modal { width: min(560px, 90vw); background: var(--bg-elevated); border: 1px solid var(--border-color); border-radius: var(--radius-lg); box-shadow: var(--shadow-md); overflow: hidden; }
.qo-input-row { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--border-color); }
.qo-icon { color: var(--text-muted); }
.qo-input { flex: 1; border: none; outline: none; background: transparent; font-size: 14px; color: var(--text-primary); }
.qo-kbd { font-size: 11px; padding: 2px 6px; border-radius: 4px; border: 1px solid var(--border-color); color: var(--text-muted); }
.qo-list { max-height: 380px; overflow-y: auto; padding: 6px; }
.qo-empty { padding: 24px; text-align: center; font-size: 13px; color: var(--text-muted); }
.qo-item { width: 100%; display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: none; background: transparent; border-radius: var(--radius-sm); cursor: pointer; text-align: left; color: var(--text-primary); }
.qo-item.active { background: var(--accent-soft); color: var(--accent); }
.qo-info { min-width: 0; flex: 1; }
.qo-name { font-size: 13.5px; font-weight: 500; }
.qo-path { font-size: 11px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
