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
  Check,
  ArrowDownAZ,
  ArrowDownZA,
  ClockArrowDown,
  ClockArrowUp,
  GripVertical,
} from "lucide-vue-next";
import FileTreeNode from "./FileTreeNode.vue";
import { ipc, parseIpcError, type FileNode, type LineEnding, type SearchMatch } from "@/core/ipc/client";
import { rewriteLinksInMarkdown } from "@/core/markdown/wikilinks";
import {
  getDefaultWorkspaceName,
  sortOrderLabel,
  useWorkspaceStore,
  type SortOrder,
  type WorkspaceEntry,
} from "@/stores/workspace";
import { useTabsStore } from "@/stores/tabs";
import { useSettingsStore } from "@/stores/settings";
import { useI18n } from "@/core/i18n";

const { t } = useI18n();

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
  mode: "newNote" | "newFolder" | "rename" | "renameWorkspace";
  title: string;
  hint: string;
  placeholder: string;
  value: string;
  targetPath: string;
  workspaceId: string;
  isFolder: boolean;
}>({
  open: false,
  mode: "newNote",
  title: "",
  hint: "",
  placeholder: "",
  value: "",
  targetPath: "",
  workspaceId: "",
  isFolder: false,
});

interface PendingLinkUpdateEntry {
  notePath: string;
  noteName: string;
  count: number;
  updatedContent: string;
  encoding: string;
  hasBom: boolean;
  lineEnding: LineEnding;
  hash: string;
  openTabId: string | null;
}

