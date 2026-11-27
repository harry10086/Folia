<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Paperclip, FileText, File as FileIcon, Plus, Copy, ExternalLink, RefreshCw } from "lucide-vue-next";
import { ipc, toAssetUrl, type AttachmentItem } from "@/core/ipc/client";
import { useTabsStore } from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";

const props = defineProps<{ notePath: string }>();

const emit = defineEmits<{
  (e: "insert-markdown", snippet: string): void;
  (e: "preview-image", payload: { src: string; alt: string }): void;
}>();

const tabsStore = useTabsStore();
const wsStore = useWorkspaceStore();
const items = ref<AttachmentItem[]>([]);
const loading = ref(false);
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

const currentWorkspaceRevision = computed(() => {
  if (!props.notePath) return 0;
  const ws = wsStore.findWorkspaceForPath(props.notePath);
  return ws ? (wsStore.workspaceRevisions[ws.id] ?? 0) : 0;
});

async function refresh() {
  if (!props.notePath) {
    items.value = [];
    return;
  }
  loading.value = true;
  try { items.value = await ipc.listAttachments(props.notePath); }
  catch { items.value = []; }
  finally { loading.value = false; }
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    void refresh();
  }, 120);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function insertItem(item: AttachmentItem) {
  const rel = item.relativePath.includes(" ") ? `<${item.relativePath}>` : item.relativePath;
  const stem = item.name.replace(/\.[^.]+$/, "");
  emit("insert-markdown", item.kind === "image" ? `![${stem}](${rel})` : `[${item.name}](${rel})`);
}

async function copyRelPath(item: AttachmentItem) {
  try {
    await navigator.clipboard.writeText(item.relativePath);
    tabsStore.showToast(`已复制相对路径: ${item.relativePath}`);
  } catch {
    tabsStore.showToast("复制失败");
  }
}

function openItem(item: AttachmentItem) {
  if (item.kind === "image") emit("preview-image", { src: toAssetUrl(item.path, item.mtimeMs), alt: item.name });
  else if (item.kind === "pdf") void tabsStore.openFile(item.path);
  else void ipc.openSystemPath(item.path);
}

watch(() => props.notePath, () => void refresh());
watch(currentWorkspaceRevision, () => scheduleRefresh());
onMounted(() => void refresh());
onBeforeUnmount(() => {
  if (refreshTimer) clearTimeout(refreshTimer);
});
</script>

<template>
  <div class="attachment-bar">
    <div class="bar-header">
      <div class="bar-title"><Paperclip :size="14" /><span>当前目录附件（{{ items.length }}）</span></div>
      <button class="bar-btn" @click="refresh" title="刷新附件"><RefreshCw :size="13" :class="{ spin: loading }" /></button>
    </div>

    <div class="bar-list">
      <div v-if="items.length === 0" class="bar-empty">当前笔记所在目录及 images/附件 子目录中暂无图片或附件</div>
      <div v-for="item in items" :key="item.path" class="attach-card">
        <div class="attach-thumb" @click="openItem(item)" :title="item.relativePath">
          <img v-if="item.kind === 'image'" :src="toAssetUrl(item.path, item.mtimeMs)" :alt="item.name" loading="lazy" />
          <FileText v-else-if="item.kind === 'pdf'" :size="24" class="icon-pdf" />
          <FileIcon v-else :size="24" class="icon-other" />
        </div>
        <div class="attach-meta">
          <div class="attach-name" :title="item.relativePath">{{ item.name }}</div>
          <div class="attach-size">{{ formatSize(item.sizeBytes) }}</div>
        </div>
        <div class="attach-actions">
          <button class="mini-btn" @click="insertItem(item)" title="插入到编辑器"><Plus :size="13" /></button>
          <button class="mini-btn" @click="copyRelPath(item)" title="复制相对路径"><Copy :size="12" /></button>
          <button class="mini-btn" @click="ipc.revealInFileManager(item.path)" title="在资源管理器中显示"><ExternalLink :size="12" /></button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.attachment-bar { height: 152px; flex-shrink: 0; display: flex; flex-direction: column; background: var(--bg-base); border-top: 1px solid var(--border-color); user-select: none; }
.bar-header { display: flex; align-items: center; justify-content: space-between; padding: 5px 12px; border-bottom: 1px solid var(--border-color); font-size: 12px; font-weight: 600; color: var(--text-secondary); }
.bar-title { display: flex; align-items: center; gap: 6px; }
.bar-btn { border: none; background: transparent; color: var(--text-muted); cursor: pointer; padding: 3px 5px; border-radius: var(--radius-sm); }
.bar-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.bar-list { flex: 1; display: flex; align-items: center; gap: 10px; padding: 8px 12px; overflow-x: auto; overflow-y: hidden; }
.bar-empty { width: 100%; text-align: center; font-size: 12.5px; color: var(--text-muted); }
.attach-card { width: 148px; flex-shrink: 0; background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 6px; display: flex; flex-direction: column; gap: 4px; }
.attach-thumb { height: 58px; border-radius: var(--radius-sm); background: var(--bg-base); display: flex; align-items: center; justify-content: center; overflow: hidden; cursor: pointer; }
.attach-thumb img { width: 100%; height: 100%; object-fit: cover; }
.icon-pdf { color: #ef4444; }
.icon-other { color: var(--text-muted); }
.attach-meta { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
.attach-name { font-size: 11.5px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.attach-size { font-size: 10.5px; color: var(--text-muted); flex-shrink: 0; }
.attach-actions { display: flex; justify-content: flex-end; gap: 3px; }
.mini-btn { width: 22px; height: 20px; display: inline-flex; align-items: center; justify-content: center; border: none; background: var(--bg-base); color: var(--text-secondary); border-radius: 4px; cursor: pointer; }
.mini-btn:hover { background: var(--accent-soft); color: var(--accent); }
.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
