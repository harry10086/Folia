import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref } from "vue";
import { ipc, isTauriRuntime, type FileNode } from "@/core/ipc/client";
import { t } from "@/core/i18n";
import { useSettingsStore } from "./settings";

export type SortOrder = "name-asc" | "name-desc" | "mtime-desc" | "mtime-asc" | "manual";

export const VALID_SORT_ORDERS: readonly SortOrder[] = [
  "name-asc",
  "name-desc",
  "mtime-desc",
  "mtime-asc",
  "manual",
] as const;

export function isValidSortOrder(v: unknown): v is SortOrder {
  return typeof v === "string" && (VALID_SORT_ORDERS as readonly string[]).includes(v);
}

export function sortOrderLabel(order: SortOrder): string {
  switch (order) {
    case "name-asc":
      return t("sort.nameAsc");
    case "name-desc":
      return t("sort.nameDesc");
    case "mtime-desc":
      return t("sort.mtimeDesc");
    case "mtime-asc":
      return t("sort.mtimeAsc");
    case "manual":
      return t("sort.manual");
  }
}

export function sortOrderShortBadge(order: SortOrder): string {
  switch (order) {
    case "name-asc":
      return "A-Z";
    case "name-desc":
      return "Z-A";
    case "mtime-desc":
      return "新→旧";
    case "mtime-asc":
      return "旧→新";
    case "manual":
      return "手动";
  }
}

export interface WorkspaceEntry {
  id: string;
  name: string;
  rootPath: string;
  collapsed: boolean;
  sortOrder?: SortOrder;
  tree: FileNode | null;
}

export function normalizePathKey(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function getDefaultWorkspaceName(rootPath: string): string {
  const parts = rootPath.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || rootPath;
}

export function getParentPath(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  if (idx <= 0) return cleaned;
  // Keep Windows drive root like `D:\` or `D:`
  if (idx === 2 && /^[A-Za-z]:/.test(cleaned)) {
    return cleaned.slice(0, 3);
  }
  return cleaned.slice(0, idx);
}

function flattenNodes(node: FileNode | null, out: FileNode[]) {
  if (!node) return;
  if (node.kind !== "folder") out.push(node);
  if (node.children) {
    for (const child of node.children) flattenNodes(child, out);
  }
}

function compareAutoNodes(a: FileNode, b: FileNode, order: Exclude<SortOrder, "manual">): number {
  const aDir = a.kind === "folder" ? 1 : 0;
  const bDir = b.kind === "folder" ? 1 : 0;
  if (aDir !== bDir) return bDir - aDir;
  if (order === "mtime-desc") return b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name, "zh-CN");
  if (order === "mtime-asc") return a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name, "zh-CN");
  if (order === "name-desc") return b.name.localeCompare(a.name, "zh-CN");
  return a.name.localeCompare(b.name, "zh-CN");
}

function sortChildrenByOrder(
  children: FileNode[],
  order: SortOrder,
  manualList?: string[]
): FileNode[] {
  const list = [...children];
  if (order === "manual" && manualList && manualList.length > 0) {
    const rankMap = new Map<string, number>();
    manualList.forEach((name, idx) => {
      const key = name.toLowerCase();
      if (!rankMap.has(key)) rankMap.set(key, idx);
    });
    list.sort((a, b) => {
      const ra = rankMap.get(a.name.toLowerCase());
      const rb = rankMap.get(b.name.toLowerCase());
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return compareAutoNodes(a, b, "name-asc");
    });
    return list;
  }

  const effectiveAuto: Exclude<SortOrder, "manual"> = order === "manual" ? "name-asc" : order;
  list.sort((a, b) => compareAutoNodes(a, b, effectiveAuto));
  return list;
}

