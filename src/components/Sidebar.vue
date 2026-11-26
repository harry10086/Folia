<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";
import {
  FolderPlus,
  FilePlus,
  RefreshCw,
  Search,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Plus,
  X,
  Trash2,
  Edit3,
  Copy,
  ExternalLink,
  GitCompare,
  Clock,
  Settings,
  PanelLeftClose,
  Pin,
  PinOff,
  Terminal,
  ChevronsDownUp,
  ChevronsUpDown,
  ArrowUp,
  ArrowDown,
} from "lucide-vue-next";
import FileTreeNode from "./FileTreeNode.vue";
import { ipc, parseIpcError, type FileNode, type SearchMatch } from "@/core/ipc/client";
import { useWorkspaceStore, type WorkspaceEntry } from "@/stores/workspace";
import { useTabsStore } from "@/stores/tabs";
import { useSettingsStore } from "@/stores/settings";

const emit = defineEmits<{
  (e: "open-settings"): void;
  (e: "collapse-sidebar"): void;
  (e: "autohide-changed", enabled: boolean): void;
}>();

function toggleAutoHide(e: MouseEvent) {
  const next = !settings.state.sidebarAutoHide;
  settings.state.sidebarAutoHide = next;
  (e.currentTarget as HTMLElement | null)?.blur();
  emit("autohide-changed", next);
}

const wsStore = useWorkspaceStore();
const tabsStore = useTabsStore();
const settings = useSettingsStore();

const showRecentView = ref(false);
const treeScrollRef = ref<HTMLDivElement | null>(null);

// Highlight the workspace associated with the active tab (note, HTML, image, or terminal)
const activeWorkspaceId = computed<string | null>(() => {
  const tab = tabsStore.activeTab;
  if (tab?.workspaceId) return tab.workspaceId;
  if (tab?.path) return wsStore.findWorkspaceForPath(tab.path)?.id ?? null;
  if (wsStore.selectedPath) return wsStore.findWorkspaceForPath(wsStore.selectedPath)?.id ?? null;
  return null;
});

function handleToggleCollapseAllTrees() {
  if (wsStore.hasAnyExpandedTree) {
    wsStore.collapseAllTrees();
  } else {
    wsStore.expandAllWorkspaces();
  }
}

// Pointer-based drag reorder for workspaces (reliable in Tauri WebView2)
const wsDragFromIdx = ref<number | null>(null);
const wsDragOverIdx = ref<number | null>(null);
const wsDragSide = ref<"before" | "after" | null>(null);
let pendingWsDrag: { idx: number; startY: number } | null = null;
let suppressNextWsClick = false;

function onWsHeaderMouseDown(idx: number, e: MouseEvent) {
  if (e.button !== 0 || wsStore.workspaces.length < 2) return;
  if ((e.target as HTMLElement | null)?.closest("button")) return;
  pendingWsDrag = { idx, startY: e.clientY };
  window.addEventListener("mousemove", onWsDragMove);
  window.addEventListener("mouseup", onWsDragEnd);
}

function onWsDragMove(e: MouseEvent) {
  if (!pendingWsDrag) return;
  if (wsDragFromIdx.value === null) {
    if (Math.abs(e.clientY - pendingWsDrag.startY) < 6) return;
    wsDragFromIdx.value = pendingWsDrag.idx;
    suppressNextWsClick = true;
    document.body.style.userSelect = "none";
  }

  const container = treeScrollRef.value;
  if (!container) return;
  const headers = Array.from(container.querySelectorAll<HTMLElement>("[data-ws-idx]"));
  wsDragOverIdx.value = null;
  wsDragSide.value = null;

  for (const el of headers) {
    const rect = el.getBoundingClientRect();
    if (e.clientY >= rect.top - 10 && e.clientY <= rect.bottom + 10) {
      const targetIdx = Number(el.dataset.wsIdx);
      wsDragOverIdx.value = targetIdx;
      wsDragSide.value = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
      break;
    }
  }
}

function onWsDragEnd() {
  window.removeEventListener("mousemove", onWsDragMove);
  window.removeEventListener("mouseup", onWsDragEnd);
  document.body.style.userSelect = "";

  const from = wsDragFromIdx.value;
  const over = wsDragOverIdx.value;
  const side = wsDragSide.value;
  pendingWsDrag = null;
  wsDragFromIdx.value = null;
  wsDragOverIdx.value = null;
  wsDragSide.value = null;

  if (from !== null && over !== null && side) {
    let target = side === "after" ? over + 1 : over;
    if (from < target) target -= 1;
    if (from !== target) {
      wsStore.moveWorkspace(from, target);
    }
  }
  setTimeout(() => {
    suppressNextWsClick = false;
  }, 40);
}

