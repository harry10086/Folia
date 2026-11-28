import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, reactive, ref } from "vue";
import {
  ipc,
  parseIpcError,
  type ConflictPayload,
  type ExternalFileEvent,
  type FileKind,
  type LineEnding,
  type RecoveryDraft,
} from "@/core/ipc/client";
import { destroyTerminalInstance } from "@/core/terminal/terminalRegistry";
import { useSettingsStore } from "./settings";
import { useWorkspaceStore } from "./workspace";

export interface OpenTab {
  id: string;
  paneId: string;
  path: string;
  workspaceId: string;
  name: string;
  kind: FileKind;
  content: string;
  savedContent: string;
  encoding: string;
  hasBom: boolean;
  lineEnding: LineEnding;
  hash: string;
  mtimeMs: number;
  sizeBytes: number;
  isLarge: boolean;
  editMode: "live" | "source";
  pinned: boolean;
  dirty: boolean;
  saving: boolean;
  externalConflict: null | {
    kind: "modified" | "deleted";
    diskContent?: string;
    diskHash?: string;
    encoding?: string;
    hasBom?: boolean;
    lineEnding?: LineEnding;
  };
  jumpToLine: number | null;
  jumpNonce: number;
}

export interface EditorPane {
  id: string;
  tabs: OpenTab[];
  activeTabId: string | null;
}

export interface RecentFileEntry {
  path: string;
  name: string;
  workspaceId: string;
  openedAtMs: number;
}

export interface DiffModalState {
  open: boolean;
  titleLeft: string;
  titleRight: string;
  contentLeft: string;
  contentRight: string;
  conflictTabId?: string;
}

export type SplitDirection = "none" | "vertical" | "horizontal";

export interface SavedTabEntry {
  path: string;
  workspaceId?: string;
  pinned?: boolean;
  editMode?: "live" | "source";
}

export interface SavedPaneLayout {
  activePath?: string | null;
  tabs: SavedTabEntry[];
}

export interface SavedWorkspaceLayout {
  splitDirection: SplitDirection;
  activePaneIndex?: number;
  paneSizes?: number[];
  panes: SavedPaneLayout[];
}

function classifyByPath(path: string): FileKind {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["md", "markdown", "mdown", "mkd", "txt"].includes(ext)) return "markdown";
  if (["html", "htm"].includes(ext)) return "html";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  return "other";
}