function sortTreeHierarchical(
  node: FileNode,
  inheritedOrder: SortOrder,
  folderSortOrders: Record<string, SortOrder>,
  manualOrders: Record<string, string[]>,
  isWorkspaceRoot: boolean
): FileNode {
  if (!node.children) return node;
  const nodeKey = normalizePathKey(node.path);
  const explicitOrder = isWorkspaceRoot ? undefined : folderSortOrders[nodeKey];
  const currentOrder = explicitOrder ?? inheritedOrder;
  const sortedChildren = sortChildrenByOrder(
    node.children.map((c) =>
      sortTreeHierarchical(c, currentOrder, folderSortOrders, manualOrders, false)
    ),
    currentOrder,
    manualOrders[nodeKey]
  );
  return { ...node, children: sortedChildren };
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

function findFolderNode(node: FileNode | null, targetKey: string): FileNode | null {
  if (!node) return null;
  if (normalizePathKey(node.path) === targetKey) return node;
  if (node.children) {
    for (const child of node.children) {
      if (child.kind === "folder") {
        const hit = findFolderNode(child, targetKey);
        if (hit) return hit;
      }
    }
  }
  return null;
}

export const useWorkspaceStore = defineStore("workspace", () => {
  const workspaces = ref<WorkspaceEntry[]>([]);
  const expandedFolders = ref<Set<string>>(new Set());
  const selectedPath = ref<string | null>(null);
  const revealNonce = ref(0);
  const filterQuery = ref("");
  /** Global default sort order used when a workspace/folder does not define its own */
  const sortOrder = ref<SortOrder>("name-asc");
  /** Per-folder sort order overrides keyed by `normalizePathKey(folderPath)` */
  const folderSortOrders = ref<Record<string, SortOrder>>({});
  /** Per-directory manual child order (child names) keyed by `normalizePathKey(dirPath)` */
  const manualOrders = ref<Record<string, string[]>>({});
  /** Active dragged tree node path (for reliable 3-zone sibling vs folder drop feedback in WebView2) */
  const draggingNodePath = ref<string | null>(null);
  /** Per-workspace refresh revision counter (triggers scoped updates in AttachmentBar, etc.) */
  const workspaceRevisions = ref<Record<string, number>>({});
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
      const wsBaseOrder = ws.sortOrder ?? sortOrder.value;
      const sorted = sortTreeHierarchical(
        ws.tree,
        wsBaseOrder,
        folderSortOrders.value,
        manualOrders.value,
        true
      );
      const filtered = q ? filterTreeRecursive(sorted, q) : sorted;
      return { ...ws, tree: filtered };
    });
  });

  function normalizeKey(p: string): string {
    return normalizePathKey(p);
  }

  function findWorkspaceForPath(filePath: string): WorkspaceEntry | undefined {
    const target = normalizeKey(filePath);
    // Prefer the most specific (longest rootPath) match in case workspaces are nested
    let best: WorkspaceEntry | undefined;
    let bestLen = -1;
    for (const ws of workspaces.value) {
      const root = normalizeKey(ws.rootPath);
      if (target === root || target.startsWith(`${root}/`)) {
        if (root.length > bestLen) {
          best = ws;
          bestLen = root.length;
        }
      }
    }
    return best;
  }

  function getFilesInWorkspace(workspaceId: string | null): FileNode[] {
    if (!workspaceId) return allFiles.value;
    const ws = workspaces.value.find((w) => w.id === workspaceId);
    if (!ws) return allFiles.value;
    const out: FileNode[] = [];
    flattenNodes(ws.tree, out);
    return out;
  }

  function getWorkspaceEffectiveSort(wsId: string): SortOrder {
    const ws = workspaces.value.find((w) => w.id === wsId);
    return ws?.sortOrder ?? sortOrder.value;
  }

  function getFolderExplicitSort(folderPath: string): SortOrder | undefined {
    return folderSortOrders.value[normalizeKey(folderPath)];
  }

  function getDirectoryEffectiveSort(dirPath: string, wsId?: string): SortOrder {
    const dirKey = normalizeKey(dirPath);
    const ws =
      (wsId ? workspaces.value.find((w) => w.id === wsId) : undefined) ??
      findWorkspaceForPath(dirPath);
    const wsRootKey = ws ? normalizeKey(ws.rootPath) : "";
    const wsOrder = ws?.sortOrder ?? sortOrder.value;
    if (!ws || dirKey === wsRootKey) {
      return wsOrder;
    }

    // Walk up from `dirPath` to `ws.rootPath`, returning the closest explicit override
    let cur = dirPath;
    for (let guard = 0; guard < 64; guard++) {
      const key = normalizeKey(cur);
      if (key === wsRootKey) break;
      const explicit = folderSortOrders.value[key];
      if (explicit) return explicit;
      const parent = getParentPath(cur);
      if (normalizeKey(parent) === key) break;
      cur = parent;
    }
    return wsOrder;
  }

  function setWorkspaceSortOrder(wsId: string, order: SortOrder | null) {
    const ws = workspaces.value.find((w) => w.id === wsId);
    if (!ws) return;
    if (order === null) {
      delete ws.sortOrder;
    } else {
      if (order === "manual") {
        ensureManualSnapshot(ws.rootPath, ws.id);
      }
      ws.sortOrder = order;
    }
  }

  function setFolderSortOrder(folderPath: string, order: SortOrder | null, wsId?: string) {
    const ws =
      (wsId ? workspaces.value.find((w) => w.id === wsId) : undefined) ??
      findWorkspaceForPath(folderPath);
    const key = normalizeKey(folderPath);
    if (ws && normalizeKey(ws.rootPath) === key) {
      setWorkspaceSortOrder(ws.id, order);
      return;
    }
    const next = { ...folderSortOrders.value };
    if (order === null) {
      delete next[key];
    } else {
      if (order === "manual") {
        ensureManualSnapshot(folderPath, ws?.id);
      }
      next[key] = order;
    }
    folderSortOrders.value = next;
  }

  function ensureManualSnapshot(dirPath: string, wsId?: string): string[] {
    const dirKey = normalizeKey(dirPath);
    const ws =
      (wsId ? workspaces.value.find((w) => w.id === wsId) : undefined) ??
      findWorkspaceForPath(dirPath);
    if (!ws?.tree) return manualOrders.value[dirKey] ?? [];

    const folderNode = findFolderNode(ws.tree, dirKey);
    if (!folderNode?.children) return manualOrders.value[dirKey] ?? [];

    const curOrder = getDirectoryEffectiveSort(dirPath, ws.id);
    const sortedNow = sortChildrenByOrder(
      folderNode.children,
      curOrder,
      manualOrders.value[dirKey]
    );
    const names = sortedNow.map((c) => c.name);
    manualOrders.value = { ...manualOrders.value, [dirKey]: names };
    return names;
  }

  /**
   * Reorder a child node relative to a sibling inside the same parent directory.
   * Automatically switches that parent directory (or workspace root) to `manual` sort.
   */
  function reorderSiblingNode(
    srcPath: string,
    targetPath: string,
    position: "before" | "after"
  ): boolean {
    const srcParent = getParentPath(srcPath);
    const targetParent = getParentPath(targetPath);
    const parentKey = normalizeKey(srcParent);
    if (parentKey !== normalizeKey(targetParent)) return false;

    const srcKey = normalizeKey(srcPath);
    const targetKey = normalizeKey(targetPath);
    if (srcKey === targetKey) return false;

    const ws = findWorkspaceForPath(srcPath);
    if (!ws) return false;

    const names = [...ensureManualSnapshot(srcParent, ws.id)];
    const srcName = srcPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
    const targetName = targetPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
    const fromIdx = names.findIndex((n) => n.toLowerCase() === srcName.toLowerCase());
    const toIdx = names.findIndex((n) => n.toLowerCase() === targetName.toLowerCase());
    if (fromIdx === -1 || toIdx === -1) return false;

    const [moved] = names.splice(fromIdx, 1);
    let insertAt = names.findIndex((n) => n.toLowerCase() === targetName.toLowerCase());
    if (insertAt === -1) return false;
    if (position === "after") insertAt += 1;
    names.splice(insertAt, 0, moved);

    manualOrders.value = { ...manualOrders.value, [parentKey]: names };
    if (normalizeKey(ws.rootPath) === parentKey) {
      ws.sortOrder = "manual";
    } else {
      folderSortOrders.value = { ...folderSortOrders.value, [parentKey]: "manual" };
    }
    return true;
  }

  /**
   * Move a file or folder one step up (-1) or down (+1) among its siblings,
   * automatically activating `manual` sort for its parent directory.
   */
  function nudgeNodeInParent(nodePath: string, delta: -1 | 1): boolean {
    const parentDir = getParentPath(nodePath);
    const parentKey = normalizeKey(parentDir);
    const ws = findWorkspaceForPath(nodePath);
    if (!ws) return false;

    const names = [...ensureManualSnapshot(parentDir, ws.id)];
    const nodeName = nodePath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
    const idx = names.findIndex((n) => n.toLowerCase() === nodeName.toLowerCase());
    const nextIdx = idx + delta;
    if (idx === -1 || nextIdx < 0 || nextIdx >= names.length) return false;

    const [moved] = names.splice(idx, 1);
    names.splice(nextIdx, 0, moved);
    manualOrders.value = { ...manualOrders.value, [parentKey]: names };
    if (normalizeKey(ws.rootPath) === parentKey) {
      ws.sortOrder = "manual";
    } else {
      folderSortOrders.value = { ...folderSortOrders.value, [parentKey]: "manual" };
    }
    return true;
  }

  /**
   * Keep per-folder sort overrides and manual child orders intact when a file or folder is renamed.
   */
  function handlePathRenamed(oldPath: string, newPath: string) {
    const oldKey = normalizeKey(oldPath);
    const newKey = normalizeKey(newPath);
    if (oldKey === newKey) return;

    const oldParentKey = normalizeKey(getParentPath(oldPath));
    const newParentKey = normalizeKey(getParentPath(newPath));
    const oldName = oldPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
    const newName = newPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";

    // 1) Update child name inside parent's manual order list if renamed in place
    if (oldParentKey === newParentKey && manualOrders.value[oldParentKey]) {
      const updated = manualOrders.value[oldParentKey].map((n) =>
        n.toLowerCase() === oldName.toLowerCase() ? newName : n
      );
      manualOrders.value = { ...manualOrders.value, [oldParentKey]: updated };
    }

    // 2) Migrate folderSortOrders keys for the renamed folder & its descendants
    let sortChanged = false;
    const nextFolderSorts: Record<string, SortOrder> = {};
    for (const [k, v] of Object.entries(folderSortOrders.value)) {
      if (k === oldKey) {
        nextFolderSorts[newKey] = v;
        sortChanged = true;
      } else if (k.startsWith(`${oldKey}/`)) {
        nextFolderSorts[`${newKey}${k.slice(oldKey.length)}`] = v;
        sortChanged = true;
      } else {
        nextFolderSorts[k] = v;
      }
    }
    if (sortChanged) folderSortOrders.value = nextFolderSorts;

    // 3) Migrate manualOrders keys for the renamed folder & its descendants
    let manualChanged = false;
    const nextManuals: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(manualOrders.value)) {
      if (k === oldKey) {
        nextManuals[newKey] = v;
        manualChanged = true;
      } else if (k.startsWith(`${oldKey}/`)) {
        nextManuals[`${newKey}${k.slice(oldKey.length)}`] = v;
        manualChanged = true;
      } else {
        nextManuals[k] = v;
      }
    }
    if (manualChanged) manualOrders.value = nextManuals;
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
      workspaceRevisions.value = {
        ...workspaceRevisions.value,
        [id]: (workspaceRevisions.value[id] ?? 0) + 1,
      };
    } catch (err) {
      console.error("Failed to scan workspace:", ws.rootPath, err);
    }
  }

  async function refreshWorkspacesForPaths(paths: string[]) {
    if (!isTauriRuntime() || paths.length === 0) return;
    const affectedIds = new Set<string>();
    for (const p of paths) {
      const ws = findWorkspaceForPath(p);
      if (ws) affectedIds.add(ws.id);
    }
    if (affectedIds.size === 0) return;
    await Promise.all(Array.from(affectedIds).map((id) => refreshWorkspace(id)));
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
    const dir = await ipc.pickFolderDialog(t("sidebar.pickFolderTitle"));
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

  /**
   * Set a custom display alias for a workspace (stored only in config.json; never renames the disk folder).
   * Passing an empty/whitespace string resets the display name back to the folder's default name.
   */
  function renameWorkspaceAlias(id: string, alias: string) {
    const ws = workspaces.value.find((w) => w.id === id);
    if (!ws) return;
    const trimmed = alias.trim();
    ws.name = trimmed || getDefaultWorkspaceName(ws.rootPath);
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

  function hydrateSortPreferences(
    savedFolderSorts?: Record<string, unknown>,
    savedManualOrders?: Record<string, unknown>
  ) {
    const nextSorts: Record<string, SortOrder> = {};
    if (savedFolderSorts && typeof savedFolderSorts === "object") {
      for (const [k, v] of Object.entries(savedFolderSorts)) {
        if (isValidSortOrder(v)) {
          nextSorts[normalizeKey(k)] = v;
        }
      }
    }
    folderSortOrders.value = nextSorts;

    const nextManuals: Record<string, string[]> = {};
    if (savedManualOrders && typeof savedManualOrders === "object") {
      for (const [k, v] of Object.entries(savedManualOrders)) {
        if (Array.isArray(v)) {
          const clean = v.filter((item): item is string => typeof item === "string" && item.length > 0);
          if (clean.length > 0) {
            nextManuals[normalizeKey(k)] = clean;
          }
        }
      }
    }
    manualOrders.value = nextManuals;
  }

  async function hydrateWorkspaces(
    saved: Array<{ id: string; name: string; rootPath: string; collapsed?: boolean; sortOrder?: unknown }>
  ) {
    workspaces.value = saved.map((w) => ({
      id: w.id,
      name: w.name,
      rootPath: w.rootPath,
      collapsed: Boolean(w.collapsed),
      sortOrder: isValidSortOrder(w.sortOrder) ? w.sortOrder : undefined,
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
    folderSortOrders,
    manualOrders,
    draggingNodePath,
    workspaceRevisions,
    loading,
    allFiles,
    normalizeKey,
    findWorkspaceForPath,
    getFilesInWorkspace,
    getWorkspaceEffectiveSort,
    getFolderExplicitSort,
    getDirectoryEffectiveSort,
    setWorkspaceSortOrder,
    setFolderSortOrder,
    reorderSiblingNode,
    nudgeNodeInParent,
    handlePathRenamed,
    addWorkspace,
    pickAndAddWorkspace,
    removeWorkspace,
    toggleWorkspaceCollapsed,
    renameWorkspaceAlias,
    moveWorkspace,
    hasAnyExpandedTree,
    collapseAllTrees,
    expandAllWorkspaces,
    refreshWorkspace,
    refreshWorkspacesForPaths,
    refreshAll,
    toggleFolder,
    isFolderExpanded,
    revealFileInTree,
    hydrateSortPreferences,
    hydrateWorkspaces,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useWorkspaceStore, import.meta.hot));
}
