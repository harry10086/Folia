<script setup lang="ts">
import { computed, ref } from "vue";
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  FileText,
  FileCode,
  Image as ImageIcon,
  FileSpreadsheet,
  File as FileIcon,
} from "lucide-vue-next";
import type { FileNode } from "@/core/ipc/client";
import { useWorkspaceStore } from "@/stores/workspace";

const props = defineProps<{
  node: FileNode;
  depth: number;
}>();

const emit = defineEmits<{
  (e: "open-file", node: FileNode): void;
  (e: "context-menu", payload: { event: MouseEvent; node: FileNode }): void;
  (e: "drop-move", payload: { srcPath: string; destDir: string }): void;
}>();

const wsStore = useWorkspaceStore();
const isDragOver = ref(false);

const isFolder = computed(() => props.node.kind === "folder");
const isExpanded = computed(() => isFolder.value && wsStore.isFolderExpanded(props.node.path));
const isSelected = computed(
  () =>
    wsStore.selectedPath !== null &&
    wsStore.selectedPath.toLowerCase() === props.node.path.toLowerCase()
);

function handleClick() {
  wsStore.selectedPath = props.node.path;
  if (isFolder.value) {
    wsStore.toggleFolder(props.node.path);
  } else {
    emit("open-file", props.node);
  }
}

function handleContextMenu(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
  wsStore.selectedPath = props.node.path;
  emit("context-menu", { event, node: props.node });
}

function handleDragStart(event: DragEvent) {
  if (!event.dataTransfer) return;
  event.dataTransfer.setData("application/x-folia-path", props.node.path);
  event.dataTransfer.setData("application/x-folia-kind", props.node.kind);
  event.dataTransfer.setData("text/plain", props.node.name);
  event.dataTransfer.effectAllowed = "copyMove";
}

function handleDragOver(event: DragEvent) {
  if (!isFolder.value) return;
  if (event.dataTransfer?.types.includes("application/x-folia-path")) {
    event.preventDefault();
    isDragOver.value = true;
  }
}

function handleDragLeave() {
  isDragOver.value = false;
}

function handleDrop(event: DragEvent) {
  isDragOver.value = false;
  if (!isFolder.value) return;
  const srcPath = event.dataTransfer?.getData("application/x-folia-path");
  if (!srcPath || srcPath === props.node.path) return;
  event.preventDefault();
  event.stopPropagation();
  emit("drop-move", { srcPath, destDir: props.node.path });
}
</script>

<template>
  <div class="tree-item-wrapper">
    <div
      class="tree-row"
      :class="{ 'is-selected': isSelected, 'is-drag-over': isDragOver }"
      :data-node-path="wsStore.normalizeKey(node.path)"
      :style="{ paddingLeft: `${depth * 14 + 10}px` }"
      draggable="true"
      @click="handleClick"
      @contextmenu="handleContextMenu"
      @dragstart="handleDragStart"
      @dragover="handleDragOver"
      @dragleave="handleDragLeave"
      @drop="handleDrop"
      :title="node.path"
    >
      <span class="tree-chevron">
        <template v-if="isFolder">
          <ChevronDown v-if="isExpanded" :size="14" />
          <ChevronRight v-else :size="14" />
        </template>
      </span>

      <span class="tree-icon" :class="`kind-${node.kind}`">
        <FolderOpen v-if="isFolder && isExpanded" :size="15" />
        <Folder v-else-if="isFolder" :size="15" />
        <FileText v-else-if="node.kind === 'markdown'" :size="15" />
        <FileCode v-else-if="node.kind === 'html'" :size="15" />
        <ImageIcon v-else-if="node.kind === 'image'" :size="15" />
        <FileSpreadsheet v-else-if="node.kind === 'pdf'" :size="15" />
        <FileIcon v-else :size="15" />
      </span>

      <span class="tree-label">{{ node.name }}</span>
    </div>

    <div v-if="isFolder && isExpanded && node.children" class="tree-children">
      <FileTreeNode
        v-for="child in node.children"
        :key="child.path"
        :node="child"
        :depth="depth + 1"
        @open-file="(n) => emit('open-file', n)"
        @context-menu="(p) => emit('context-menu', p)"
        @drop-move="(p) => emit('drop-move', p)"
      />
    </div>
  </div>
</template>

<style scoped>
.tree-row {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 29px;
  padding-right: 10px;
  margin: 1px 6px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  user-select: none;
  color: var(--sidebar-text);
  font-size: 13px;
  transition: background 0.12s ease;
}
.tree-row:hover { background: var(--sidebar-hover); }
.tree-row.is-selected { background: var(--sidebar-active); font-weight: 500; color: var(--sidebar-text); }
.tree-row.is-drag-over { outline: 1.5px dashed var(--accent); background: var(--accent-soft); }
.tree-chevron { width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; color: var(--sidebar-text-muted); }
.tree-icon { display: inline-flex; align-items: center; flex-shrink: 0; color: var(--sidebar-text-muted); }
.tree-icon.kind-folder { color: var(--accent); opacity: 0.85; }
.tree-icon.kind-html { color: #ea580c; }
.tree-icon.kind-image { color: #10b981; }
.tree-icon.kind-pdf { color: #ef4444; }
.tree-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
</style>