function fileNameFromPath(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function normPath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

let nextPaneCounter = 2;
function createPaneId(): string {
  return `pane-${nextPaneCounter++}`;
}

export const useTabsStore = defineStore("tabs", () => {
  const panes = ref<EditorPane[]>([{ id: "pane-1", tabs: [], activeTabId: null }]);
  const activePaneId = ref<string>("pane-1");
  const lastDocumentPaneId = ref<string>("pane-1");
  const splitDirection = ref<SplitDirection>("none");
  const recentFiles = ref<RecentFileEntry[]>([]);
  const recoveryDrafts = ref<RecoveryDraft[]>([]);
  const toastMessage = ref<string | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  // Ctrl+Click multi-selected tabs for 2-column / 3-column split merging
  const selectedSplitTabIds = ref<string[]>([]);
  const selectedSplitPaneId = ref<string | null>(null);

  const diffState = reactive<DiffModalState>({
    open: false,
    titleLeft: "",
    titleRight: "",
    contentLeft: "",
    contentRight: "",
  });

  const historyModalTabId = ref<string | null>(null);
  const baselineCapturedPaths = new Set<string>();

  const autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const activePane = computed<EditorPane>(
    () => panes.value.find((p) => p.id === activePaneId.value) ?? panes.value[0]
  );

  const activeTab = computed<OpenTab | null>(() => {
    const pane = activePane.value;
    if (!pane || !pane.activeTabId) return null;
    return pane.tabs.find((t) => t.id === pane.activeTabId) ?? null;
  });

  const allOpenTabs = computed<OpenTab[]>(() => panes.value.flatMap((p) => p.tabs));

  function showToast(msg: string, duration = 2600) {
    toastMessage.value = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastMessage.value = null;
    }, duration);
  }

  function getDisplayTabTitle(tab: OpenTab): string {
    const duplicates = allOpenTabs.value.filter(
      (t) => t.name.toLowerCase() === tab.name.toLowerCase() && normPath(t.path) !== normPath(tab.path)
    );
    if (duplicates.length === 0) return tab.name;
    const parts = tab.path.split(/[\\/]/);
    const parent = parts.length >= 2 ? parts[parts.length - 2] : "";
    return parent ? `${tab.name} · ${parent}` : tab.name;
  }

  function pushRecentFile(path: string, workspaceId: string) {
    const name = fileNameFromPath(path);
    const filtered = recentFiles.value.filter((r) => normPath(r.path) !== normPath(path));
    filtered.unshift({ path, name, workspaceId, openedAtMs: Date.now() });
    recentFiles.value = filtered.slice(0, 25);
  }

  function clearSplitSelection() {
    selectedSplitTabIds.value = [];
    selectedSplitPaneId.value = null;
  }

  function toggleSplitTabSelection(paneId: string, tabId: string) {
    if (selectedSplitPaneId.value && selectedSplitPaneId.value !== paneId) {
      selectedSplitTabIds.value = [tabId];
      selectedSplitPaneId.value = paneId;
      return;
    }
    selectedSplitPaneId.value = paneId;
    const idx = selectedSplitTabIds.value.indexOf(tabId);
    if (idx >= 0) {
      selectedSplitTabIds.value = selectedSplitTabIds.value.filter((id) => id !== tabId);
      if (selectedSplitTabIds.value.length === 0) selectedSplitPaneId.value = null;
    } else {
      if (selectedSplitTabIds.value.length >= 3) {
        showToast("最多可同时选择 3 个标签页合并为三分栏");
        return;
      }
      selectedSplitTabIds.value = [...selectedSplitTabIds.value, tabId];
    }
  }

  function mergeSelectedTabsToColumns() {
    const paneId = selectedSplitPaneId.value;
    const ids = [...selectedSplitTabIds.value];
    if (!paneId || ids.length < 2 || ids.length > 3) return;
    const sourcePane = panes.value.find((p) => p.id === paneId);
    if (!sourcePane) {
      clearSplitSelection();
      return;
    }

    const pickedTabs: OpenTab[] = [];
    for (const id of ids) {
      const t = sourcePane.tabs.find((tab) => tab.id === id);
      if (t) pickedTabs.push(t);
    }
    if (pickedTabs.length < 2) {
      clearSplitSelection();
      return;
    }

    // Collect any other existing tabs into pane-1 so no open work is lost
    const pickedIdSet = new Set(pickedTabs.map((t) => t.id));
    const leftoverTabs: OpenTab[] = [];
    for (const p of panes.value) {
      for (const t of p.tabs) {
        if (!pickedIdSet.has(t.id) && !leftoverTabs.some((x) => normPath(x.path) === normPath(t.path))) {
          leftoverTabs.push(t);
        }
      }
    }

    const newPanes: EditorPane[] = pickedTabs.map((tab, idx) => {
      const newId = idx === 0 ? "pane-1" : createPaneId();
      tab.paneId = newId;
      if (tab.kind !== "terminal") {
        tab.id = `${newId}::${tab.path}`;
      }
      const tabsForPane: OpenTab[] = [tab];
      if (idx === 0) {
        for (const extra of leftoverTabs) {
          if (extra.kind === tab.kind && normPath(extra.path) === normPath(tab.path)) continue;
          extra.paneId = newId;
          if (extra.kind !== "terminal") {
            extra.id = `${newId}::${extra.path}`;
          }
          tabsForPane.push(extra);
        }
        // Keep pinned tabs grouped on the left
        tabsForPane.sort((a, b) => Number(b.pinned) - Number(a.pinned));
      }
      return {
        id: newId,
        tabs: tabsForPane,
        activeTabId: tab.id,
      };
    });

    panes.value = newPanes;
    splitDirection.value = "vertical";
    activePaneId.value = newPanes[0].id;
    clearSplitSelection();
    showToast(`已合并为 ${newPanes.length} 分栏显示`);
  }

  function isTerminalPane(pane: EditorPane): boolean {
    if (pane.tabs.length === 0) return false;
    const active = pane.tabs.find((t) => t.id === pane.activeTabId);
    if (active?.kind === "terminal") return true;
    return pane.tabs.every((t) => t.kind === "terminal");
  }

  function markDocumentPaneIfApplicable(pane: EditorPane) {
    if (!isTerminalPane(pane)) {
      lastDocumentPaneId.value = pane.id;
    }
  }

  function resolveTargetPaneForDocument(explicitPaneId?: string): EditorPane {
    if (explicitPaneId) {
      return panes.value.find((p) => p.id === explicitPaneId) ?? panes.value[0];
    }
    const cur = panes.value.find((p) => p.id === activePaneId.value) ?? panes.value[0];
    if (!isTerminalPane(cur)) {
      return cur;
    }
    const remembered = panes.value.find(
      (p) => p.id === lastDocumentPaneId.value && !isTerminalPane(p)
    );
    if (remembered) return remembered;

    const emptyPane = panes.value.find((p) => p.tabs.length === 0);
    if (emptyPane) return emptyPane;

    const nonTerminalPane = panes.value.find((p) => !isTerminalPane(p));
    if (nonTerminalPane) return nonTerminalPane;

    return cur;
  }

  async function openFile(
    path: string,
    options?: {
      paneId?: string;
      line?: number;
      workspaceId?: string;
      pinned?: boolean;
      editMode?: "live" | "source";
      silent?: boolean;
    }
  ): Promise<OpenTab | null> {
    const pane = resolveTargetPaneForDocument(options?.paneId);
    const wsStore = useWorkspaceStore();
    const settings = useSettingsStore();

    const existing = pane.tabs.find(
      (t) => t.kind !== "terminal" && normPath(t.path) === normPath(path)
    );
    if (existing) {
      pane.activeTabId = existing.id;
      activePaneId.value = pane.id;
      lastDocumentPaneId.value = pane.id;
      if (options?.line) {
        existing.jumpToLine = options.line;
        existing.jumpNonce++;
      }
      wsStore.revealFileInTree(existing.path);
      return existing;
    }

    const kind = classifyByPath(path);
    const ws = wsStore.findWorkspaceForPath(path);
    const workspaceId = options?.workspaceId ?? ws?.id ?? "";

    let content = "";
    let encoding = "UTF-8";
    let hasBom = false;
    let lineEnding: LineEnding = "LF";
    let hash = "";
    let mtimeMs = 0;
    let sizeBytes = 0;
    let isLarge = false;

    if (kind === "markdown" || kind === "html" || kind === "other") {
      try {
        const doc = await ipc.readFile(path);
        content = doc.content;
        encoding = doc.encoding;
        hasBom = doc.hasBom;
        lineEnding = doc.lineEnding;
        hash = doc.hash;
        mtimeMs = doc.mtimeMs;
        sizeBytes = doc.sizeBytes;
        isLarge = doc.isLarge;
      } catch (err) {
        if (!options?.silent) {
          showToast(`打开失败: ${parseIpcError(err).message}`);
        }
        return null;
      }
    }

    const resolvedEditMode: "live" | "source" =
      kind === "html"
        ? options?.editMode === "source"
          ? "source"
          : "live"
        : isLarge
          ? "source"
          : options?.editMode === "live" || options?.editMode === "source"
            ? options.editMode
            : settings.state.defaultEditMode;

    const tab: OpenTab = {
      id: `${pane.id}::${path}`,
      paneId: pane.id,
      path,
      workspaceId,
      name: fileNameFromPath(path),
      kind,
      content,
      savedContent: content,
      encoding,
      hasBom,
      lineEnding,
      hash,
      mtimeMs,
      sizeBytes,
      isLarge,
      editMode: resolvedEditMode,
      pinned: Boolean(options?.pinned),
      dirty: false,
      saving: false,
      externalConflict: null,
      jumpToLine: options?.line ?? null,
      jumpNonce: options?.line ? 1 : 0,
    };

    if (tab.pinned) {
      const insertAt = pane.tabs.filter((t) => t.pinned).length;
      pane.tabs.splice(insertAt, 0, tab);
    } else {
      pane.tabs.push(tab);
    }

    pane.activeTabId = tab.id;
    activePaneId.value = pane.id;
    lastDocumentPaneId.value = pane.id;
    pushRecentFile(path, workspaceId);
    wsStore.revealFileInTree(path);
    return tab;
  }

  function openTerminalForWorkspace(workspaceId: string, workspaceName: string, cwd: string) {
    const prevActive = panes.value.find((p) => p.id === activePaneId.value);
    if (prevActive && !isTerminalPane(prevActive)) {
      lastDocumentPaneId.value = prevActive.id;
    }

    const termKey = `terminal::${normPath(cwd)}`;

    // If a terminal for this workspace is already open, focus it
    for (const p of panes.value) {
      const existing = p.tabs.find((t) => t.kind === "terminal" && normPath(t.path) === normPath(cwd));
      if (existing) {
        p.activeTabId = existing.id;
        activePaneId.value = p.id;
        return existing;
      }
    }

    // Choose or create a split pane so the terminal opens in a side column without hiding current notes
    let targetPane: EditorPane | undefined = panes.value.find((p) =>
      p.tabs.some((t) => t.kind === "terminal")
    );

    if (!targetPane) {
      if (panes.value.length < 3) {
        const newId = createPaneId();
        targetPane = { id: newId, tabs: [], activeTabId: null };
        panes.value.push(targetPane);
        splitDirection.value = "vertical";
      } else {
        targetPane = panes.value[panes.value.length - 1];
      }
    }

    const tab: OpenTab = {
      id: `${termKey}::${Date.now()}`,
      paneId: targetPane.id,
      path: cwd,
      workspaceId,
      name: `终端 · ${workspaceName}`,
      kind: "terminal",
      content: "",
      savedContent: "",
      encoding: "UTF-8",
      hasBom: false,
      lineEnding: "LF",
      hash: "",
      mtimeMs: Date.now(),
      sizeBytes: 0,
      isLarge: false,
      editMode: "source",
      pinned: false,
      dirty: false,
      saving: false,
      externalConflict: null,
      jumpToLine: null,
      jumpNonce: 0,
    };

    targetPane.tabs.push(tab);
    targetPane.activeTabId = tab.id;
    activePaneId.value = targetPane.id;
    return tab;
  }

  function updateTabContent(tabId: string, newContent: string) {
    const tab = findTabById(tabId);
    if (!tab || tab.content === newContent) return;

    tab.content = newContent;
    tab.dirty = tab.content !== tab.savedContent;

    for (const other of allOpenTabs.value) {
      if (other.id !== tab.id && normPath(other.path) === normPath(tab.path)) {
        other.content = newContent;
        other.dirty = other.content !== other.savedContent;
      }
    }

    scheduleRecoveryDraft(tab);

    const settings = useSettingsStore();
    if (settings.state.autoSaveEnabled && tab.dirty && !tab.externalConflict) {
      scheduleAutoSave(tab);
    }
  }

  function scheduleAutoSave(tab: OpenTab) {
    const prev = autoSaveTimers.get(tab.id);
    if (prev) clearTimeout(prev);
    const delay = Math.max(300, useSettingsStore().state.autoSaveDelayMs);
    autoSaveTimers.set(
      tab.id,
      setTimeout(() => {
        autoSaveTimers.delete(tab.id);
        if (tab.dirty && !tab.externalConflict) void saveTab(tab.id, false);
      }, delay)
    );
  }

  function scheduleRecoveryDraft(tab: OpenTab) {
    const prev = recoveryTimers.get(tab.id);
    if (prev) clearTimeout(prev);
    if (!tab.dirty) {
      void ipc.deleteRecoveryDraft(tab.path).catch(() => {});
      return;
    }
    recoveryTimers.set(
      tab.id,
      setTimeout(() => {
        recoveryTimers.delete(tab.id);
        if (tab.dirty) {
          void ipc
            .saveRecoveryDraft({
              path: tab.path,
              content: tab.content,
              baseHash: tab.hash,
              updatedAtMs: Date.now(),
            })
            .catch(() => {});
        }
      }, 2500)
    );
  }

  async function saveTab(tabId: string, force = false, manual = false): Promise<boolean> {
    const tab = findTabById(tabId);
    if (!tab || (tab.kind !== "markdown" && tab.kind !== "html" && tab.kind !== "other")) return false;
    if (tab.saving) return false;

    const timer = autoSaveTimers.get(tab.id);
    if (timer) {
      clearTimeout(timer);
      autoSaveTimers.delete(tab.id);
    }

    const settings = useSettingsStore();
    const prevSaved = tab.savedContent;
    const normKey = normPath(tab.path);

    // Capture a one-time pre-edit baseline snapshot before overwriting disk on the first edit
    if (
      settings.state.historyEnabled &&
      !baselineCapturedPaths.has(normKey) &&
      prevSaved !== tab.content
    ) {
      baselineCapturedPaths.add(normKey);
      await ipc
        .historySaveSnapshot({
          path: tab.path,
          content: prevSaved,
          reason: "open",
          minIntervalSecs: 0,
          maxSnapshots: settings.state.historyMaxSnapshots,
          force: true,
        })
        .catch(() => {});
    }

    tab.saving = true;
    try {
      const res = await ipc.saveFile({
        path: tab.path,
        content: tab.content,
        encoding: tab.encoding,
        hasBom: tab.hasBom,
        lineEnding: tab.lineEnding,
        expectedHash: tab.hash || null,
        force,
      });

      for (const t of allOpenTabs.value) {
        if (normPath(t.path) === normPath(tab.path)) {
          t.savedContent = tab.content;
          t.hash = res.hash;
          t.mtimeMs = res.mtimeMs;
          t.sizeBytes = res.sizeBytes;
          t.dirty = false;
          t.externalConflict = null;
        }
      }

      if (settings.state.historyEnabled) {
        const intervalSecs = Math.max(60, Math.round((settings.state.historyIntervalMinutes || 5) * 60));
        void ipc
          .historySaveSnapshot({
            path: tab.path,
            content: tab.content,
            reason: manual ? "manual" : "auto",
            minIntervalSecs: intervalSecs,
            maxSnapshots: settings.state.historyMaxSnapshots,
            force: manual,
          })
          .catch(() => {});
      }

      return true;
    } catch (err) {
      const parsed = parseIpcError(err);
      if (parsed.code === "FILE_CONFLICT" && parsed.conflict) {
        applyConflictToTabs(tab.path, parsed.conflict);
        showToast("检测到外部修改，已阻止覆盖，请选择处理方式", 4000);
      } else {
        showToast(`保存失败: ${parsed.message}`, 3500);
      }
      return false;
    } finally {
      tab.saving = false;
    }
  }

  function applyConflictToTabs(filePath: string, conflict: ConflictPayload) {
    for (const t of allOpenTabs.value) {
      if (normPath(t.path) === normPath(filePath)) {
        t.externalConflict = {
          kind: "modified",
          diskContent: conflict.diskContent,
          diskHash: conflict.diskHash,
          encoding: conflict.encoding,
          hasBom: conflict.hasBom,
          lineEnding: conflict.lineEnding,
        };
      }
    }
  }

  async function handleExternalFileEvent(ev: ExternalFileEvent) {
    const matching = allOpenTabs.value.filter((t) => normPath(t.path) === normPath(ev.path));
    if (matching.length === 0) return;

    if (ev.kind === "deleted") {
      for (const t of matching) t.externalConflict = { kind: "deleted" };
      return;
    }

    if (ev.hash && matching.every((t) => t.hash === ev.hash)) return;

    try {
      const diskDoc = await ipc.readFile(ev.path);
      for (const t of matching) {
        if (!t.dirty) {
          t.content = diskDoc.content;
          t.savedContent = diskDoc.content;
          t.hash = diskDoc.hash;
          t.mtimeMs = diskDoc.mtimeMs;
          t.encoding = diskDoc.encoding;
          t.hasBom = diskDoc.hasBom;
          t.lineEnding = diskDoc.lineEnding;
          t.externalConflict = null;
        } else {
          t.externalConflict = {
            kind: "modified",
            diskContent: diskDoc.content,
            diskHash: diskDoc.hash,
            encoding: diskDoc.encoding,
            hasBom: diskDoc.hasBom,
            lineEnding: diskDoc.lineEnding,
          };
        }
      }
    } catch {
      // ignore transient lock
    }
  }

  async function reloadTabFromDisk(tabId: string) {
    const tab = findTabById(tabId);
    if (!tab) return;
    try {
      const diskDoc = await ipc.readFile(tab.path);
      for (const t of allOpenTabs.value) {
        if (normPath(t.path) === normPath(tab.path)) {
          t.content = diskDoc.content;
          t.savedContent = diskDoc.content;
          t.hash = diskDoc.hash;
          t.mtimeMs = diskDoc.mtimeMs;
          t.encoding = diskDoc.encoding;
          t.hasBom = diskDoc.hasBom;
          t.lineEnding = diskDoc.lineEnding;
          t.dirty = false;
          t.externalConflict = null;
        }
      }
      void ipc.deleteRecoveryDraft(tab.path).catch(() => {});
      showToast("已重新加载磁盘最新版本");
    } catch (err) {
      showToast(`重新加载失败: ${parseIpcError(err).message}`);
    }
  }

  async function keepLocalAndOverwrite(tabId: string) {
    const ok = await saveTab(tabId, true);
    if (ok) showToast("已保留当前编辑内容并写入磁盘");
  }

  function openConflictDiff(tabId: string) {
    const tab = findTabById(tabId);
    if (!tab || !tab.externalConflict?.diskContent) return;
    diffState.open = true;
    diffState.titleLeft = `磁盘最新版本 (${tab.name})`;
    diffState.titleRight = `当前编辑器内容 (${tab.name})`;
    diffState.contentLeft = tab.externalConflict.diskContent;
    diffState.contentRight = tab.content;
    diffState.conflictTabId = tab.id;
  }

  async function openFilesDiff(pathA: string, pathB: string) {
    try {
      const [docA, docB] = await Promise.all([ipc.readFile(pathA), ipc.readFile(pathB)]);
      diffState.open = true;
      diffState.titleLeft = fileNameFromPath(pathA);
      diffState.titleRight = fileNameFromPath(pathB);
      diffState.contentLeft = docA.content;
      diffState.contentRight = docB.content;
      diffState.conflictTabId = undefined;
    } catch (err) {
      showToast(`无法对比文件: ${parseIpcError(err).message}`);
    }
  }

  function diffSelectedTabs() {
    if (!selectedSplitPaneId.value || selectedSplitTabIds.value.length !== 2) return;
    const pane = panes.value.find((p) => p.id === selectedSplitPaneId.value);
    if (!pane) return;
    const tabA = pane.tabs.find((t) => t.id === selectedSplitTabIds.value[0]);
    const tabB = pane.tabs.find((t) => t.id === selectedSplitTabIds.value[1]);
    if (!tabA || !tabB) return;
    const isText = (t: OpenTab) => t.kind === "markdown" || t.kind === "html" || t.kind === "other";
    if (!isText(tabA) || !isText(tabB)) {
      showToast("仅支持对 Markdown / HTML / 文本标签页进行差异对比");
      return;
    }
    diffState.open = true;
    diffState.titleLeft = getDisplayTabTitle(tabA);
    diffState.titleRight = getDisplayTabTitle(tabB);
    diffState.contentLeft = tabA.content;
    diffState.contentRight = tabB.content;
    diffState.conflictTabId = undefined;
    clearSplitSelection();
  }

  function openHistoryModal(tabId: string) {
    historyModalTabId.value = tabId;
  }

  function closeHistoryModal() {
    historyModalTabId.value = null;
  }

  async function restoreTabFromHistory(tabId: string, targetContent: string, timeLabel: string) {
    const tab = findTabById(tabId);
    if (!tab) return;
    const settings = useSettingsStore();

    // Always preserve current content as a safety snapshot before restoring
    await ipc
      .historySaveSnapshot({
        path: tab.path,
        content: tab.content,
        reason: "before-restore",
        minIntervalSecs: 0,
        maxSnapshots: settings.state.historyMaxSnapshots,
        force: true,
      })
      .catch(() => {});

    updateTabContent(tab.id, targetContent);
    await saveTab(tab.id, false, false);
    showToast(`已恢复到 ${timeLabel} 的版本（恢复前内容已自动备份）`, 3500);
  }

  function closeDiff() {
    diffState.open = false;
    diffState.conflictTabId = undefined;
  }

  function findTabById(tabId: string): OpenTab | undefined {
    for (const pane of panes.value) {
      const found = pane.tabs.find((t) => t.id === tabId);
      if (found) return found;
    }
    return undefined;
  }

  function focusPaneAndReveal(paneId: string) {
    activePaneId.value = paneId;
    const pane = panes.value.find((p) => p.id === paneId);
    if (pane) markDocumentPaneIfApplicable(pane);
    const tab = pane?.tabs.find((t) => t.id === pane.activeTabId);
    if (tab && tab.kind !== "terminal") useWorkspaceStore().revealFileInTree(tab.path);
  }

  function selectTab(paneId: string, tabId: string) {
    const pane = panes.value.find((p) => p.id === paneId);
    if (!pane) return;
    pane.activeTabId = tabId;
    activePaneId.value = paneId;
    markDocumentPaneIfApplicable(pane);
    const tab = pane.tabs.find((t) => t.id === tabId);
    if (tab && tab.kind !== "terminal") useWorkspaceStore().revealFileInTree(tab.path);
  }

  function togglePinTab(paneId: string, tabId: string) {
    const pane = panes.value.find((p) => p.id === paneId);
    if (!pane) return;
    const idx = pane.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const [tab] = pane.tabs.splice(idx, 1);
    tab.pinned = !tab.pinned;
    const pinnedCount = pane.tabs.filter((t) => t.pinned).length;
    if (tab.pinned) {
      pane.tabs.splice(pinnedCount, 0, tab);
    } else {
      pane.tabs.splice(pinnedCount, 0, tab);
    }
  }

  async function closeTab(paneId: string, tabId: string, forcePinned = false) {
    const pane = panes.value.find((p) => p.id === paneId);
    if (!pane) return;
    const idx = pane.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const tab = pane.tabs[idx];
    if (tab.pinned && !forcePinned) {
      showToast("该标签页已固定，请先取消固定后再关闭");
      return;
    }

    if (tab.dirty && !tab.externalConflict && useSettingsStore().state.autoSaveEnabled) {
      await saveTab(tab.id, false);
    }

    const timer = autoSaveTimers.get(tab.id);
    if (timer) clearTimeout(timer);
    autoSaveTimers.delete(tab.id);

    selectedSplitTabIds.value = selectedSplitTabIds.value.filter((id) => id !== tabId);

    pane.tabs.splice(idx, 1);
    if (tab.kind === "terminal") {
      destroyTerminalInstance(tab.id);
    }
    if (pane.activeTabId === tabId) {
      const nextTab = pane.tabs[idx] ?? pane.tabs[idx - 1] ?? null;
      pane.activeTabId = nextTab?.id ?? null;
      if (nextTab && nextTab.kind !== "terminal") useWorkspaceStore().revealFileInTree(nextTab.path);
    }

    if (panes.value.length > 1 && pane.tabs.length === 0) closeSplitPane(pane.id);
  }

  function cycleTab(delta: 1 | -1) {
    const pane = activePane.value;
    if (!pane || pane.tabs.length < 2) return;
    const idx = pane.tabs.findIndex((t) => t.id === pane.activeTabId);
    if (idx === -1) return;
    const nextIdx = (idx + delta + pane.tabs.length) % pane.tabs.length;
    selectTab(pane.id, pane.tabs[nextIdx].id);
  }

  function collapseAllToSinglePane() {
    if (panes.value.length <= 1) {
      splitDirection.value = "none";
      return;
    }
    const primary = panes.value[0];
    const currentActivePath = activeTab.value ? normPath(activeTab.value.path) : null;

    for (let i = 1; i < panes.value.length; i++) {
      for (const tab of panes.value[i].tabs) {
        const exists = primary.tabs.some(
          (t) => t.kind === tab.kind && normPath(t.path) === normPath(tab.path)
        );
        if (!exists) {
          tab.paneId = primary.id;
          if (tab.kind !== "terminal") {
            tab.id = `${primary.id}::${tab.path}`;
          }
          if (tab.pinned) {
            const pCount = primary.tabs.filter((t) => t.pinned).length;
            primary.tabs.splice(pCount, 0, tab);
          } else {
            primary.tabs.push(tab);
          }
        } else if (tab.kind === "terminal") {
          destroyTerminalInstance(tab.id);
        }
      }
    }

    if (currentActivePath) {
      const matched = primary.tabs.find((t) => normPath(t.path) === currentActivePath);
      if (matched) primary.activeTabId = matched.id;
    } else if (!primary.activeTabId && primary.tabs.length > 0) {
      primary.activeTabId = primary.tabs[0].id;
    }

    panes.value = [primary];
    activePaneId.value = primary.id;
    splitDirection.value = "none";
    clearSplitSelection();
  }

  function toggleSplit(direction: "vertical" | "horizontal") {
    const label = direction === "vertical" ? "左右" : "上下";
    if (panes.value.length === 1) {
      // 1 -> 2 panes
      const newId = createPaneId();
      panes.value.push({ id: newId, tabs: [], activeTabId: null });
      splitDirection.value = direction;
      const cur = activeTab.value;
      if (cur) void openFile(cur.path, { paneId: newId, workspaceId: cur.workspaceId });
      activePaneId.value = newId;
    } else if (splitDirection.value !== direction) {
      // Switch orientation keeping existing panes
      splitDirection.value = direction;
    } else if (panes.value.length === 2) {
      // 2 -> 3 panes
      const newId = createPaneId();
      panes.value.push({ id: newId, tabs: [], activeTabId: null });
      const cur = activeTab.value;
      if (cur) void openFile(cur.path, { paneId: newId, workspaceId: cur.workspaceId });
      activePaneId.value = newId;
      showToast(`已切换为${label} 3 分栏视图`);
    } else {
      // 3 -> 1 single pane
      collapseAllToSinglePane();
      showToast("已恢复单栏视图");
    }
  }

  function splitTabToNewPane(sourcePaneId: string, tabId: string, side: "left" | "right" = "right") {
    if (panes.value.length >= 3) {
      showToast("最多支持 3 分栏同时显示");
      return;
    }
    const sourcePane = panes.value.find((p) => p.id === sourcePaneId);
    if (!sourcePane) return;
    const tabIdx = sourcePane.tabs.findIndex((t) => t.id === tabId);
    if (tabIdx === -1) return;

    const newId = createPaneId();
    let movedTab: OpenTab;
    if (sourcePane.tabs.length > 1) {
      [movedTab] = sourcePane.tabs.splice(tabIdx, 1);
      if (sourcePane.activeTabId === tabId) {
        const nextTab = sourcePane.tabs[tabIdx] ?? sourcePane.tabs[tabIdx - 1] ?? null;
        sourcePane.activeTabId = nextTab?.id ?? null;
      }
      movedTab.paneId = newId;
      if (movedTab.kind !== "terminal") {
        movedTab.id = `${newId}::${movedTab.path}`;
      }
    } else {
      // Clone reference if it's the only tab in the pane
      const orig = sourcePane.tabs[tabIdx];
      movedTab = {
        ...orig,
        paneId: newId,
        id: orig.kind === "terminal" ? `terminal::${normPath(orig.path)}::${Date.now()}` : `${newId}::${orig.path}`,
        pinned: false,
      };
    }

    const newPane: EditorPane = { id: newId, tabs: [movedTab], activeTabId: movedTab.id };
    const srcPaneIdx = panes.value.findIndex((p) => p.id === sourcePaneId);
    const insertIdx = side === "left" ? srcPaneIdx : srcPaneIdx + 1;
    panes.value.splice(insertIdx, 0, newPane);
    splitDirection.value = "vertical";
    activePaneId.value = newId;
    markDocumentPaneIfApplicable(newPane);
    clearSplitSelection();
    if (movedTab.kind !== "terminal") useWorkspaceStore().revealFileInTree(movedTab.path);
  }

  function moveTabToPane(sourcePaneId: string, tabId: string, targetPaneId: string, insertIndex?: number) {
    if (sourcePaneId === targetPaneId) return;
    const sourcePane = panes.value.find((p) => p.id === sourcePaneId);
    const targetPane = panes.value.find((p) => p.id === targetPaneId);
    if (!sourcePane || !targetPane) return;

    const srcIdx = sourcePane.tabs.findIndex((t) => t.id === tabId);
    if (srcIdx === -1) return;
    const [tab] = sourcePane.tabs.splice(srcIdx, 1);

    if (sourcePane.activeTabId === tabId) {
      const nextTab = sourcePane.tabs[srcIdx] ?? sourcePane.tabs[srcIdx - 1] ?? null;
      sourcePane.activeTabId = nextTab?.id ?? null;
    }

    const existingInTarget = targetPane.tabs.find(
      (t) => t.kind === tab.kind && normPath(t.path) === normPath(tab.path)
    );
    if (existingInTarget) {
      if (tab.kind === "terminal") destroyTerminalInstance(tab.id);
      targetPane.activeTabId = existingInTarget.id;
    } else {
      tab.paneId = targetPane.id;
      if (tab.kind !== "terminal") {
        tab.id = `${targetPane.id}::${tab.path}`;
      }
      const pinnedCount = targetPane.tabs.filter((t) => t.pinned).length;
      const clampedIdx =
        insertIndex !== undefined
          ? Math.max(tab.pinned ? 0 : pinnedCount, Math.min(targetPane.tabs.length, insertIndex))
          : tab.pinned
            ? pinnedCount
            : targetPane.tabs.length;
      targetPane.tabs.splice(clampedIdx, 0, tab);
      targetPane.activeTabId = tab.id;
    }

    activePaneId.value = targetPane.id;
    markDocumentPaneIfApplicable(targetPane);
    clearSplitSelection();
    if (sourcePane.tabs.length === 0 && panes.value.length > 1) {
      closeSplitPane(sourcePane.id);
    }
    if (tab.kind !== "terminal") useWorkspaceStore().revealFileInTree(tab.path);
  }

  function closeSplitPane(paneId: string) {
    if (panes.value.length <= 1) return;
    const idx = panes.value.findIndex((p) => p.id === paneId);
    if (idx === -1) return;
    const closing = panes.value[idx];
    const target = panes.value[idx > 0 ? idx - 1 : 1];

    for (const tab of closing.tabs) {
      const exists = target.tabs.some(
        (t) => t.kind === tab.kind && normPath(t.path) === normPath(tab.path)
      );
      if (!exists) {
        tab.paneId = target.id;
        if (tab.kind !== "terminal") {
          tab.id = `${target.id}::${tab.path}`;
        }
        if (tab.pinned) {
          const pCount = target.tabs.filter((t) => t.pinned).length;
          target.tabs.splice(pCount, 0, tab);
        } else {
          target.tabs.push(tab);
        }
      } else if (tab.kind === "terminal") {
        destroyTerminalInstance(tab.id);
      }
    }

    panes.value.splice(idx, 1);
    if (!target.activeTabId && target.tabs.length > 0) {
      target.activeTabId = target.tabs[0].id;
    }
    activePaneId.value = target.id;
    markDocumentPaneIfApplicable(target);
    if (panes.value.length <= 1) {
      splitDirection.value = "none";
    }
    clearSplitSelection();
  }

  function toggleActiveTabMode() {
    const tab = activeTab.value;
    if (!tab || (tab.kind !== "markdown" && tab.kind !== "html")) return;
    tab.editMode = tab.editMode === "live" ? "source" : "live";
  }

  function reorderTab(paneId: string, fromIndex: number, toIndex: number) {
    const pane = panes.value.find((p) => p.id === paneId);
    if (!pane) return;
    if (
      fromIndex === toIndex ||
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= pane.tabs.length ||
      toIndex >= pane.tabs.length
    ) {
      return;
    }
    const moving = pane.tabs[fromIndex];
    const pinnedCount = pane.tabs.filter((t) => t.pinned).length;
    // Keep pinned tabs strictly in [0, pinnedCount - 1] and unpinned in [pinnedCount, end]
    let clampedTo = toIndex;
    if (moving.pinned) {
      clampedTo = Math.max(0, Math.min(pinnedCount - 1, toIndex));
    } else {
      clampedTo = Math.max(pinnedCount, Math.min(pane.tabs.length - 1, toIndex));
    }
    if (fromIndex === clampedTo) return;
    const [moved] = pane.tabs.splice(fromIndex, 1);
    pane.tabs.splice(clampedTo, 0, moved);
  }

  async function closeOtherTabs(paneId: string, keepTabId: string) {
    const pane = panes.value.find((p) => p.id === paneId);
    if (!pane) return;
    for (const t of [...pane.tabs]) {
      if (t.id !== keepTabId && !t.pinned) {
        await closeTab(paneId, t.id);
      }
    }
  }

  async function closeAllTabs(paneId: string) {
    const pane = panes.value.find((p) => p.id === paneId);
    if (!pane) return;
    for (const t of [...pane.tabs]) {
      if (!t.pinned) {
        await closeTab(paneId, t.id);
      }
    }
  }

  function handlePathRenamed(oldPath: string, newPath: string) {
    const oldNorm = normPath(oldPath);
    for (const pane of panes.value) {
      for (const tab of pane.tabs) {
        if (tab.kind === "terminal") continue;
        const curNorm = normPath(tab.path);
        if (curNorm === oldNorm) {
          const wasActive = pane.activeTabId === tab.id;
          tab.path = newPath;
          tab.name = fileNameFromPath(newPath);
          tab.id = `${pane.id}::${newPath}`;
          if (wasActive) pane.activeTabId = tab.id;
        } else if (curNorm.startsWith(`${oldNorm}/`)) {
          const suffix = tab.path.slice(oldPath.length);
          const updated = `${newPath}${suffix}`;
          const wasActive = pane.activeTabId === tab.id;
          tab.path = updated;
          tab.id = `${pane.id}::${updated}`;
          if (wasActive) pane.activeTabId = tab.id;
        }
      }
    }
  }

  function handlePathDeleted(deletedPath: string) {
    const delNorm = normPath(deletedPath);
    for (const pane of panes.value) {
      for (const tab of [...pane.tabs]) {
        if (tab.kind === "terminal") continue;
        const curNorm = normPath(tab.path);
        if (curNorm === delNorm || curNorm.startsWith(`${delNorm}/`)) {
          if (!tab.dirty) void closeTab(pane.id, tab.id, true);
          else tab.externalConflict = { kind: "deleted" };
        }
      }
    }
  }

  async function checkRecoveryDrafts() {
    try {
      recoveryDrafts.value = await ipc.listRecoveryDrafts();
    } catch {
      recoveryDrafts.value = [];
    }
  }

  async function restoreRecoveryDraft(draft: RecoveryDraft) {
    const tab = await openFile(draft.path);
    if (tab) {
      tab.content = draft.content;
      tab.dirty = true;
      showToast(`已恢复未保存草稿: ${tab.name}`);
    }
    recoveryDrafts.value = recoveryDrafts.value.filter((d) => d.path !== draft.path);
    void ipc.deleteRecoveryDraft(draft.path).catch(() => {});
  }

  async function restoreLayout(layout: SavedWorkspaceLayout): Promise<void> {
    const rawPanes = Array.isArray(layout.panes) ? layout.panes.slice(0, 3) : [];
    const nonEmptyDefs = rawPanes.filter((p) => Array.isArray(p?.tabs) && p.tabs.length > 0);
    if (nonEmptyDefs.length === 0) return;

    const freshPanes: EditorPane[] = nonEmptyDefs.map((_p, idx) => ({
      id: idx === 0 ? "pane-1" : createPaneId(),
      tabs: [],
      activeTabId: null,
    }));

    panes.value = freshPanes;
    splitDirection.value =
      freshPanes.length > 1 && (layout.splitDirection === "vertical" || layout.splitDirection === "horizontal")
        ? layout.splitDirection
        : "none";
    activePaneId.value = freshPanes[0].id;

    for (let i = 0; i < nonEmptyDefs.length; i++) {
      const def = nonEmptyDefs[i];
      const pane = freshPanes[i];
      for (const entry of def.tabs) {
        if (!entry?.path) continue;
        await openFile(entry.path, {
          paneId: pane.id,
          workspaceId: entry.workspaceId,
          pinned: Boolean(entry.pinned),
          editMode: entry.editMode,
          silent: true,
        });
      }
      if (def.activePath) {
        const match = pane.tabs.find((t) => normPath(t.path) === normPath(def.activePath!));
        if (match) pane.activeTabId = match.id;
      }
    }

    // Prune panes whose files were all deleted externally
    const surviving = panes.value.filter((p) => p.tabs.length > 0);
    if (surviving.length === 0) {
      panes.value = [{ id: "pane-1", tabs: [], activeTabId: null }];
      splitDirection.value = "none";
      activePaneId.value = "pane-1";
      return;
    }

    panes.value = surviving;
    if (surviving.length <= 1) {
      splitDirection.value = "none";
    }
    const targetIdx = Math.max(0, Math.min(layout.activePaneIndex ?? 0, surviving.length - 1));
    const targetPane = surviving[targetIdx];
    activePaneId.value = targetPane.id;

    const targetTab = targetPane.tabs.find((t) => t.id === targetPane.activeTabId);
    if (targetTab) {
      const wsStore = useWorkspaceStore();
      wsStore.revealFileInTree(targetTab.path);
    }
  }

  async function discardRecoveryDraft(draft: RecoveryDraft) {
    recoveryDrafts.value = recoveryDrafts.value.filter((d) => d.path !== draft.path);
    await ipc.deleteRecoveryDraft(draft.path).catch(() => {});
  }

  return {
    panes,
    activePaneId,
    activePane,
    activeTab,
    allOpenTabs,
    splitDirection,
    selectedSplitTabIds,
    selectedSplitPaneId,
    recentFiles,
    recoveryDrafts,
    toastMessage,
    diffState,
    historyModalTabId,
    openHistoryModal,
    closeHistoryModal,
    restoreTabFromHistory,
    showToast,
    getDisplayTabTitle,
    clearSplitSelection,
    toggleSplitTabSelection,
    mergeSelectedTabsToColumns,
    resolveTargetPaneForDocument,
    openFile,
    restoreLayout,
    openTerminalForWorkspace,
    updateTabContent,
    saveTab,
    handleExternalFileEvent,
    reloadTabFromDisk,
    keepLocalAndOverwrite,
    openConflictDiff,
    openFilesDiff,
    diffSelectedTabs,
    closeDiff,
    focusPaneAndReveal,
    selectTab,
    togglePinTab,
    closeTab,
    closeOtherTabs,
    closeAllTabs,
    reorderTab,
    cycleTab,
    toggleSplit,
    collapseAllToSinglePane,
    splitTabToNewPane,
    moveTabToPane,
    closeSplitPane,
    toggleActiveTabMode,
    handlePathRenamed,
    handlePathDeleted,
    checkRecoveryDrafts,
    restoreRecoveryDraft,
    discardRecoveryDraft,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTabsStore, import.meta.hot));
}