const linkUpdateModal = reactive<{
  open: boolean;
  oldName: string;
  newName: string;
  workspaceId: string;
  totalCount: number;
  applying: boolean;
  entries: PendingLinkUpdateEntry[];
}>({
  open: false,
  oldName: "",
  newName: "",
  workspaceId: "",
  totalCount: 0,
  applying: false,
  entries: [],
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

let searchReqSeq = 0;

function scheduleFullTextSearch() {
  if (searchDebounce) clearTimeout(searchDebounce);
  const q = wsStore.filterQuery.trim();
  if (!q) {
    searchReqSeq++;
    void ipc.cancelSearch().catch(() => {});
    searchResults.value = [];
    searchMeta.value = { scannedFiles: 0, truncated: false };
    searching.value = false;
    return;
  }
  searchDebounce = setTimeout(() => {
    void runFullTextSearch();
  }, 150);
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

  const seq = ++searchReqSeq;
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
    if (seq === searchReqSeq && !res.cancelled) {
      searchResults.value = res.matches;
      searchMeta.value = { scannedFiles: res.scannedFiles, truncated: res.truncated };
    }
  } catch (err) {
    if (seq === searchReqSeq) {
      tabsStore.showToast(t("sidebar.searchFailed", { msg: parseIpcError(err).message }));
    }
  } finally {
    if (seq === searchReqSeq) {
      searching.value = false;
    }
  }
}

function clearSearch() {
  wsStore.filterQuery = "";
}

function cycleSortOrder() {
  const orders: SortOrder[] = ["name-asc", "name-desc", "mtime-desc", "mtime-asc"];
  const idx = orders.indexOf(wsStore.sortOrder);
  wsStore.sortOrder = orders[(idx + 1) % orders.length];
}

const sortLabel = computed(() => sortOrderLabel(wsStore.sortOrder));

const SORT_MENU_OPTIONS = computed<Array<{ value: SortOrder; label: string }>>(() => [
  { value: "name-asc", label: t("sort.nameAsc") },
  { value: "name-desc", label: t("sort.nameDesc") },
  { value: "mtime-desc", label: t("sort.mtimeDesc") },
  { value: "mtime-asc", label: t("sort.mtimeAsc") },
  { value: "manual", label: t("sort.manualHint") },
]);

const ctxIsWorkspaceRoot = computed(
  () =>
    Boolean(ctxMenu.workspace) &&
    (!ctxMenu.node ||
      wsStore.normalizeKey(ctxMenu.node.path) === wsStore.normalizeKey(ctxMenu.workspace!.rootPath))
);

const ctxIsFolder = computed(
  () => ctxIsWorkspaceRoot.value || ctxMenu.node?.kind === "folder"
);

const ctxExplicitSort = computed<SortOrder | null>(() => {
  if (!ctxIsFolder.value) return null;
  if (ctxIsWorkspaceRoot.value && ctxMenu.workspace) {
    const rawWs = wsStore.workspaces.find((w) => w.id === ctxMenu.workspace!.id);
    return rawWs?.sortOrder ?? null;
  }
  if (ctxMenu.node) {
    return wsStore.getFolderExplicitSort(ctxMenu.node.path) ?? null;
  }
  return null;
});

function handleSetContextSort(order: SortOrder | null) {
  if (ctxIsWorkspaceRoot.value && ctxMenu.workspace) {
    wsStore.setWorkspaceSortOrder(ctxMenu.workspace.id, order);
    tabsStore.showToast(
      order
        ? t("sort.wsSortChanged", { name: ctxMenu.workspace.name, label: sortOrderLabel(order) })
        : t("sort.wsSortReset", { name: ctxMenu.workspace.name })
    );
  } else if (ctxMenu.node && ctxMenu.node.kind === "folder") {
    wsStore.setFolderSortOrder(ctxMenu.node.path, order, ctxMenu.node.workspaceId);
    tabsStore.showToast(
      order
        ? t("sort.folderSortChanged", { name: ctxMenu.node.name, label: sortOrderLabel(order) })
        : t("sort.folderSortReset", { name: ctxMenu.node.name })
    );
  }
  closeContextMenu();
}

function handleNudgeContextNode(delta: -1 | 1) {
  const node = ctxMenu.node;
  closeContextMenu();
  if (!node) return;
  const moved = wsStore.nudgeNodeInParent(node.path, delta);
  if (!moved) {
    tabsStore.showToast(delta < 0 ? t("sidebar.alreadyAtTop") : t("sidebar.alreadyAtBottom"));
  }
}

function handleReorderSibling(payload: {
  srcPath: string;
  targetPath: string;
  position: "before" | "after";
}) {
  wsStore.reorderSiblingNode(payload.srcPath, payload.targetPath, payload.position);
}

function handleOpenFile(node: FileNode) {
  void tabsStore.openFile(node.path, { workspaceId: node.workspaceId });
}

function openNodeContextMenu(payload: { event: MouseEvent; node: FileNode }) {
  const estHeight = payload.node.kind === "folder" ? 470 : 320;
  ctxMenu.visible = true;
  ctxMenu.x = Math.min(payload.event.clientX, window.innerWidth - 225);
  ctxMenu.y = Math.max(8, Math.min(payload.event.clientY, window.innerHeight - estHeight));
  ctxMenu.node = payload.node;
  ctxMenu.workspace = wsStore.workspaces.find((w) => w.id === payload.node.workspaceId) ?? null;
}

function openWorkspaceContextMenu(event: MouseEvent, ws: WorkspaceEntry) {
  event.preventDefault();
  ctxMenu.visible = true;
  ctxMenu.x = Math.min(event.clientX, window.innerWidth - 245);
  ctxMenu.y = Math.max(8, Math.min(event.clientY, window.innerHeight - 480));
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

function workspaceHeaderTooltip(ws: WorkspaceEntry): string {
  const defaultName = getDefaultWorkspaceName(ws.rootPath);
  const aliasLine = ws.name !== defaultName ? `${t("sidebar.wsAliasPrefix", { name: ws.name })}\n` : "";
  return `${aliasLine}${t("sidebar.wsActualPathPrefix", { path: ws.rootPath })}\n${t("sidebar.wsHeaderHint")}`;
}

function triggerRenameWorkspaceAlias() {
  const ws = ctxMenu.workspace;
  closeContextMenu();
  if (!ws) return;
  const defaultName = getDefaultWorkspaceName(ws.rootPath);
  promptModal.open = true;
  promptModal.mode = "renameWorkspace";
  promptModal.title = t("sidebar.promptAliasTitle");
  promptModal.hint = t("sidebar.promptAliasHint", { path: ws.rootPath, defaultName });
  promptModal.placeholder = defaultName;
  promptModal.value = ws.name;
  promptModal.targetPath = ws.rootPath;
  promptModal.workspaceId = ws.id;
  promptModal.isFolder = true;
}

async function handleCopyWorkspacePath() {
  const ws = ctxMenu.workspace;
  closeContextMenu();
  if (!ws) return;
  try {
    await navigator.clipboard.writeText(ws.rootPath);
    tabsStore.showToast(t("sidebar.copiedWsPath", { path: ws.rootPath }));
  } catch {
    tabsStore.showToast(t("sidebar.copyPathFailed"));
  }
}

function triggerNewNote(explicitDir?: string, explicitWsId?: string) {
  closeContextMenu();
  const target = explicitDir
    ? { dir: explicitDir, workspaceId: explicitWsId ?? "" }
    : resolveTargetDir();
  if (!target) {
    tabsStore.showToast(t("sidebar.needWorkspaceFirst"));
    return;
  }
  promptModal.open = true;
  promptModal.mode = "newNote";
  promptModal.title = t("sidebar.promptNewNoteTitle");
  promptModal.hint = "";
  promptModal.placeholder = t("sidebar.promptNewNotePlaceholder");
  promptModal.value = "";
  promptModal.targetPath = target.dir;
  promptModal.workspaceId = target.workspaceId;
  promptModal.isFolder = false;
}

function triggerNewFolder(explicitDir?: string, explicitWsId?: string) {
  closeContextMenu();
  const target = explicitDir
    ? { dir: explicitDir, workspaceId: explicitWsId ?? "" }
    : resolveTargetDir();
  if (!target) {
    tabsStore.showToast(t("sidebar.needWorkspaceFirst"));
    return;
  }
  promptModal.open = true;
  promptModal.mode = "newFolder";
  promptModal.title = t("sidebar.promptNewFolderTitle");
  promptModal.hint = "";
  promptModal.placeholder = t("sidebar.promptNewFolderPlaceholder");
  promptModal.value = "";
  promptModal.targetPath = target.dir;
  promptModal.workspaceId = target.workspaceId;
  promptModal.isFolder = true;
}

function triggerRename() {
  const node = ctxMenu.node;
  closeContextMenu();
  if (!node) return;
  promptModal.open = true;
  promptModal.mode = "rename";
  promptModal.title = t("sidebar.promptRenameTitle");
  promptModal.hint = "";
  promptModal.placeholder = t("sidebar.promptRenamePlaceholder");
  promptModal.value = node.name;
  promptModal.targetPath = node.path;
  promptModal.workspaceId = node.workspaceId;
  promptModal.isFolder = node.kind === "folder";
}

async function checkReferencesAfterRename(oldPath: string, newPath: string, workspaceId: string) {
  const ws = wsStore.workspaces.find((w) => w.id === workspaceId) ?? wsStore.findWorkspaceForPath(newPath);
  if (!ws) return;

  const oldName = oldPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  const newName = newPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  if (!oldName || !newName || oldName.toLowerCase() === newName.toLowerCase()) return;

  const oldStem = oldName.replace(/\.(md|markdown)$/i, "");
  if (!oldStem) return;

  const candidatePaths = new Map<string, string>();
  try {
    const res = await ipc.searchFilesContent({
      roots: [{ workspaceId: ws.id, rootPath: ws.rootPath }],
      query: oldStem,
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
      maxResults: 600,
    });
    for (const m of res.matches) {
      if (/\.(md|markdown)$/i.test(m.path)) {
        candidatePaths.set(wsStore.normalizeKey(m.path), m.path);
      }
    }
  } catch {
    // Fallback to checking open tabs only if search fails
  }

  for (const tab of tabsStore.allOpenTabs) {
    if (tab.kind === "markdown" && wsStore.findWorkspaceForPath(tab.path)?.id === ws.id) {
      candidatePaths.set(wsStore.normalizeKey(tab.path), tab.path);
    }
  }

  const entries: PendingLinkUpdateEntry[] = [];
  let totalCount = 0;

  for (const [normKey, notePath] of candidatePaths.entries()) {
    const openTab = tabsStore.allOpenTabs.find(
      (t) => t.kind === "markdown" && wsStore.normalizeKey(t.path) === normKey
    );
    try {
      let content: string;
      let encoding = "UTF-8";
      let hasBom = false;
      let lineEnding: LineEnding = "LF";
      let hash = "";

      if (openTab) {
        content = openTab.content;
        encoding = openTab.encoding;
        hasBom = openTab.hasBom;
        lineEnding = openTab.lineEnding;
        hash = openTab.hash;
      } else {
        const doc = await ipc.readFile(notePath);
        content = doc.content;
        encoding = doc.encoding;
        hasBom = doc.hasBom;
        lineEnding = doc.lineEnding;
        hash = doc.hash;
      }

      const rewritten = rewriteLinksInMarkdown(content, { notePath, oldPath, newPath });
      if (rewritten.count > 0) {
        totalCount += rewritten.count;
        entries.push({
          notePath,
          noteName: notePath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? notePath,
          count: rewritten.count,
          updatedContent: rewritten.updated,
          encoding,
          hasBom,
          lineEnding,
          hash,
          openTabId: openTab?.id ?? null,
        });
      }
    } catch {
      // Skip unreadable files
    }
  }

  if (entries.length > 0) {
    linkUpdateModal.oldName = oldName;
    linkUpdateModal.newName = newName;
    linkUpdateModal.workspaceId = ws.id;
    linkUpdateModal.totalCount = totalCount;
    linkUpdateModal.entries = entries;
    linkUpdateModal.applying = false;
    linkUpdateModal.open = true;
  }
}

async function confirmLinkUpdates() {
  if (linkUpdateModal.applying) return;
  linkUpdateModal.applying = true;
  let updatedFiles = 0;
  let updatedLinks = 0;

  try {
    for (const entry of linkUpdateModal.entries) {
      const openTab = entry.openTabId
        ? tabsStore.allOpenTabs.find((t) => t.id === entry.openTabId)
        : tabsStore.allOpenTabs.find(
            (t) => wsStore.normalizeKey(t.path) === wsStore.normalizeKey(entry.notePath)
          );
      if (openTab) {
        tabsStore.updateTabContent(openTab.id, entry.updatedContent);
        await tabsStore.saveTab(openTab.id, false, false);
        updatedFiles++;
        updatedLinks += entry.count;
      } else {
        await ipc.saveFile({
          path: entry.notePath,
          content: entry.updatedContent,
          encoding: entry.encoding,
          hasBom: entry.hasBom,
          lineEnding: entry.lineEnding,
          expectedHash: entry.hash,
          force: false,
        });
        updatedFiles++;
        updatedLinks += entry.count;
      }
    }
    if (linkUpdateModal.workspaceId) {
      await wsStore.refreshWorkspace(linkUpdateModal.workspaceId);
    }
    linkUpdateModal.open = false;
    tabsStore.showToast(t("sidebar.linkUpdateSuccess", { files: updatedFiles, links: updatedLinks }));
  } catch (err) {
    tabsStore.showToast(t("sidebar.linkUpdatePartialFail", { msg: parseIpcError(err).message }), 3500);
  } finally {
    linkUpdateModal.applying = false;
  }
}

async function submitPrompt() {
  const val = promptModal.value.trim();
  const { mode, targetPath, workspaceId, isFolder } = promptModal;
  if (mode === "renameWorkspace") {
    promptModal.open = false;
    wsStore.renameWorkspaceAlias(workspaceId, val);
    tabsStore.showToast(val ? t("sidebar.aliasSaved", { name: val }) : t("sidebar.aliasReset"));
    return;
  }
  if (!val) return;
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
      wsStore.handlePathRenamed(targetPath, newPath);
      tabsStore.handlePathRenamed(targetPath, newPath);
      if (workspaceId) await wsStore.refreshWorkspace(workspaceId);
      tabsStore.showToast(t("sidebar.renameSuccess"));
      if (!isFolder) {
        void checkReferencesAfterRename(targetPath, newPath, workspaceId);
      }
    }
  } catch (err) {
    tabsStore.showToast(t("common.opFailed", { msg: parseIpcError(err).message }), 3500);
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
    tabsStore.showToast(t("sidebar.duplicated"));
  } catch (err) {
    tabsStore.showToast(t("sidebar.duplicateFailed", { msg: parseIpcError(err).message }));
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
    tabsStore.showToast(t("sidebar.movedToTrash", { name: node.name }));
  } catch (err) {
    tabsStore.showToast(t("sidebar.deleteFailed", { msg: parseIpcError(err).message }));
  }
}