function handleWorkspaceHeaderClick(wsId: string) {
  if (suppressNextWsClick) {
    suppressNextWsClick = false;
    return;
  }
  wsStore.toggleWorkspaceCollapsed(wsId);
}

// Auto-follow active tab: scroll the revealed file row smoothly into view inside the sidebar
watch(
  () => wsStore.revealNonce,
  () => {
    const target = wsStore.selectedPath;
    if (!target || showRecentView.value) return;
    const key = wsStore.normalizeKey(target);
    void nextTick(() => {
      const container = treeScrollRef.value;
      if (!container) return;
      const rows = container.querySelectorAll<HTMLElement>("[data-node-path]");
      for (const row of rows) {
        if (row.dataset.nodePath === key) {
          row.scrollIntoView({ block: "nearest", behavior: "smooth" });
          break;
        }
      }
    });
  }
);

// Unified filter + full-text search options (driven directly by wsStore.filterQuery)
const searchCaseSensitive = ref(false);
const searchWholeWord = ref(false);
const searchUseRegex = ref(false);
const searchScope = ref<string>("all");
const searching = ref(false);
const searchResults = ref<SearchMatch[]>([]);
const searchMeta = ref({ scannedFiles: 0, truncated: false });
let searchDebounce: ReturnType<typeof setTimeout> | null = null;

const hasQuery = computed(() => wsStore.filterQuery.trim().length > 0);

const ctxMenu = reactive<{
  visible: boolean;
  x: number;
  y: number;
  node: FileNode | null;
  workspace: WorkspaceEntry | null;
}>({
  visible: false,
  x: 0,
  y: 0,
  node: null,
  workspace: null,
});

const promptModal = reactive<{
  open: boolean;
  mode: "newNote" | "newFolder" | "rename";
  title: string;
  placeholder: string;
  value: string;
  targetPath: string;
  workspaceId: string;
}>({
  open: false,
  mode: "newNote",
  title: "",
  placeholder: "",
  value: "",
  targetPath: "",
  workspaceId: "",
});

const groupedSearchResults = computed(() => {
  const map = new Map<string, { fileName: string; path: string; workspaceId: string; items: SearchMatch[] }>();
  for (const m of searchResults.value) {
    let group = map.get(m.path);
    if (!group) {
      group = { fileName: m.fileName, path: m.path, workspaceId: m.workspaceId, items: [] };
      map.set(m.path, group);
    }
    group.items.push(m);
  }
  return Array.from(map.values());
});

const matchedFileCount = computed(() => {
  if (!hasQuery.value) return 0;
  let count = 0;
  const walk = (n: FileNode | null) => {
    if (!n) return;
    if (n.kind !== "folder") count++;
    if (n.children) n.children.forEach(walk);
  };
  for (const ws of wsStore.displayWorkspaces) walk(ws.tree);
  return count;
});

function focusGlobalSearch() {
  showRecentView.value = false;
  setTimeout(() => {
    const input = document.getElementById("folia-unified-search-input") as HTMLInputElement | null;
    input?.focus();
    input?.select();
  }, 30);
}

defineExpose({ focusGlobalSearch });

watch(
  () => wsStore.filterQuery,
  () => {
    scheduleFullTextSearch();
  }
);

function scheduleFullTextSearch() {
  if (searchDebounce) clearTimeout(searchDebounce);
  const q = wsStore.filterQuery.trim();
  if (!q) {
    void ipc.cancelSearch().catch(() => {});
    searchResults.value = [];
    searchMeta.value = { scannedFiles: 0, truncated: false };
    searching.value = false;
    return;
  }
  searchDebounce = setTimeout(() => {
    void runFullTextSearch();
  }, 240);
}

async function runFullTextSearch() {
  const q = wsStore.filterQuery.trim();
  if (!q) return;
  const roots =
    searchScope.value === "all"
      ? wsStore.workspaces.map((w) => ({ workspaceId: w.id, rootPath: w.rootPath }))
      : wsStore.workspaces
          .filter((w) => w.id === searchScope.value)
          .map((w) => ({ workspaceId: w.id, rootPath: w.rootPath }));

  if (roots.length === 0) return;

  searching.value = true;
  try {
    const res = await ipc.searchFilesContent({
      roots,
      query: q,
      caseSensitive: searchCaseSensitive.value,
      wholeWord: searchWholeWord.value,
      useRegex: searchUseRegex.value,
      maxResults: 400,
    });
    if (!res.cancelled) {
      searchResults.value = res.matches;
      searchMeta.value = { scannedFiles: res.scannedFiles, truncated: res.truncated };
    }
  } catch (err) {
    tabsStore.showToast(`搜索失败: ${parseIpcError(err).message}`);
  } finally {
    searching.value = false;
  }
}

