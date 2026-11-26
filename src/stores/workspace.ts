import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref } from "vue";
import { ipc, isTauriRuntime, type FileNode } from "@/core/ipc/client";
import { useSettingsStore } from "./settings";

export interface WorkspaceEntry {
  id: string;
  name: string;
  rootPath: string;
  collapsed: boolean;
  tree: FileNode | null;
}

export type SortOrder = "name-asc" | "name-desc" | "mtime-desc";

function flattenNodes(node: FileNode | null, out: FileNode[]) {
  if (!node) return;
  if (node.kind !== "folder") out.push(node);
  if (node.children) {
    for (const child of node.children) flattenNodes(child, out);
  }
}

function sortTreeRecursive(node: FileNode, order: SortOrder): FileNode {
  if (!node.children) return node;
  const children = node.children.map((c) => sortTreeRecursive(c, order));
  children.sort((a, b) => {
    const aDir = a.kind === "folder" ? 1 : 0;
    const bDir = b.kind === "folder" ? 1 : 0;
    if (aDir !== bDir) return bDir - aDir;
    if (order === "mtime-desc") return b.mtimeMs - a.mtimeMs;
    if (order === "name-desc") return b.name.localeCompare(a.name, "zh-CN");
    return a.name.localeCompare(b.name, "zh-CN");
  });
  return { ...node, children };
}

function filterTreeRecursive(node: FileNode, q: string): FileNode | null {
  if (!q) return node;
  const selfMatch = node.name.toLowerCase().includes(q);
  if (node.kind !== "folder") return selfMatch ? node : null;
  const filteredChildren = (node.children ?? [])
    .map((c) => filterTreeRecursive(c, q))
    .filter((c): c is FileNode => c !== null);
  if (selfMatch || filteredChildren.length > 0) return { ...node, children: filteredChildren };
  return null;
}