async function handleRevealInExplorer() {
  const targetPath = ctxMenu.node?.path ?? ctxMenu.workspace?.rootPath;
  closeContextMenu();
  if (!targetPath) return;
  try {
    await ipc.revealInFileManager(targetPath);
  } catch (err) {
    tabsStore.showToast(t("sidebar.openFailed", { msg: parseIpcError(err).message }));
  }
}

async function handleCompareWithActive() {
  const node = ctxMenu.node;
  closeContextMenu();
  if (!node || node.kind !== "markdown") return;
  const active = tabsStore.activeTab;
  if (!active || active.kind !== "markdown") {
    tabsStore.showToast(t("sidebar.needMarkdownForDiff"));
    return;
  }
  await tabsStore.openFilesDiff(active.path, node.path);
}

async function handleDropMove(payload: { srcPath: string; destDir: string }) {
  try {
    const newPath = await ipc.movePath(payload.srcPath, payload.destDir);
    wsStore.handlePathRenamed(payload.srcPath, newPath);
    tabsStore.handlePathRenamed(payload.srcPath, newPath);
    await wsStore.refreshWorkspacesForPaths([payload.srcPath, payload.destDir]);
    tabsStore.showToast(t("sidebar.movedFile"));
  } catch (err) {
    tabsStore.showToast(t("sidebar.moveFailed", { msg: parseIpcError(err).message }), 3500);
  }
}
</script>