function clearSearch() {
  wsStore.filterQuery = "";
}

function cycleSortOrder() {
  const orders = ["name-asc", "name-desc", "mtime-desc"] as const;
  const idx = orders.indexOf(wsStore.sortOrder);
  wsStore.sortOrder = orders[(idx + 1) % orders.length];
}

const sortLabel = computed(() => {
  if (wsStore.sortOrder === "name-desc") return "名称 Z-A";
  if (wsStore.sortOrder === "mtime-desc") return "按修改时间";
  return "名称 A-Z";
});

function handleOpenFile(node: FileNode) {
  void tabsStore.openFile(node.path, { workspaceId: node.workspaceId });
}

function openNodeContextMenu(payload: { event: MouseEvent; node: FileNode }) {
  ctxMenu.visible = true;
  ctxMenu.x = Math.min(payload.event.clientX, window.innerWidth - 190);
  ctxMenu.y = Math.min(payload.event.clientY, window.innerHeight - 280);
  ctxMenu.node = payload.node;
  ctxMenu.workspace = wsStore.workspaces.find((w) => w.id === payload.node.workspaceId) ?? null;
}

function openWorkspaceContextMenu(event: MouseEvent, ws: WorkspaceEntry) {
  event.preventDefault();
  ctxMenu.visible = true;
  ctxMenu.x = Math.min(event.clientX, window.innerWidth - 190);
  ctxMenu.y = Math.min(event.clientY, window.innerHeight - 220);
  ctxMenu.node = ws.tree;
  ctxMenu.workspace = ws;
}

function closeContextMenu() {
  ctxMenu.visible = false;
}

function resolveTargetDir(): { dir: string; workspaceId: string } | null {
  if (ctxMenu.node) {
    const dir =
      ctxMenu.node.kind === "folder"
        ? ctxMenu.node.path
        : ctxMenu.node.path.replace(/[\\/][^\\/]+$/, "");
    return { dir, workspaceId: ctxMenu.node.workspaceId };
  }
  if (wsStore.selectedPath) {
    const ws = wsStore.findWorkspaceForPath(wsStore.selectedPath);
    if (ws) {
      const isDir = wsStore.allFiles.every(
        (f) => f.path.toLowerCase() !== wsStore.selectedPath!.toLowerCase()
      );
      const dir = isDir ? wsStore.selectedPath : wsStore.selectedPath.replace(/[\\/][^\\/]+$/, "");
      return { dir, workspaceId: ws.id };
    }
  }
  const first = wsStore.workspaces[0];
  return first ? { dir: first.rootPath, workspaceId: first.id } : null;
}

function triggerNewNote(explicitDir?: string, explicitWsId?: string) {
  closeContextMenu();
  const target = explicitDir
    ? { dir: explicitDir, workspaceId: explicitWsId ?? "" }
    : resolveTargetDir();
  if (!target) {
    tabsStore.showToast("请先添加一个本地笔记文件夹");
    return;
  }
  promptModal.open = true;
  promptModal.mode = "newNote";
  promptModal.title = "新建笔记";
  promptModal.placeholder = "例如：ESP32开发记录.md";
  promptModal.value = "";
  promptModal.targetPath = target.dir;
  promptModal.workspaceId = target.workspaceId;
}

function triggerNewFolder(explicitDir?: string, explicitWsId?: string) {
  closeContextMenu();
  const target = explicitDir
    ? { dir: explicitDir, workspaceId: explicitWsId ?? "" }
    : resolveTargetDir();
  if (!target) {
    tabsStore.showToast("请先添加一个本地笔记文件夹");
    return;
  }
  promptModal.open = true;
  promptModal.mode = "newFolder";
  promptModal.title = "新建文件夹";
  promptModal.placeholder = "输入文件夹名称";
  promptModal.value = "";
  promptModal.targetPath = target.dir;
  promptModal.workspaceId = target.workspaceId;
}

function triggerRename() {
  const node = ctxMenu.node;
  closeContextMenu();
  if (!node) return;
  promptModal.open = true;
  promptModal.mode = "rename";
  promptModal.title = "重命名";
  promptModal.placeholder = "输入新名称";
  promptModal.value = node.name;
  promptModal.targetPath = node.path;
  promptModal.workspaceId = node.workspaceId;
}

