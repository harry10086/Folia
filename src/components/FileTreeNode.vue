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
  ArrowDownAZ,
  ArrowDownZA,
  ClockArrowDown,
  ClockArrowUp,
  GripVertical,
} from "lucide-vue-next";
import type { FileNode } from "@/core/ipc/client";
import {
  getParentPath,
  normalizePathKey,
  sortOrderLabel,
  useWorkspaceStore,
} from "@/stores/workspace";

const props = defineProps<{
  node: FileNode;
  depth: number;
}>();

const emit = defineEmits<{
  (e: "open-file", node: FileNode): void;
  (e: "context-menu", payload: { event: MouseEvent; node: FileNode }): void;
  (e: "drop-move", payload: { srcPath: string; destDir: string }): void;
  (e: "reorder-sibling", payload: { srcPath: string; targetPath: string; position: "before" | "after" }): void;
}>();

const wsStore = useWorkspaceStore();
const dropZone = ref<"before" | "inside" | "after" | null>(null);

const isFolder = computed(() => props.node.kind === "folder");
const isExpanded = computed(() => isFolder.value && wsStore.isFolderExpanded(props.node.path));
const isSelected = computed(
  () =>
    wsStore.selectedPath !== null &&
    wsStore.selectedPath.toLowerCase() === props.node.path.toLowerCase()
);

const explicitSort = computed(() =>
  isFolder.value ? wsStore.getFolderExplicitSort(props.node.path) : undefined
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
  wsStore.draggingNodePath = props.node.path;
  event.dataTransfer.setData("application/x-folia-path", props.node.path);
  event.dataTransfer.setData("application/x-folia-kind", props.node.kind);
  event.dataTransfer.setData("text/plain", props.node.name);
  event.dataTransfer.effectAllowed = "copyMove";
}

function handleDragEnd() {
  wsStore.draggingNodePath = null;
  dropZone.value = null;
}

function computeDropZone(event: DragEvent): "before" | "inside" | "after" | null {
  const dragging = wsStore.draggingNodePath;
  if (!dragging) {
    // Fallback if external drag with x-folia-path
    if (isFolder.value && event.dataTransfer?.types.includes("application/x-folia-path")) {
      return "inside";
    }
    return null;
  }

  const dragKey = normalizePathKey(dragging);
  const selfKey = normalizePathKey(props.node.path);
  // Cannot drop onto self or onto one of own descendants
  if (dragKey === selfKey || selfKey.startsWith(`${dragKey}/`)) {
    return null;
  }

  const sameParent =
    normalizePathKey(getParentPath(dragging)) === normalizePathKey(getParentPath(props.node.path));

  const row = event.currentTarget as HTMLElement | null;
  if (!row) return isFolder.value ? "inside" : null;
  const rect = row.getBoundingClientRect();
  const relY = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;

  if (sameParent) {
    if (isFolder.value) {
      if (relY < 0.28) return "before";
      if (relY > 0.72) return "after";
      return "inside";
    }
    return relY < 0.5 ? "before" : "after";
  }

  // Cross-folder drag: drop onto any folder moves into it
  return isFolder.value ? "inside" : null;
}

function handleDragOver(event: DragEvent) {
  if (!event.dataTransfer?.types.includes("application/x-folia-path")) {
    dropZone.value = null;
    return;
  }
  const zone = computeDropZone(event);
  dropZone.value = zone;
  if (zone) {
    event.preventDefault();
    event.stopPropagation();
  }
}

function handleDragLeave(event: DragEvent) {
  const related = event.relatedTarget as Node | null;
  const current = event.currentTarget as HTMLElement | null;
  if (current && related && current.contains(related)) return;
  dropZone.value = null;
}

function handleDrop(event: DragEvent) {
  const zone = dropZone.value ?? computeDropZone(event);
  dropZone.value = null;
  const srcPath =
    event.dataTransfer?.getData("application/x-folia-path") || wsStore.draggingNodePath;
  wsStore.draggingNodePath = null;
  if (!srcPath || !zone) return;
  if (normalizePathKey(srcPath) === normalizePathKey(props.node.path)) return;

  event.preventDefault();
  event.stopPropagation();

  if (zone === "before" || zone === "after") {
    emit("reorder-sibling", {
      srcPath,
      targetPath: props.node.path,
      position: zone,
    });
  } else if (zone === "inside" && isFolder.value) {
    emit("drop-move", { srcPath, destDir: props.node.path });
  }
}
</script>

<template>
  <div class="tree-item-wrapper">
    <div
      class="tree-row"
      :class="{
        'is-selected': isSelected,
        'is-drag-over': dropZone === 'inside',
        'is-drop-before': dropZone === 'before',
        'is-drop-after': dropZone === 'after',
      }"
      :data-node-path="wsStore.normalizeKey(node.path)"
      :style="{ paddingLeft: `${depth * 14 + 10}px` }"
      draggable="true"
      @click="handleClick"
      @contextmenu="handleContextMenu"
      @dragstart="handleDragStart"
      @dragend="handleDragEnd"
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

      <span
        v-if="explicitSort"
        class="folder-sort-icon"
        :data-tip="`此文件夹独立排序：${sortOrderLabel(explicitSort)}`"
      >
        <ArrowDownAZ v-if="explicitSort === 'name-asc'" :size="13" />
        <ArrowDownZA v-else-if="explicitSort === 'name-desc'" :size="13" />
        <ClockArrowDown v-else-if="explicitSort === 'mtime-desc'" :size="13" />
        <ClockArrowUp v-else-if="explicitSort === 'mtime-asc'" :size="13" />
        <GripVertical v-else :size="13" />
      </span>
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
        @reorder-sibling="(p) => emit('reorder-sibling', p)"
      />
    </div>
  </div>
</template>

<style scoped>
.tree-row {
  position: relative;
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
.tree-row.is-drop-before::before {
  content: "";
  position: absolute;
  left: 6px;
  right: 6px;
  top: -1px;
  height: 2px;
  border-radius: 2px;
  background: var(--accent);
  pointer-events: none;
}
.tree-row.is-drop-after::after {
  content: "";
  position: absolute;
  left: 6px;
  right: 6px;
  bottom: -1px;
  height: 2px;
  border-radius: 2px;
  background: var(--accent);
  pointer-events: none;
}
.tree-chevron { width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; color: var(--sidebar-text-muted); }
.tree-icon { display: inline-flex; align-items: center; flex-shrink: 0; color: var(--sidebar-text-muted); }
.tree-icon.kind-folder { color: var(--accent); opacity: 0.85; }
.tree-icon.kind-html { color: #ea580c; }
.tree-icon.kind-image { color: #10b981; }
.tree-icon.kind-pdf { color: #ef4444; }
.tree-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.folder-sort-icon {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  color: var(--sidebar-text-muted);
  opacity: 0.72;
  transition: opacity 0.12s, color 0.12s, background 0.12s;
}
.tree-row:hover .folder-sort-icon {
  opacity: 1;
  color: var(--accent);
  background: var(--accent-soft);
}
</style>