<template>
  <aside class="sidebar" @click="closeContextMenu">
    <!-- Obsidian-style compact top toolbar aligned with TabBar height (38px) -->
    <div class="sidebar-top-bar">
      <div class="toolbar-left">
        <button class="icon-btn" @click="triggerNewNote()" :data-tip="t('sidebar.newNoteTip')">
          <FilePlus :size="15" />
        </button>
        <button class="icon-btn" @click="triggerNewFolder()" :data-tip="t('sidebar.newFolderTip')">
          <FolderPlus :size="15" />
        </button>
        <button class="icon-btn" @click="cycleSortOrder" :data-tip="t('sort.globalTip', { label: sortLabel })">
          <ArrowDownAZ v-if="wsStore.sortOrder === 'name-asc'" :size="15" />
          <ArrowDownZA v-else-if="wsStore.sortOrder === 'name-desc'" :size="15" />
          <ClockArrowDown v-else-if="wsStore.sortOrder === 'mtime-desc'" :size="15" />
          <ClockArrowUp v-else-if="wsStore.sortOrder === 'mtime-asc'" :size="15" />
          <ArrowUpDown v-else :size="15" />
        </button>
        <button
          class="icon-btn"
          @click="handleToggleCollapseAllTrees"
          :data-tip="wsStore.hasAnyExpandedTree ? t('sidebar.collapseAllTip') : t('sidebar.expandAllTip')"
        >
          <ChevronsDownUp v-if="wsStore.hasAnyExpandedTree" :size="15" />
          <ChevronsUpDown v-else :size="15" />
        </button>
        <button
          class="icon-btn"
          :class="{ active: showRecentView }"
          @click="showRecentView = !showRecentView"
          :data-tip="t('sidebar.recentTip')"
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
          :data-tip="settings.state.sidebarAutoHide ? t('sidebar.autoHideOnTip') : t('sidebar.autoHideOffTip')"
        >
          <PinOff v-if="settings.state.sidebarAutoHide" :size="14" />
          <Pin v-else :size="14" />
        </button>
        <button class="icon-btn" @click="emit('collapse-sidebar')" :data-tip="t('sidebar.collapseSidebarTip')">
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
          :placeholder="t('sidebar.searchPlaceholder')"
          class="filter-input"
          @keydown.enter="runFullTextSearch"
          @keydown.esc="clearSearch"
        />
        <button v-if="hasQuery" class="icon-btn-xs" @click="clearSearch" :title="t('sidebar.clear')">
          <X :size="12" />
        </button>
      </div>

      <!-- Inline search options appear automatically when typing -->
      <div v-if="hasQuery" class="search-options">
        <button
          class="opt-chip"
          :class="{ active: searchCaseSensitive }"
          @click="searchCaseSensitive = !searchCaseSensitive; runFullTextSearch()"
          :data-tip="t('sidebar.caseSensitive')"
        >
          Aa
        </button>
        <button
          class="opt-chip"
          :class="{ active: searchWholeWord }"
          @click="searchWholeWord = !searchWholeWord; runFullTextSearch()"
          :data-tip="t('sidebar.wholeWord')"
        >
          \b
        </button>
        <button
          class="opt-chip"
          :class="{ active: searchUseRegex }"
          @click="searchUseRegex = !searchUseRegex; runFullTextSearch()"
          :data-tip="t('sidebar.regex')"
        >
          .*
        </button>
        <select v-model="searchScope" @change="runFullTextSearch" class="scope-select" :data-tip="t('sidebar.searchScopeTip')">
          <option value="all">{{ t("sidebar.allWorkspaces") }}</option>
          <option v-for="ws in wsStore.workspaces" :key="ws.id" :value="ws.id">
            {{ ws.name }}
          </option>
        </select>
      </div>
    </div>

    <!-- RECENT FILES VIEW (optional toggle via clock icon) -->
    <div v-if="showRecentView" class="tree-scroll recent-view">
      <div class="section-caption">
        <span>{{ t("sidebar.recentTitle") }}</span>
        <button class="link-mini" @click="showRecentView = false">{{ t("sidebar.backToTree") }}</button>
      </div>
      <div v-if="tabsStore.recentFiles.length === 0" class="empty-ws">
        <p>{{ t("sidebar.noRecent") }}</p>
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
        <p>{{ t("sidebar.emptyWorkspaces") }}</p>
        <button class="primary-btn" @click="wsStore.pickAndAddWorkspace()">
          <Plus :size="15" /><span>{{ t("sidebar.openFolderBtn") }}</span>
        </button>
      </div>

      <template v-else>
        <!-- Filtered File Tree Section -->
        <div v-if="hasQuery" class="section-caption">
          <span>{{ t("sidebar.matchedFiles", { count: matchedFileCount }) }}</span>
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
              :data-tip="workspaceHeaderTooltip(ws)"
            >
              <ChevronDown v-if="!ws.collapsed" :size="14" class="ws-chevron" />
              <ChevronRight v-else :size="14" class="ws-chevron" />
              <span class="ws-name">{{ ws.name }}</span>
              <span
                v-if="ws.sortOrder"
                class="ws-sort-icon"
                @click.stop="openWorkspaceContextMenu($event, ws)"
                :data-tip="t('sort.wsSortTip', { label: sortOrderLabel(ws.sortOrder) })"
              >
                <ArrowDownAZ v-if="ws.sortOrder === 'name-asc'" :size="13" />
                <ArrowDownZA v-else-if="ws.sortOrder === 'name-desc'" :size="13" />
                <ClockArrowDown v-else-if="ws.sortOrder === 'mtime-desc'" :size="13" />
                <ClockArrowUp v-else-if="ws.sortOrder === 'mtime-asc'" :size="13" />
                <GripVertical v-else :size="13" />
              </span>
              <div class="ws-actions" @click.stop>
                <button
                  v-if="wsStore.workspaces.length > 1 && wsIdx > 0"
                  class="ws-action-btn ws-move-btn"
                  @click="wsStore.moveWorkspace(wsIdx, wsIdx - 1)"
                  :data-tip="t('sidebar.moveWsUp')"
                >
                  <ArrowUp :size="13" />
                </button>
                <button
                  v-if="wsStore.workspaces.length > 1 && wsIdx < wsStore.workspaces.length - 1"
                  class="ws-action-btn ws-move-btn"
                  @click="wsStore.moveWorkspace(wsIdx, wsIdx + 1)"
                  :data-tip="t('sidebar.moveWsDown')"
                >
                  <ArrowDown :size="13" />
                </button>
                <button
                  class="ws-action-btn"
                  @click="tabsStore.openTerminalForWorkspace(ws.id, ws.name, ws.rootPath)"
                  :data-tip="t('sidebar.openTerminalTip')"
                >
                  <Terminal :size="14" :stroke-width="2" />
                </button>
                <button
                  class="ws-action-btn"
                  @click="triggerNewNote(ws.rootPath, ws.id)"
                  :data-tip="t('sidebar.newNoteInWsTip')"
                >
                  <FilePlus :size="14" :stroke-width="2" />
                </button>
                <button
                  class="ws-action-btn danger"
                  @click="wsStore.removeWorkspace(ws.id)"
                  :data-tip="t('sidebar.removeWsTip')"
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
                @reorder-sibling="handleReorderSibling"
              />
            </div>
          </template>
        </div>

        <!-- Inline Full-Text Search Matches (shown automatically when query is non-empty) -->
        <div v-if="hasQuery" class="content-matches-section">
          <div class="section-caption">
            <span v-if="searching">{{ t("sidebar.searchingText") }}</span>
            <span v-else>
              {{ t("sidebar.fullTextMatches", { count: searchResults.length, plus: searchMeta.truncated ? "+" : "" }) }}
            </span>
          </div>

          <div v-if="!searching && groupedSearchResults.length === 0" class="no-matches">
            {{ t("sidebar.noContentMatches") }}
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
      <button class="footer-icon-btn" @click="emit('open-settings')" :data-tip="t('sidebar.settingsTip')">
        <Settings :size="16" />
      </button>
      <button class="add-ws-btn" @click="wsStore.pickAndAddWorkspace()" :data-tip="t('sidebar.addWorkspaceTip')">
        <Plus :size="14" /><span>{{ t("sidebar.addWorkspaceBtn") }}</span>
      </button>
    </div>

    <!-- Context Menu & Prompt Dialog -->
    <Teleport to="body">
      <div v-if="ctxMenu.visible" class="ctx-backdrop" @click="closeContextMenu" @contextmenu.prevent="closeContextMenu">
        <div class="ctx-menu" :style="{ left: `${ctxMenu.x}px`, top: `${ctxMenu.y}px` }" @click.stop>
          <div
            v-if="ctxIsWorkspaceRoot && ctxMenu.workspace"
            class="ctx-path-box"
            @click="handleCopyWorkspacePath"
            :data-tip="t('sidebar.ctxActualPathTip')"
          >
            <div class="ctx-path-val">{{ ctxMenu.workspace.rootPath }}</div>
          </div>
          <button class="ctx-item" @click="triggerNewNote()"><FilePlus :size="14" /> {{ t("sidebar.ctxNewNote") }}</button>
          <button class="ctx-item" @click="triggerNewFolder()"><FolderPlus :size="14" /> {{ t("sidebar.ctxNewFolder") }}</button>
          <template v-if="ctxIsWorkspaceRoot && ctxMenu.workspace">
            <button class="ctx-item" @click="triggerRenameWorkspaceAlias()">
              <Edit3 :size="14" /> {{ t("sidebar.ctxSetAlias") }}
            </button>
            <button class="ctx-item" @click="handleCopyWorkspacePath()">
              <Copy :size="14" /> {{ t("sidebar.ctxCopyPath") }}
            </button>
            <button
              class="ctx-item"
              @click="tabsStore.openTerminalForWorkspace(ctxMenu.workspace.id, ctxMenu.workspace.name, ctxMenu.workspace.rootPath); closeContextMenu()"
            >
              <Terminal :size="14" /> {{ t("sidebar.ctxOpenTerminal") }}
            </button>
            <button
              class="ctx-item"
              @click="wsStore.refreshWorkspace(ctxMenu.workspace.id); closeContextMenu()"
            >
              <RefreshCw :size="14" /> {{ t("sidebar.ctxRefreshWs") }}
            </button>
          </template>
          <div class="ctx-sep" />
          <template v-if="ctxIsFolder">
            <div class="ctx-section-label">
              <ArrowUpDown :size="12" />
              <span>{{ ctxIsWorkspaceRoot ? t("sort.wsSortTitle") : t("sort.folderSortTitle") }}</span>
            </div>
            <button
              class="ctx-item ctx-sort-item"
              :class="{ 'is-checked': ctxExplicitSort === null }"
              @click="handleSetContextSort(null)"
            >
              <span class="ctx-check"><Check v-if="ctxExplicitSort === null" :size="13" /></span>
              <span>{{ ctxIsWorkspaceRoot ? t("sort.followGlobal") : t("sort.followParent") }}</span>
            </button>
            <button
              v-for="opt in SORT_MENU_OPTIONS"
              :key="opt.value"
              class="ctx-item ctx-sort-item"
              :class="{ 'is-checked': ctxExplicitSort === opt.value }"
              @click="handleSetContextSort(opt.value)"
            >
              <span class="ctx-check"><Check v-if="ctxExplicitSort === opt.value" :size="13" /></span>
              <span>{{ opt.label }}</span>
            </button>
            <div class="ctx-sep" />
          </template>
          <template v-if="ctxMenu.node && !ctxIsWorkspaceRoot">
            <button class="ctx-item" @click="handleNudgeContextNode(-1)"><ArrowUp :size="14" /> {{ t("sidebar.ctxMoveUp") }}</button>
            <button class="ctx-item" @click="handleNudgeContextNode(1)"><ArrowDown :size="14" /> {{ t("sidebar.ctxMoveDown") }}</button>
            <div class="ctx-sep" />
            <button class="ctx-item" @click="triggerRename()"><Edit3 :size="14" /> {{ t("sidebar.ctxRename") }}</button>
            <button class="ctx-item" @click="handleCopyNode()"><Copy :size="14" /> {{ t("sidebar.ctxDuplicate") }}</button>
            <button v-if="ctxMenu.node.kind === 'markdown'" class="ctx-item" @click="handleCompareWithActive()"><GitCompare :size="14" /> {{ t("sidebar.ctxDiffActive") }}</button>
          </template>
          <button class="ctx-item" @click="handleRevealInExplorer()"><ExternalLink :size="14" /> {{ t("sidebar.ctxRevealExplorer") }}</button>
          <template v-if="ctxMenu.node && !ctxIsWorkspaceRoot">
            <div class="ctx-sep" />
            <button class="ctx-item danger" @click="handleDeleteNode()"><Trash2 :size="14" /> {{ t("sidebar.ctxDeleteTrash") }}</button>
          </template>
        </div>
      </div>

      <div v-if="promptModal.open" class="modal-backdrop" @click="promptModal.open = false">
        <div class="prompt-dialog" @click.stop>
          <h3>{{ promptModal.title }}</h3>
          <p v-if="promptModal.hint" class="prompt-hint">{{ promptModal.hint }}</p>
          <input v-model="promptModal.value" :placeholder="promptModal.placeholder" autofocus @keydown.enter="submitPrompt" @keydown.esc="promptModal.open = false" class="prompt-input" />
          <div class="prompt-actions">
            <button class="btn-ghost" @click="promptModal.open = false">{{ t("common.cancel") }}</button>
            <button class="primary-btn" @click="submitPrompt">{{ t("common.confirm") }}</button>
          </div>
        </div>
      </div>

      <div v-if="linkUpdateModal.open" class="modal-backdrop" @click="!linkUpdateModal.applying && (linkUpdateModal.open = false)">
        <div class="prompt-dialog link-update-dialog" @click.stop>
          <h3>{{ t("sidebar.linkUpdateTitle") }}</h3>
          <p class="link-update-desc">
            {{
              t("sidebar.linkUpdateDesc", {
                files: linkUpdateModal.entries.length,
                links: linkUpdateModal.totalCount,
                oldName: linkUpdateModal.oldName,
                newName: linkUpdateModal.newName,
              })
            }}
          </p>
          <div class="link-update-list">
            <div v-for="item in linkUpdateModal.entries" :key="item.notePath" class="link-update-row" :title="item.notePath">
              <span class="link-update-name">{{ item.noteName }}</span>
              <span class="badge">{{ t("sidebar.linkUpdateCount", { count: item.count }) }}</span>
            </div>
          </div>
          <div class="prompt-actions">
            <button class="btn-ghost" :disabled="linkUpdateModal.applying" @click="linkUpdateModal.open = false">{{ t("sidebar.linkUpdateKeep") }}</button>
            <button class="primary-btn" :disabled="linkUpdateModal.applying" @click="confirmLinkUpdates">
              {{ linkUpdateModal.applying ? t("sidebar.linkUpdateApplying") : t("sidebar.linkUpdateConfirm", { count: linkUpdateModal.totalCount }) }}
            </button>
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
  gap: 5px;
}
.opt-chip {
  height: 27px;
  min-width: 32px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border: 1px solid var(--sidebar-border);
  background: var(--bg-surface);
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  color: var(--sidebar-text-muted);
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.opt-chip:hover {
  background: var(--sidebar-hover);
  color: var(--sidebar-text);
}
.opt-chip.active {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}
.scope-select {
  flex: 1;
  height: 27px;
  font-size: 12.5px;
  background: var(--bg-surface);
  color: var(--text-primary);
  border: 1px solid var(--sidebar-border);
  border-radius: var(--radius-sm);
  padding: 0 7px;
  min-width: 0;
  cursor: pointer;
  outline: none;
  transition: border-color 0.12s;
}
.scope-select:focus {
  border-color: var(--accent);
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
  font-size: 12.5px;
  font-weight: 700;
  letter-spacing: 0.01em;
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
.ws-sort-icon {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  color: var(--accent);
  background: var(--accent-soft);
  opacity: 0.88;
  transition: opacity 0.12s;
}
.ws-sort-icon:hover {
  opacity: 1;
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

/* Bottom-left Obsidian-like footer (aligned with right pane 32px status bar) */
.sidebar-footer {
  height: 32px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  border-top: 1px solid var(--sidebar-border);
}

.footer-icon-btn {
  width: 24px;
  height: 24px;
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
  height: 23px;
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
.ctx-menu { position: fixed; width: 236px; background: var(--bg-elevated); border: 1px solid var(--border-color); border-radius: var(--radius-md); box-shadow: var(--shadow-md); padding: 5px; display: flex; flex-direction: column; gap: 1px; }
.ctx-path-box { padding: 6px 9px; margin-bottom: 3px; border-radius: var(--radius-sm); background: var(--bg-surface); border: 1px solid var(--border-color); cursor: pointer; transition: border-color 0.12s, background 0.12s; }
.ctx-path-box:hover { border-color: var(--accent); background: var(--accent-soft); }
.ctx-path-val { font-size: 11.5px; font-family: var(--font-code); color: var(--text-primary); word-break: break-all; line-height: 1.35; }
.ctx-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 10px; border: none; background: transparent; color: var(--text-primary); font-size: 12.5px; border-radius: var(--radius-sm); cursor: pointer; text-align: left; }
.ctx-item:hover { background: var(--bg-hover); }
.ctx-item.danger { color: var(--danger); }
.ctx-section-label { display: flex; align-items: center; gap: 6px; padding: 4px 10px 3px; font-size: 11px; font-weight: 600; color: var(--text-muted); }
.ctx-sort-item { padding: 5px 10px; font-size: 12px; }
.ctx-sort-item.is-checked { color: var(--accent); font-weight: 600; }
.ctx-check { width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
.ctx-sep { height: 1px; background: var(--border-color); margin: 4px 2px; }
.modal-backdrop { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.35); display: flex; align-items: center; justify-content: center; z-index: 3100; }
.prompt-dialog { width: 380px; background: var(--bg-elevated); border: 1px solid var(--border-color); border-radius: var(--radius-lg); box-shadow: var(--shadow-md); padding: 18px 20px; }
.prompt-dialog h3 { margin: 0 0 10px; font-size: 15px; }
.prompt-hint { margin: 0 0 10px; font-size: 12px; line-height: 1.5; color: var(--text-secondary); white-space: pre-line; word-break: break-all; }
.prompt-input { width: 100%; height: 36px; padding: 0 12px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-surface); color: var(--text-primary); font-size: 13.5px; outline: none; }
.prompt-input:focus { border-color: var(--accent); }
.prompt-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.link-update-dialog { width: 440px; }
.link-update-desc { margin: 0 0 10px; font-size: 13px; line-height: 1.55; color: var(--text-secondary); }
.link-update-desc code { font-family: var(--font-code); font-size: 12px; padding: 1px 5px; border-radius: 4px; background: var(--bg-surface); color: var(--text-primary); }
.link-update-list { max-height: 190px; overflow-y: auto; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-surface); padding: 4px; display: flex; flex-direction: column; gap: 2px; }
.link-update-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 8px; border-radius: 4px; font-size: 12.5px; color: var(--text-primary); }
.link-update-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.primary-btn { display: inline-flex; align-items: center; gap: 5px; padding: 6px 14px; border: none; border-radius: var(--radius-pill); background: var(--accent); color: #ffffff; font-size: 13px; font-weight: 500; cursor: pointer; }
.btn-ghost { padding: 6px 14px; border: 1px solid var(--border-color); border-radius: var(--radius-pill); background: transparent; color: var(--text-secondary); font-size: 13px; cursor: pointer; }
</style>