async function submitPrompt() {
  const val = promptModal.value.trim();
  if (!val) return;
  const { mode, targetPath, workspaceId } = promptModal;
  promptModal.open = false;

  try {
    if (mode === "newNote") {
      const created = await ipc.createFile(targetPath, val, `# ${val.replace(/\.md$/i, "")}\n\n`);
      if (workspaceId) await wsStore.refreshWorkspace(workspaceId);
      await tabsStore.openFile(created, { workspaceId });
    } else if (mode === "newFolder") {
      await ipc.createFolder(targetPath, val);
      if (workspaceId) await wsStore.refreshWorkspace(workspaceId);
    } else if (mode === "rename") {
      const newPath = await ipc.renamePath(targetPath, val);
      tabsStore.handlePathRenamed(targetPath, newPath);
      if (workspaceId) await wsStore.refreshWorkspace(workspaceId);
      tabsStore.showToast("重命名成功");
    }
  } catch (err) {
    tabsStore.showToast(`操作失败: ${parseIpcError(err).message}`, 3500);
  }
}

async function handleCopyNode() {
  const node = ctxMenu.node;
  closeContextMenu();
  if (!node) return;
  const parentDir = node.path.replace(/[\\/][^\\/]+$/, "");
  try {
    await ipc.copyPath(node.path, parentDir);
    await wsStore.refreshWorkspace(node.workspaceId);
    tabsStore.showToast("已创建副本");
  } catch (err) {
    tabsStore.showToast(`复制失败: ${parseIpcError(err).message}`);
  }
}

async function handleDeleteNode() {
  const node = ctxMenu.node;
  closeContextMenu();
  if (!node) return;
  try {
    await ipc.deleteToTrash(node.path);
    tabsStore.handlePathDeleted(node.path);
    await wsStore.refreshWorkspace(node.workspaceId);
    tabsStore.showToast(`已移至回收站: ${node.name}`);
  } catch (err) {
    tabsStore.showToast(`删除失败: ${parseIpcError(err).message}`);
  }
}

async function handleRevealInExplorer() {
  const node = ctxMenu.node;
  closeContextMenu();
  if (!node) return;
  try {
    await ipc.revealInFileManager(node.path);
  } catch (err) {
    tabsStore.showToast(`打开失败: ${parseIpcError(err).message}`);
  }
}

async function handleCompareWithActive() {
  const node = ctxMenu.node;
  closeContextMenu();
  if (!node || node.kind !== "markdown") return;
  const active = tabsStore.activeTab;
  if (!active || active.kind !== "markdown") {
    tabsStore.showToast("请先打开一个 Markdown 文件用于对比");
    return;
  }
  await tabsStore.openFilesDiff(active.path, node.path);
}

async function handleDropMove(payload: { srcPath: string; destDir: string }) {
  try {
    const newPath = await ipc.movePath(payload.srcPath, payload.destDir);
    tabsStore.handlePathRenamed(payload.srcPath, newPath);
    await wsStore.refreshAll();
    tabsStore.showToast("已移动文件");
  } catch (err) {
    tabsStore.showToast(`移动失败: ${parseIpcError(err).message}`, 3500);
  }
}
</script>