export const useWorkspaceStore = defineStore("workspace", () => {
  const workspaces = ref<WorkspaceEntry[]>([]);
  const expandedFolders = ref<Set<string>>(new Set());
  const selectedPath = ref<string | null>(null);
  const revealNonce = ref(0);
  const filterQuery = ref("");
  const sortOrder = ref<SortOrder>("name-asc");
  const loading = ref(false);

  const allFiles = computed<FileNode[]>(() => {
    const out: FileNode[] = [];
    for (const ws of workspaces.value) flattenNodes(ws.tree, out);
    return out;
  });

  const displayWorkspaces = computed(() => {
    const q = filterQuery.value.trim().toLowerCase();
    return workspaces.value.map((ws) => {
      if (!ws.tree) return ws;
      const sorted = sortTreeRecursive(ws.tree, sortOrder.value);
      const filtered = q ? filterTreeRecursive(sorted, q) : sorted;
      return { ...ws, tree: filtered };
    });
  });

  function normalizeKey(p: string): string {
    return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }

  function findWorkspaceForPath(filePath: string): WorkspaceEntry | undefined {
    const target = normalizeKey(filePath);
    return workspaces.value.find((ws) => {
      const root = normalizeKey(ws.rootPath);
      return target === root || target.startsWith(`${root}/`);
    });
  }

  function getFilesInWorkspace(workspaceId: string | null): FileNode[] {
    if (!workspaceId) return allFiles.value;
    const ws = workspaces.value.find((w) => w.id === workspaceId);
    if (!ws) return allFiles.value;
    const out: FileNode[] = [];
    flattenNodes(ws.tree, out);
    return out;
  }

  async function syncRegisteredRoots() {
    if (!isTauriRuntime()) return;
    await ipc.registerWorkspaces(workspaces.value.map((w) => w.rootPath));
  }

  async function refreshWorkspace(id: string) {
    const ws = workspaces.value.find((w) => w.id === id);
    if (!ws || !isTauriRuntime()) return;
    const settings = useSettingsStore();
    try {
      ws.tree = await ipc.scanWorkspace(ws.id, ws.rootPath, settings.state.showHiddenFiles);
    } catch (err) {
      console.error("Failed to scan workspace:", ws.rootPath, err);
    }
  }

  async function refreshAll() {
    loading.value = true;
    try {
      await syncRegisteredRoots();
      await Promise.all(workspaces.value.map((w) => refreshWorkspace(w.id)));
    } finally {
      loading.value = false;
    }
  }

  async function addWorkspace(rootPath: string): Promise<WorkspaceEntry | null> {
    const normNew = normalizeKey(rootPath);
    const existing = workspaces.value.find((w) => normalizeKey(w.rootPath) === normNew);
    if (existing) {
      await refreshWorkspace(existing.id);
      return existing;
    }

    const parts = rootPath.replace(/[\\/]+$/, "").split(/[\\/]/);
    const name = parts[parts.length - 1] || rootPath;
    const entry: WorkspaceEntry = {
      id: `ws-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      rootPath,
      collapsed: false,
      tree: null,
    };
    workspaces.value.push(entry);
    const next = new Set(expandedFolders.value);
    next.add(normalizeKey(rootPath));
    expandedFolders.value = next;
    await syncRegisteredRoots();
    await refreshWorkspace(entry.id);
    return entry;
  }

  async function pickAndAddWorkspace(): Promise<WorkspaceEntry | null> {
    const dir = await ipc.pickFolderDialog("添加本地笔记文件夹");
    if (!dir) return null;
    return addWorkspace(dir);
  }

  async function removeWorkspace(id: string) {
    workspaces.value = workspaces.value.filter((w) => w.id !== id);
    await syncRegisteredRoots();
  }

  function toggleWorkspaceCollapsed(id: string) {
    const ws = workspaces.value.find((w) => w.id === id);
    if (ws) {
      ws.collapsed = !ws.collapsed;
    }
  }

  function moveWorkspace(fromIndex: number, toIndex: number) {
    if (
      fromIndex === toIndex ||
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= workspaces.value.length ||
      toIndex >= workspaces.value.length
    ) {
      return;
    }
    const next = [...workspaces.value];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    workspaces.value = next;
  }

  const hasAnyExpandedTree = computed(
    () => workspaces.value.some((w) => !w.collapsed) || expandedFolders.value.size > 0
  );

  function collapseAllTrees() {
    expandedFolders.value = new Set();
    for (const ws of workspaces.value) {
      ws.collapsed = true;
    }
  }

  function expandAllWorkspaces() {
    for (const ws of workspaces.value) {
      ws.collapsed = false;
    }
  }

  function toggleFolder(path: string) {
    const key = normalizeKey(path);
    const next = new Set(expandedFolders.value);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expandedFolders.value = next;
  }

  function isFolderExpanded(path: string): boolean {
    if (filterQuery.value.trim().length > 0) return true;
    return expandedFolders.value.has(normalizeKey(path));
  }

  function revealFileInTree(filePath: string) {
    selectedPath.value = filePath;
    const ws = findWorkspaceForPath(filePath);
    if (ws) {
      ws.collapsed = false;
      const next = new Set(expandedFolders.value);
      const normFile = filePath.replace(/\\/g, "/");
      const parts = normFile.split("/");
      parts.pop();
      let cur = "";
      const rootKey = normalizeKey(ws.rootPath);
      for (let i = 0; i < parts.length; i++) {
        if (i === 0) cur = parts[0] === "" ? "/" : parts[0];
        else cur = cur === "/" ? `/${parts[i]}` : `${cur}/${parts[i]}`;
        const curKey = normalizeKey(cur);
        if (curKey.length >= rootKey.length) next.add(curKey);
      }
      expandedFolders.value = next;
    }
    revealNonce.value++;
  }

  async function hydrateWorkspaces(saved: Array<{ id: string; name: string; rootPath: string; collapsed?: boolean }>) {
    workspaces.value = saved.map((w) => ({
      id: w.id,
      name: w.name,
      rootPath: w.rootPath,
      collapsed: Boolean(w.collapsed),
      tree: null,
    }));
    const next = new Set(expandedFolders.value);
    for (const ws of workspaces.value) next.add(normalizeKey(ws.rootPath));
    expandedFolders.value = next;
    await refreshAll();
  }

  return {
    workspaces,
    displayWorkspaces,
    expandedFolders,
    selectedPath,
    revealNonce,
    filterQuery,
    sortOrder,
    loading,
    allFiles,
    normalizeKey,
    findWorkspaceForPath,
    getFilesInWorkspace,
    addWorkspace,
    pickAndAddWorkspace,
    removeWorkspace,
    toggleWorkspaceCollapsed,
    moveWorkspace,
    hasAnyExpandedTree,
    collapseAllTrees,
    expandAllWorkspaces,
    refreshWorkspace,
    refreshAll,
    toggleFolder,
    isFolderExpanded,
    revealFileInTree,
    hydrateWorkspaces,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useWorkspaceStore, import.meta.hot));
}