<template>
  <aside class="sidebar" @click="closeContextMenu">
    <!-- Obsidian-style compact top toolbar aligned with TabBar height (38px) -->
    <div class="sidebar-top-bar">
      <div class="toolbar-left">
        <button class="icon-btn" @click="triggerNewNote()" data-tip="新建笔记 (Ctrl+N)">
          <FilePlus :size="15" />
        </button>
        <button class="icon-btn" @click="triggerNewFolder()" data-tip="新建文件夹">
          <FolderPlus :size="15" />
        </button>
        <button class="icon-btn" @click="cycleSortOrder" :data-tip="`排序方式: ${sortLabel}`">
          <ArrowUpDown :size="15" />
        </button>
        <button class="icon-btn" @click="wsStore.refreshAll()" data-tip="刷新文件树">
          <RefreshCw :size="14" :class="{ spin: wsStore.loading }" />
        </button>
        <button
          class="icon-btn"
          @click="handleToggleCollapseAllTrees"
          :data-tip="wsStore.hasAnyExpandedTree ? '收起所有笔记库目录树' : '展开所有笔记库'"
        >
          <ChevronsDownUp v-if="wsStore.hasAnyExpandedTree" :size="15" />
          <ChevronsUpDown v-else :size="15" />
        </button>
        <button
          class="icon-btn"
          :class="{ active: showRecentView }"
          @click="showRecentView = !showRecentView"
          data-tip="最近打开"
        >
          <Clock :size="15" />
        </button>
      </div>
      <div class="sidebar-top-spacer" data-tauri-drag-region />
      <div class="toolbar-right">
        <button
          class="icon-btn"
          :class="{ active: settings.state.sidebarAutoHide }"
          @click="toggleAutoHide($event)"
          :data-tip="settings.state.sidebarAutoHide ? '当前：自动隐藏（点击固定侧边栏）' : '当前：固定显示（点击开启自动隐藏）'"
        >
          <PinOff v-if="settings.state.sidebarAutoHide" :size="14" />
          <Pin v-else :size="14" />
        </button>
        <button class="icon-btn" @click="emit('collapse-sidebar')" data-tip="折叠左侧栏 (Ctrl+Shift+B)">
          <PanelLeftClose :size="15" />
        </button>
      </div>
    </div>

    <!-- Unified Filter + Full-Text Search Bar -->
    <div v-if="!showRecentView" class="unified-search-area">
      <div class="filter-box">
        <Search :size="13" class="filter-icon" />
        <input
          id="folia-unified-search-input"
          v-model="wsStore.filterQuery"
          type="text"
          placeholder="过滤文件名或搜索内容..."
          class="filter-input"
          @keydown.enter="runFullTextSearch"
          @keydown.esc="clearSearch"
        />
        <button v-if="hasQuery" class="icon-btn-xs" @click="clearSearch" title="清空">
          <X :size="12" />
        </button>
      </div>

      <!-- Inline search options appear automatically when typing -->
      <div v-if="hasQuery" class="search-options">
        <button
          class="opt-chip"
          :class="{ active: searchCaseSensitive }"
          @click="searchCaseSensitive = !searchCaseSensitive; runFullTextSearch()"
          title="区分大小写"
        >
          Aa
        </button>
        <button
          class="opt-chip"
          :class="{ active: searchWholeWord }"
          @click="searchWholeWord = !searchWholeWord; runFullTextSearch()"
          title="全字匹配"
        >
          \b
        </button>
        <button
          class="opt-chip"
          :class="{ active: searchUseRegex }"
          @click="searchUseRegex = !searchUseRegex; runFullTextSearch()"
          title="正则表达式"
        >
          .*
        </button>
        <select v-model="searchScope" @change="runFullTextSearch" class="scope-select">
          <option value="all">全部库</option>
          <option v-for="ws in wsStore.workspaces" :key="ws.id" :value="ws.id">
            {{ ws.name }}
          </option>
        </select>
      </div>
    </div>

    <!-- RECENT FILES VIEW (optional toggle via clock icon) -->
    <div v-if="showRecentView" class="tree-scroll recent-view">
      <div class="section-caption">
        <span>最近打开</span>
        <button class="link-mini" @click="showRecentView = false">返回文件树</button>
      </div>
      <div v-if="tabsStore.recentFiles.length === 0" class="empty-ws">
        <p>暂无最近打开记录</p>
      </div>
      <div
        v-for="item in tabsStore.recentFiles"
        :key="item.path"
        class="recent-row"
        @click="tabsStore.openFile(item.path, { workspaceId: item.workspaceId })"
        :title="item.path"
      >
        <div class="recent-name">{{ item.name }}</div>
        <div class="recent-path">{{ item.path }}</div>
      </div>
    </div>

    <!-- MAIN FILE TREE + UNIFIED SEARCH RESULTS -->
    <div v-else ref="treeScrollRef" class="tree-scroll">
      <div v-if="wsStore.workspaces.length === 0" class="empty-ws">
        <p>尚未添加本地笔记文件夹</p>
        <button class="primary-btn" @click="wsStore.pickAndAddWorkspace()">
          <Plus :size="15" /><span>打开笔记文件夹</span>
        </button>
      </div>

      <template v-else>
        <!-- Filtered File Tree Section -->
        <div v-if="hasQuery" class="section-caption">
          <span>匹配文件（{{ matchedFileCount }}）</span>
        </div>

        <div
          v-for="(ws, wsIdx) in wsStore.displayWorkspaces"
          :key="ws.id"
          class="workspace-section"
        >
          <template v-if="!hasQuery || (ws.tree && ws.tree.children && ws.tree.children.length > 0)">
            <div
              class="workspace-header"
              :data-ws-idx="wsIdx"
              :class="{
                'is-active-ws': activeWorkspaceId === ws.id,
                'ws-dragging': wsDragFromIdx === wsIdx,
                'ws-drop-before': wsDragOverIdx === wsIdx && wsDragSide === 'before',
                'ws-drop-after': wsDragOverIdx === wsIdx && wsDragSide === 'after',
              }"
              @mousedown="onWsHeaderMouseDown(wsIdx, $event)"
              @click="handleWorkspaceHeaderClick(ws.id)"
              @contextmenu="openWorkspaceContextMenu($event, ws)"
              :data-tip="`${ws.rootPath}\n点击展开/收起 · 按住拖动可调整笔记库顺序`"
            >
              <ChevronDown v-if="!ws.collapsed" :size="14" class="ws-chevron" />
              <ChevronRight v-else :size="14" class="ws-chevron" />
              <span class="ws-name">{{ ws.name }}</span>
              <div class="ws-actions" @click.stop>
                <button
                  v-if="wsStore.workspaces.length > 1 && wsIdx > 0"
                  class="ws-action-btn ws-move-btn"
                  @click="wsStore.moveWorkspace(wsIdx, wsIdx - 1)"
                  data-tip="上移笔记库"
                >
                  <ArrowUp :size="13" />
                </button>
                <button
                  v-if="wsStore.workspaces.length > 1 && wsIdx < wsStore.workspaces.length - 1"
                  class="ws-action-btn ws-move-btn"
                  @click="wsStore.moveWorkspace(wsIdx, wsIdx + 1)"
                  data-tip="下移笔记库"
                >
                  <ArrowDown :size="13" />
                </button>
                <button
                  class="ws-action-btn"
                  @click="tabsStore.openTerminalForWorkspace(ws.id, ws.name, ws.rootPath)"
                  data-tip="在此笔记库打开命令终端"
                >
                  <Terminal :size="14" :stroke-width="2" />
                </button>
                <button
                  class="ws-action-btn"
                  @click="triggerNewNote(ws.rootPath, ws.id)"
                  data-tip="在此笔记库新建笔记"
                >
                  <FilePlus :size="14" :stroke-width="2" />
                </button>
                <button
                  class="ws-action-btn danger"
                  @click="wsStore.removeWorkspace(ws.id)"
                  data-tip="移除此笔记库（不删除本地文件）"
                >
                  <X :size="14" :stroke-width="2.1" />
                </button>
              </div>
            </div>

            <div v-if="!ws.collapsed && ws.tree && ws.tree.children" class="workspace-tree">
              <FileTreeNode
                v-for="child in ws.tree.children"
                :key="child.path"
                :node="child"
                :depth="0"
                @open-file="handleOpenFile"
                @context-menu="openNodeContextMenu"
                @drop-move="handleDropMove"
              />
            </div>
          </template>
        </div>

        <!-- Inline Full-Text Search Matches (shown automatically when query is non-empty) -->
        <div v-if="hasQuery" class="content-matches-section">
          <div class="section-caption">
            <span v-if="searching">正在检索全文...</span>
            <span v-else>
              全文匹配（{{ searchResults.length }} 处{{ searchMeta.truncated ? "+" : "" }}）
            </span>
          </div>

          <div v-if="!searching && groupedSearchResults.length === 0" class="no-matches">
            无匹配的正文内容
          </div>

          <div
            v-for="group in groupedSearchResults"
            :key="group.path"
            class="search-file-group"
          >
            <div class="search-file-title" :title="group.path">
              <span>{{ group.fileName }}</span>
              <span class="badge">{{ group.items.length }}</span>
            </div>
            <div
              v-for="(item, idx) in group.items"
              :key="idx"
              class="search-match-row"
              @click="tabsStore.openFile(item.path, { line: item.lineNumber, workspaceId: item.workspaceId })"
            >
              <span class="match-line-no">{{ item.lineNumber }}</span>
              <span class="match-snippet">{{ item.lineText }}</span>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- Bottom-left Obsidian-style Footer: Settings at far bottom-left + Add Folder -->
    <div class="sidebar-footer">
      <button class="footer-icon-btn" @click="emit('open-settings')" data-tip="设置 (Ctrl+,)">
        <Settings :size="16" />
      </button>
      <button class="add-ws-btn" @click="wsStore.pickAndAddWorkspace()" data-tip="添加本地笔记目录">
        <Plus :size="14" /><span>添加笔记库</span>
      </button>
    </div>

    <!-- Context Menu & Prompt Dialog -->
    <Teleport to="body">
      <div v-if="ctxMenu.visible" class="ctx-backdrop" @click="closeContextMenu" @contextmenu.prevent="closeContextMenu">
        <div class="ctx-menu" :style="{ left: `${ctxMenu.x}px`, top: `${ctxMenu.y}px` }" @click.stop>
          <button class="ctx-item" @click="triggerNewNote()"><FilePlus :size="14" /> 新建笔记</button>
          <button class="ctx-item" @click="triggerNewFolder()"><FolderPlus :size="14" /> 新建文件夹</button>
          <button
            v-if="ctxMenu.workspace && (!ctxMenu.node || ctxMenu.node.path === ctxMenu.workspace.rootPath)"
            class="ctx-item"
            @click="tabsStore.openTerminalForWorkspace(ctxMenu.workspace.id, ctxMenu.workspace.name, ctxMenu.workspace.rootPath); closeContextMenu()"
          >
            <Terminal :size="14" /> 在命令终端中打开
          </button>
          <div class="ctx-sep" />
          <template v-if="ctxMenu.node && ctxMenu.node.path !== ctxMenu.workspace?.rootPath">
            <button class="ctx-item" @click="triggerRename()"><Edit3 :size="14" /> 重命名</button>
            <button class="ctx-item" @click="handleCopyNode()"><Copy :size="14" /> 创建副本</button>
            <button v-if="ctxMenu.node.kind === 'markdown'" class="ctx-item" @click="handleCompareWithActive()"><GitCompare :size="14" /> 与当前打开文件 Diff 对比</button>
          </template>
          <button class="ctx-item" @click="handleRevealInExplorer()"><ExternalLink :size="14" /> 在文件管理器中显示</button>
          <template v-if="ctxMenu.node && ctxMenu.node.path !== ctxMenu.workspace?.rootPath">
            <div class="ctx-sep" />
            <button class="ctx-item danger" @click="handleDeleteNode()"><Trash2 :size="14" /> 移至回收站</button>
          </template>
        </div>
      </div>

      <div v-if="promptModal.open" class="modal-backdrop" @click="promptModal.open = false">
        <div class="prompt-dialog" @click.stop>
          <h3>{{ promptModal.title }}</h3>
          <input v-model="promptModal.value" :placeholder="promptModal.placeholder" autofocus @keydown.enter="submitPrompt" @keydown.esc="promptModal.open = false" class="prompt-input" />
          <div class="prompt-actions">
            <button class="btn-ghost" @click="promptModal.open = false">取消</button>
            <button class="primary-btn" @click="submitPrompt">确定</button>
          </div>
        </div>
      </div>
    </Teleport>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--sidebar-border);
  color: var(--sidebar-text);
  overflow: hidden;
  user-select: none;
}

.sidebar-top-bar {
  height: 38px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px;
  border-bottom: 1px solid var(--sidebar-border);
}

.toolbar-left,
.toolbar-right {
  display: flex;
  align-items: center;
  gap: 2px;
}
.sidebar-top-spacer {
  flex: 1;
  height: 100%;
  min-width: 8px;
}

.unified-search-area {
  padding: 8px 8px 6px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.filter-box {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-surface);
  border: 1px solid var(--sidebar-border);
  border-radius: var(--radius-sm);
  padding: 0 8px;
  height: 30px;
}
.filter-box:focus-within {
  border-color: var(--accent);
}
.filter-icon {
  color: var(--text-muted);
  flex-shrink: 0;
}
.filter-input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 12.5px;
  color: var(--text-primary);
  min-width: 0;
}

.search-options {
  display: flex;
  align-items: center;
  gap: 4px;
}
.opt-chip {
  height: 22px;
  padding: 0 6px;
  border: 1px solid var(--sidebar-border);
  background: transparent;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  color: var(--sidebar-text-muted);
}
.opt-chip.active {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}
.scope-select {
  flex: 1;
  height: 22px;
  font-size: 11px;
  background: var(--bg-surface);
  color: var(--text-primary);
  border: 1px solid var(--sidebar-border);
  border-radius: 4px;
  padding: 0 4px;
  min-width: 0;
}

.icon-btn,
.icon-btn-xs {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--sidebar-text-muted);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.icon-btn {
  width: 28px;
  height: 26px;
}
.icon-btn.active {
  background: var(--sidebar-active);
  color: var(--accent);
}
.icon-btn-xs {
  width: 22px;
  height: 22px;
}
.icon-btn:hover,
.icon-btn-xs:hover {
  background: var(--sidebar-hover);
  color: var(--sidebar-text);
}

.spin {
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.tree-scroll {
  flex: 1;
  overflow-y: auto;
  padding-bottom: 12px;
}

.section-caption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--sidebar-text-muted);
  letter-spacing: 0.02em;
}
.link-mini {
  border: none;
  background: transparent;
  color: var(--accent);
  font-size: 11.5px;
  cursor: pointer;
  padding: 0;
}

.workspace-section {
  margin-bottom: 4px;
}
.workspace-header {
  display: flex;
  align-items: center;
  gap: 5px;
  min-height: 32px;
  padding: 4px 6px 4px 8px;
  margin: 0 4px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--sidebar-text-muted);
  cursor: pointer;
  position: relative;
  transition: background 0.12s, color 0.12s, opacity 0.12s;
}
.workspace-header:hover {
  background: var(--sidebar-hover);
  color: var(--sidebar-text);
}
.workspace-header.is-active-ws {
  background: var(--accent-soft);
  color: var(--accent);
}
.workspace-header.ws-dragging {
  opacity: 0.45;
}
.workspace-header.ws-drop-before::before {
  content: "";
  position: absolute;
  left: 4px;
  right: 4px;
  top: -2px;
  height: 2px;
  border-radius: 2px;
  background: var(--accent);
}
.workspace-header.ws-drop-after::after {
  content: "";
  position: absolute;
  left: 4px;
  right: 4px;
  bottom: -2px;
  height: 2px;
  border-radius: 2px;
  background: var(--accent);
}
.ws-chevron {
  flex-shrink: 0;
}
.ws-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ws-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0.6;
  transition: opacity 0.12s;
}
.workspace-header:hover .ws-actions,
.workspace-header.is-active-ws .ws-actions {
  opacity: 1;
}
.ws-move-btn {
  display: none;
}
.workspace-header:hover .ws-move-btn {
  display: inline-flex;
}
.ws-action-btn {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  background: transparent;
  color: var(--sidebar-text-muted);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.workspace-header.is-active-ws .ws-action-btn {
  color: var(--accent);
}
.ws-action-btn:hover {
  background: var(--bg-surface);
  border-color: var(--sidebar-border);
  color: var(--accent);
}
.ws-action-btn.danger:hover {
  background: color-mix(in srgb, var(--danger) 14%, transparent);
  border-color: color-mix(in srgb, var(--danger) 35%, transparent);
  color: var(--danger);
}

.empty-ws {
  padding: 28px 16px;
  text-align: center;
  color: var(--sidebar-text-muted);
  font-size: 13px;
}

.content-matches-section {
  margin-top: 8px;
  padding: 4px 6px 8px;
  border-top: 1px solid var(--sidebar-border);
}
.no-matches {
  padding: 8px 10px;
  font-size: 12px;
  color: var(--sidebar-text-muted);
}
.search-file-group {
  margin-bottom: 8px;
}
.search-file-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  font-weight: 600;
  padding: 3px 6px;
  color: var(--sidebar-text);
}
.badge {
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--sidebar-hover);
  color: var(--sidebar-text-muted);
}
.search-match-row {
  display: flex;
  gap: 7px;
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 12px;
}
.search-match-row:hover {
  background: var(--sidebar-hover);
}
.match-line-no {
  color: var(--sidebar-text-muted);
  min-width: 22px;
  text-align: right;
  font-family: var(--font-editor);
}
.match-snippet {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.recent-view {
  padding: 4px 6px;
}
.recent-row {
  padding: 7px 9px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  margin-bottom: 2px;
}
.recent-row:hover {
  background: var(--sidebar-hover);
}
.recent-name {
  font-size: 13px;
  font-weight: 500;
}
.recent-path {
  font-size: 11px;
  color: var(--sidebar-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Bottom-left Obsidian-like footer */
.sidebar-footer {
  height: 40px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  border-top: 1px solid var(--sidebar-border);
}

.footer-icon-btn {
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--sidebar-text-muted);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.footer-icon-btn:hover {
  background: var(--sidebar-hover);
  color: var(--sidebar-text);
}

.add-ws-btn {
  flex: 1;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 1px dashed var(--sidebar-border);
  background: transparent;
  color: var(--sidebar-text-muted);
  border-radius: var(--radius-sm);
  font-size: 12px;
  cursor: pointer;
}
.add-ws-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}

/* Context Menu & Prompt */
.ctx-backdrop { position: fixed; inset: 0; z-index: 3000; }
.ctx-menu { position: fixed; width: 196px; background: var(--bg-elevated); border: 1px solid var(--border-color); border-radius: var(--radius-md); box-shadow: var(--shadow-md); padding: 5px; display: flex; flex-direction: column; gap: 2px; }
.ctx-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 10px; border: none; background: transparent; color: var(--text-primary); font-size: 13px; border-radius: var(--radius-sm); cursor: pointer; text-align: left; }
.ctx-item:hover { background: var(--bg-hover); }
.ctx-item.danger { color: var(--danger); }
.ctx-sep { height: 1px; background: var(--border-color); margin: 4px 2px; }
.modal-backdrop { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.35); display: flex; align-items: center; justify-content: center; z-index: 3100; }
.prompt-dialog { width: 380px; background: var(--bg-elevated); border: 1px solid var(--border-color); border-radius: var(--radius-lg); box-shadow: var(--shadow-md); padding: 18px 20px; }
.prompt-dialog h3 { margin: 0 0 12px; font-size: 15px; }
.prompt-input { width: 100%; height: 36px; padding: 0 12px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-surface); color: var(--text-primary); font-size: 13.5px; outline: none; }
.prompt-input:focus { border-color: var(--accent); }
.prompt-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.primary-btn { display: inline-flex; align-items: center; gap: 5px; padding: 6px 14px; border: none; border-radius: var(--radius-pill); background: var(--accent); color: #ffffff; font-size: 13px; font-weight: 500; cursor: pointer; }
.btn-ghost { padding: 6px 14px; border: 1px solid var(--border-color); border-radius: var(--radius-pill); background: transparent; color: var(--text-secondary); font-size: 13px; cursor: pointer; }
</style>
