<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RotateCcw, X } from "lucide-vue-next";
import Sidebar from "@/components/Sidebar.vue";
import EditorPaneView from "@/components/EditorPaneView.vue";
import SettingsModal from "@/components/SettingsModal.vue";
import QuickOpenModal from "@/components/QuickOpenModal.vue";
import DiffModal from "@/components/DiffModal.vue";
import HistoryModal from "@/components/HistoryModal.vue";
import GlobalTooltip from "@/components/GlobalTooltip.vue";
import { tabDragState } from "@/core/ui/tabDrag";
import { ipc, isTauriRuntime, parseIpcError } from "@/core/ipc/client";
import { getEffectiveShortcuts, matchesCombo } from "@/core/shortcuts/keymap";
import { MouseGestureController } from "@/core/gestures/mouseGestures";
import { buildStandaloneHtmlDocument, printMarkdownToPdf } from "@/core/export/exporter";
import { checkGithubUpdate } from "@/core/update/updater";
import { useSettingsStore, registerConfigPersistHook } from "@/stores/settings";
import { useWorkspaceStore, isValidSortOrder, type SortOrder } from "@/stores/workspace";
import { useTabsStore, type SavedWorkspaceLayout } from "@/stores/tabs";
import { destroyAllTerminalInstances } from "@/core/terminal/terminalRegistry";
import { useI18n } from "@/core/i18n";
import type { UnlistenFn } from "@tauri-apps/api/event";

const { t } = useI18n();

const settings = useSettingsStore();
const wsStore = useWorkspaceStore();
const tabsStore = useTabsStore();

const sidebarVisible = ref(true);
const sidebarHovered = ref(false);
const isPointerInsideSidebar = ref(false);
let sidebarHideTimer: ReturnType<typeof setTimeout> | null = null;
const settingsOpen = ref(false);
const quickOpenVisible = ref(false);
const lightbox = ref<{ src: string; alt: string } | null>(null);
const sidebarRef = ref<InstanceType<typeof Sidebar> | null>(null);
const paneRefs = ref<Record<string, InstanceType<typeof EditorPaneView> | null>>({});
const panesContainerRef = ref<HTMLElement | null>(null);

// Resizable split pane percentages (always sum to 100)
const paneSizes = ref<number[]>([100]);
const isResizingPanes = ref(false);
let resizePaneIdx = -1;
let resizeStartPos = 0;
let resizeStartA = 50;
let resizeStartB = 50;
let resizeContainerTotal = 1;

let isHydrating = false;
let configPersistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersistConfig() {
  if (isHydrating) return;
  if (configPersistTimer) clearTimeout(configPersistTimer);
  configPersistTimer = setTimeout(() => {
    void persistFullConfig();
  }, 300);
}

function resetPaneSizes() {
  const n = Math.max(1, tabsStore.panes.length);
  paneSizes.value = Array.from({ length: n }, () => 100 / n);
}

watch(
  () => [
    wsStore.workspaces
      .map((w) => `${w.id}:${w.name}:${w.rootPath}:${w.collapsed}:${w.sortOrder ?? ""}`)
      .join("|"),
    wsStore.sortOrder,
    JSON.stringify(wsStore.folderSortOrders),
    JSON.stringify(wsStore.manualOrders),
    tabsStore.splitDirection,
    tabsStore.activePaneId,
    paneSizes.value.map((n) => Math.round(n * 10)).join(","),
    tabsStore.panes
      .map(
        (p) =>
          `${p.id}:${p.activeTabId ?? ""}:${p.tabs
            .filter((t) => t.kind !== "terminal")
            .map((t) => `${t.path}@${t.pinned ? 1 : 0}@${t.editMode}`)
            .join(",")}`
      )
      .join("||"),
  ],
  () => {
    schedulePersistConfig();
  }
);

watch(
  () => [tabsStore.panes.length, tabsStore.splitDirection],
  () => {
    if (paneSizes.value.length !== Math.max(1, tabsStore.panes.length)) {
      resetPaneSizes();
    }
  },
  { immediate: true }
);

function startPaneResize(dividerIdx: number, e: MouseEvent) {
  e.preventDefault();
  const container = panesContainerRef.value;
  if (!container) return;
  const rect = container.getBoundingClientRect();
  const isHoriz = tabsStore.splitDirection === "horizontal";

  isResizingPanes.value = true;
  resizePaneIdx = dividerIdx;
  resizeStartPos = isHoriz ? e.clientY : e.clientX;
  resizeContainerTotal = Math.max(1, isHoriz ? rect.height : rect.width);
  resizeStartA = paneSizes.value[dividerIdx] ?? 100 / tabsStore.panes.length;
  resizeStartB = paneSizes.value[dividerIdx + 1] ?? 100 / tabsStore.panes.length;

  window.addEventListener("mousemove", onPaneResizeMove);
  window.addEventListener("mouseup", stopPaneResize);
}

function onPaneResizeMove(e: MouseEvent) {
  if (!isResizingPanes.value || resizePaneIdx < 0) return;
  const isHoriz = tabsStore.splitDirection === "horizontal";
  const curPos = isHoriz ? e.clientY : e.clientX;
  const deltaPct = ((curPos - resizeStartPos) / resizeContainerTotal) * 100;

  const minPct = 15;
  const combined = resizeStartA + resizeStartB;
  const nextA = Math.max(minPct, Math.min(combined - minPct, resizeStartA + deltaPct));
  const nextB = combined - nextA;

  const next = [...paneSizes.value];
  next[resizePaneIdx] = nextA;
  next[resizePaneIdx + 1] = nextB;
  paneSizes.value = next;
}

function stopPaneResize() {
  isResizingPanes.value = false;
  resizePaneIdx = -1;
  window.removeEventListener("mousemove", onPaneResizeMove);
  window.removeEventListener("mouseup", stopPaneResize);
}

function isSidebarInputFocused(): boolean {
  const active = document.activeElement as HTMLElement | null;
  if (!active || !active.closest(".sidebar-slot")) return false;
  const tag = active.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || active.isContentEditable;
}

function openAutoHideSidebar() {
  if (sidebarHideTimer) {
    clearTimeout(sidebarHideTimer);
    sidebarHideTimer = null;
  }
  sidebarHovered.value = true;
}

function scheduleAutoHideSidebar() {
  if (!settings.state.sidebarAutoHide) return;
  if (sidebarHideTimer) clearTimeout(sidebarHideTimer);
  sidebarHideTimer = setTimeout(() => {
    // Only keep open if user is actively typing inside a sidebar input/select (not a clicked button)
    if (isSidebarInputFocused()) return;
    sidebarHovered.value = false;
  }, 180);
}

function handleSidebarEnter() {
  isPointerInsideSidebar.value = true;
  openAutoHideSidebar();
}

function handleSidebarLeave() {
  isPointerInsideSidebar.value = false;
  scheduleAutoHideSidebar();
}

function handleSidebarFocusOut() {
  if (!settings.state.sidebarAutoHide) return;
  setTimeout(() => {
    if (!isPointerInsideSidebar.value && !isSidebarInputFocused()) {
      scheduleAutoHideSidebar();
    }
  }, 0);
}

function handleAutoHideChanged(enabled: boolean) {
  if (sidebarHideTimer) {
    clearTimeout(sidebarHideTimer);
    sidebarHideTimer = null;
  }
  if (enabled) {
    // Keep drawer open while cursor is still inside; the moment mouse leaves, it hides immediately without any extra click
    sidebarHovered.value = true;
    isPointerInsideSidebar.value = true;
  } else {
    sidebarHovered.value = false;
  }
}

let resizingSidebar = false;
let unlistenExternal: UnlistenFn | null = null;
let unlistenTree: UnlistenFn | null = null;
let treeRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let gestureCtrl: MouseGestureController | null = null;

function setPaneRef(id: string, el: unknown) {
  paneRefs.value[id] = el as InstanceType<typeof EditorPaneView> | null;
}

async function persistFullConfig() {
  if (!isTauriRuntime() || isHydrating) return;
  try {
    const serializablePanes = tabsStore.panes
      .map((pane) => {
        const tabs = pane.tabs
          .filter((t) => t.kind !== "terminal")
          .map((t) => ({
            path: t.path,
            workspaceId: t.workspaceId,
            pinned: t.pinned,
            editMode: t.editMode,
          }));
        const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId && t.kind !== "terminal");
        return {
          activePath: activeTab?.path ?? tabs[tabs.length - 1]?.path ?? null,
          tabs,
        };
      })
      .filter((p) => p.tabs.length > 0);

    const activePaneIdx = Math.max(
      0,
      tabsStore.panes.findIndex((p) => p.id === tabsStore.activePaneId)
    );

    const workspaceLayout: SavedWorkspaceLayout = {
      splitDirection: serializablePanes.length > 1 ? tabsStore.splitDirection : "none",
      activePaneIndex: Math.min(activePaneIdx, Math.max(0, serializablePanes.length - 1)),
      paneSizes:
        serializablePanes.length === paneSizes.value.length ? [...paneSizes.value] : undefined,
      panes: serializablePanes,
    };

    await ipc.saveAppConfig({
      settings: {
        ...settings.state,
        customColors: { ...settings.state.customColors },
        customThemes: settings.state.customThemes.map((t) => ({
          ...t,
          swatches: [...t.swatches],
        })),
        customShortcuts: { ...settings.state.customShortcuts },
        customGestures: settings.state.customGestures.map((g) => ({ ...g })),
      },
      workspaces: wsStore.workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        rootPath: w.rootPath,
        collapsed: w.collapsed,
        ...(w.sortOrder ? { sortOrder: w.sortOrder } : {}),
      })),
      sortOrder: wsStore.sortOrder,
      folderSortOrders: { ...wsStore.folderSortOrders },
      manualOrders: Object.fromEntries(
        Object.entries(wsStore.manualOrders).map(([k, v]) => [k, [...v]])
      ),
      recentFiles: tabsStore.recentFiles,
      workspaceLayout,
      openPaths: serializablePanes[0]?.tabs ?? [],
    });
  } catch (err) {
    console.warn("Config save skipped:", err);
  }
}

async function hydrateApp() {
  if (!isTauriRuntime()) return;
  isHydrating = true;
  try {
    const saved = await ipc.loadAppConfig();
    if (saved) {
      if (saved.settings && typeof saved.settings === "object") {
        settings.hydrate(saved.settings as Record<string, unknown>);
      }
      if (isValidSortOrder(saved.sortOrder)) {
        wsStore.sortOrder = saved.sortOrder as SortOrder;
      }
      wsStore.hydrateSortPreferences(
        saved.folderSortOrders as Record<string, unknown> | undefined,
        saved.manualOrders as Record<string, unknown> | undefined
      );
      if (Array.isArray(saved.recentFiles)) {
        tabsStore.recentFiles = saved.recentFiles as typeof tabsStore.recentFiles;
      }
      if (Array.isArray(saved.workspaces) && saved.workspaces.length > 0) {
        await wsStore.hydrateWorkspaces(
          saved.workspaces as Array<{
            id: string;
            name: string;
            rootPath: string;
            collapsed?: boolean;
            sortOrder?: unknown;
          }>
        );
      }
      const savedLayout = saved.workspaceLayout as SavedWorkspaceLayout | undefined;
      if (savedLayout && Array.isArray(savedLayout.panes) && savedLayout.panes.length > 0) {
        await tabsStore.restoreLayout(savedLayout);
        if (
          Array.isArray(savedLayout.paneSizes) &&
          savedLayout.paneSizes.length === tabsStore.panes.length
        ) {
          paneSizes.value = [...savedLayout.paneSizes];
        } else {
          resetPaneSizes();
        }
      } else if (Array.isArray(saved.openPaths)) {
        for (const entry of saved.openPaths as Array<{
          path: string;
          workspaceId?: string;
          pinned?: boolean;
          editMode?: "live" | "source";
        }>) {
          if (entry?.path) {
            await tabsStore.openFile(entry.path, {
              workspaceId: entry.workspaceId,
              pinned: Boolean(entry.pinned),
              editMode: entry.editMode,
              silent: true,
            });
          }
        }
      }
    }
    await tabsStore.checkRecoveryDrafts();
  } catch (err) {
    console.error("Failed to hydrate config:", err);
  } finally {
    isHydrating = false;
  }
}

async function handleExportHtml(tabId?: string) {
  const tab = tabId ? tabsStore.allOpenTabs.find((t) => t.id === tabId) : tabsStore.activeTab;
  if (!tab || tab.kind !== "markdown") {
    tabsStore.showToast(t("app.needMarkdownDoc"));
    return;
  }
  const defaultName = tab.name.replace(/\.[^.]+$/, "") + ".html";
  const target = await ipc.pickSaveHtmlDialog(defaultName);
  if (!target) return;
  try {
    const html = await buildStandaloneHtmlDocument(
      tab.name.replace(/\.[^.]+$/, ""),
      tab.content,
      tab.path,
      true
    );
    await ipc.exportHtmlFile(target, html);
    tabsStore.showToast(t("app.exportedHtml", { path: target }));
  } catch (err) {
    tabsStore.showToast(t("app.exportHtmlFailed", { msg: parseIpcError(err).message }), 3500);
  }
}

async function handleExportPdf(tabId?: string) {
  const tab = tabId ? tabsStore.allOpenTabs.find((t) => t.id === tabId) : tabsStore.activeTab;
  if (!tab || tab.kind !== "markdown") {
    tabsStore.showToast(t("app.needMarkdownDoc"));
    return;
  }
  try {
    await printMarkdownToPdf(tab.name.replace(/\.[^.]+$/, ""), tab.content, tab.path);
  } catch (err) {
    tabsStore.showToast(t("app.exportPdfFailed", { msg: parseIpcError(err).message }));
  }
}

async function handleQuickNewNote() {
  const firstWs = wsStore.workspaces[0];
  if (!firstWs) {
    await wsStore.pickAndAddWorkspace();
    return;
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const baseTitle = t("app.untitledNote");
  const name = `${baseTitle}-${stamp}.md`;
  try {
    const created = await ipc.createFile(firstWs.rootPath, name, `# ${baseTitle}\n\n`);
    await wsStore.refreshWorkspace(firstWs.id);
    await tabsStore.openFile(created, { workspaceId: firstWs.id });
  } catch (err) {
    tabsStore.showToast(t("app.newNoteFailed", { msg: parseIpcError(err).message }));
  }
}

function handleGlobalKeydown(e: KeyboardEvent) {
  // Pause global shortcuts while SettingsModal is open (e.g., recording a new shortcut)
  if (settingsOpen.value) return;

  const activeBindings = getEffectiveShortcuts(settings.state.customShortcuts);
  for (const s of activeBindings) {
    if (!matchesCombo(e, s.combo)) continue;
    e.preventDefault();
    switch (s.id) {
      case "save":
        if (tabsStore.activeTab) void tabsStore.saveTab(tabsStore.activeTab.id, false, true);
        break;
      case "newNote":
        void handleQuickNewNote();
        break;
      case "closeTab":
        if (tabsStore.activeTab) void tabsStore.closeTab(tabsStore.activeTab.paneId, tabsStore.activeTab.id);
        break;
      case "quickOpen":
        quickOpenVisible.value = true;
        break;
      case "globalSearch":
        sidebarVisible.value = true;
        if (settings.state.sidebarAutoHide) openAutoHideSidebar();
        sidebarRef.value?.focusGlobalSearch();
        break;
      case "toggleMode":
        tabsStore.toggleActiveTabMode();
        break;
      case "toggleSidebar":
        sidebarVisible.value = !sidebarVisible.value;
        break;
      case "toggleOutline":
        settings.state.showOutline = !settings.state.showOutline;
        break;
      case "toggleMinimap":
        settings.state.showMinimap = !settings.state.showMinimap;
        break;
      case "toggleAttachments":
        settings.state.showAttachmentsBar = !settings.state.showAttachmentsBar;
        break;
      case "splitRight":
        tabsStore.toggleSplit("vertical");
        break;
      case "splitDown":
        tabsStore.toggleSplit("horizontal");
        break;
      case "openSettings":
        settingsOpen.value = true;
        break;
      case "exportHtml":
        void handleExportHtml();
        break;
      case "exportPdf":
        void handleExportPdf();
        break;
    }
    return;
  }
}

function startSidebarResize() {
  resizingSidebar = true;
  window.addEventListener("mousemove", onSidebarResize);
  window.addEventListener("mouseup", stopSidebarResize);
}
function onSidebarResize(e: MouseEvent) {
  if (resizingSidebar) settings.state.sidebarWidth = Math.max(190, Math.min(460, e.clientX));
}
function stopSidebarResize() {
  resizingSidebar = false;
  window.removeEventListener("mousemove", onSidebarResize);
  window.removeEventListener("mouseup", stopSidebarResize);
}

onMounted(async () => {
  registerConfigPersistHook(() => void persistFullConfig());
  window.addEventListener("keydown", handleGlobalKeydown);
  window.addEventListener("beforeunload", () => void persistFullConfig());

  gestureCtrl = new MouseGestureController({
    isEnabled: () => settings.state.mouseGesturesEnabled && !settingsOpen.value,
    getGestures: () => settings.state.customGestures,
    onAction: (action) => {
      const paneView = paneRefs.value[tabsStore.activePaneId];
      switch (action) {
        case "prevTab":
          tabsStore.cycleTab(-1);
          break;
        case "nextTab":
          tabsStore.cycleTab(1);
          break;
        case "closeTab":
          if (tabsStore.activeTab) void tabsStore.closeTab(tabsStore.activeTab.paneId, tabsStore.activeTab.id);
          break;
        case "scrollTop":
          paneView?.scrollTop();
          break;
        case "scrollBottom":
          paneView?.scrollBottom();
          break;
        case "toggleMode":
          tabsStore.toggleActiveTabMode();
          break;
        case "toggleSidebar":
          sidebarVisible.value = !sidebarVisible.value;
          break;
        case "newNote":
          void handleQuickNewNote();
          break;
        case "quickOpen":
          quickOpenVisible.value = true;
          break;
      }
    },
  });
  gestureCtrl.mount();

  if (isTauriRuntime()) {
    const pendingTreePaths = new Set<string>();
    unlistenExternal = await ipc.onExternalFileChanged((ev) => void tabsStore.handleExternalFileEvent(ev));
    unlistenTree = await ipc.onTreeChanged((ev) => {
      for (const p of ev.paths ?? []) pendingTreePaths.add(p);
      if (treeRefreshTimer) clearTimeout(treeRefreshTimer);
      treeRefreshTimer = setTimeout(() => {
        const batch = Array.from(pendingTreePaths);
        pendingTreePaths.clear();
        if (batch.length > 0) {
          void wsStore.refreshWorkspacesForPaths(batch);
        } else {
          void wsStore.refreshAll();
        }
      }, 350);
    });
  }

  await hydrateApp();
  await nextTick();
  if (isTauriRuntime()) {
    // Use a fast timer fallback alongside rAF because hidden Windows WebView2
    // windows may throttle requestAnimationFrame before first show().
    let shown = false;
    const revealWindow = () => {
      if (shown) return;
      shown = true;
      void ipc.showMainWindow().catch(() => {});
    };
    requestAnimationFrame(() => requestAnimationFrame(revealWindow));
    setTimeout(revealWindow, 50);
  }

  if (settings.state.autoCheckUpdates) {
    void checkGithubUpdate().then((res) => {
      if (res.status === "update-available" && res.latestVersion) {
        tabsStore.showToast(
          t("app.updateAvailableToast", { version: res.latestVersion }),
          5000
        );
      }
    });
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleGlobalKeydown);
  gestureCtrl?.unmount();
  unlistenExternal?.();
  unlistenTree?.();
  destroyAllTerminalInstances();
  void persistFullConfig();
});
</script>

<template>
  <div class="app-shell">
    <!-- Crash Recovery Startup Banner (only visible when drafts exist) -->
    <div v-if="tabsStore.recoveryDrafts.length > 0" class="recovery-bar">
      <div class="recovery-info">
        <RotateCcw :size="14" />
        <span>{{ t("app.recoveryBanner", { count: tabsStore.recoveryDrafts.length }) }}</span>
        <strong>{{ tabsStore.recoveryDrafts[0].path.split(/[\\/]/).pop() }}</strong>
      </div>
      <div class="recovery-actions">
        <button class="rec-btn primary" @click="tabsStore.restoreRecoveryDraft(tabsStore.recoveryDrafts[0])">{{ t("app.restoreDraft") }}</button>
        <button class="rec-btn" @click="tabsStore.discardRecoveryDraft(tabsStore.recoveryDrafts[0])">{{ t("app.discardDraft") }}</button>
      </div>
    </div>

    <!-- Clean Obsidian-style Full-Height Split Layout: Sidebar (pinned or auto-hide drawer) + Top TabBar Editor Panes -->
    <div class="app-body">
      <!-- Invisible 10px left-edge hot zone for Auto-Hide sidebar reveal -->
      <div
        v-if="sidebarVisible && settings.state.sidebarAutoHide && !sidebarHovered"
        class="sidebar-hotzone"
        @mouseenter="openAutoHideSidebar"
      />

      <div
        v-show="sidebarVisible"
        class="sidebar-slot"
        :class="{
          'is-autohide': settings.state.sidebarAutoHide,
          'is-revealed': sidebarHovered,
        }"
        :style="{ width: `${settings.state.sidebarWidth}px` }"
        @mouseenter="handleSidebarEnter"
        @mouseleave="handleSidebarLeave"
        @focusout="handleSidebarFocusOut"
      >
        <Sidebar
          ref="sidebarRef"
          @open-settings="settingsOpen = true"
          @collapse-sidebar="sidebarVisible = false; sidebarHovered = false"
          @autohide-changed="handleAutoHideChanged"
        />
      </div>

      <div
        v-show="sidebarVisible && !settings.state.sidebarAutoHide"
        class="resizer-v"
        @mousedown="startSidebarResize"
      />

      <main
        ref="panesContainerRef"
        class="panes-container"
        :class="{
          'split-vertical': tabsStore.splitDirection === 'vertical',
          'split-horizontal': tabsStore.splitDirection === 'horizontal',
          'is-resizing-panes': isResizingPanes,
        }"
      >
        <template v-for="(pane, idx) in tabsStore.panes" :key="pane.id">
          <div
            class="pane-slot"
            :style="{ flex: `${paneSizes[idx] ?? 100 / tabsStore.panes.length} 1 0%` }"
          >
            <EditorPaneView
              :ref="(el) => setPaneRef(pane.id, el)"
              :pane="pane"
              :is-active-pane="tabsStore.activePaneId === pane.id"
              :show-expand-sidebar-btn="(!sidebarVisible || settings.state.sidebarAutoHide) && idx === 0"
              :show-window-controls="
                tabsStore.splitDirection === 'horizontal'
                  ? idx === 0
                  : idx === tabsStore.panes.length - 1
              "
              @expand-sidebar="
                sidebarVisible = true;
                if (settings.state.sidebarAutoHide) openAutoHideSidebar();
              "
              @export-html="handleExportHtml"
              @export-pdf="handleExportPdf"
              @image-lightbox="(p) => (lightbox = p)"
            />
          </div>
          <div
            v-if="idx < tabsStore.panes.length - 1"
            class="pane-resizer"
            :class="tabsStore.splitDirection === 'horizontal' ? 'is-horizontal' : 'is-vertical'"
            :data-tip="t('app.paneResizeTip')"
            @mousedown="startPaneResize(idx, $event)"
            @dblclick="resetPaneSizes"
          />
        </template>
      </main>
    </div>

    <SettingsModal :open="settingsOpen" @close="settingsOpen = false; persistFullConfig()" />
    <QuickOpenModal :open="quickOpenVisible" @close="quickOpenVisible = false" />
    <DiffModal />
    <HistoryModal />
    <GlobalTooltip />

    <Teleport to="body">
      <div v-if="lightbox" class="lightbox-overlay" @click="lightbox = null">
        <button class="lightbox-close" @click="lightbox = null"><X :size="20" /></button>
        <img :src="lightbox.src" :alt="lightbox.alt" class="lightbox-img" @click.stop />
        <div v-if="lightbox.alt" class="lightbox-caption">{{ lightbox.alt }}</div>
      </div>

      <Transition name="toast">
        <div v-if="tabsStore.toastMessage" class="toast-pill">{{ tabsStore.toastMessage }}</div>
      </Transition>

      <!-- Floating Tab Drag Ghost (pure pointer drag, 100% immune to WebView2 DnD issues) -->
      <div
        v-if="tabDragState.active"
        class="tab-drag-ghost"
        :style="{ left: `${tabDragState.clientX + 12}px`, top: `${tabDragState.clientY + 10}px` }"
      >
        {{ tabDragState.title }}
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.app-shell {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-base);
}

.recovery-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 14px;
  background: var(--bg-base);
  border-bottom: 1px solid var(--border-color);
  font-size: 12.5px;
}
.recovery-info {
  display: flex;
  align-items: center;
  gap: 7px;
}
.recovery-actions {
  display: flex;
  gap: 6px;
}
.rec-btn {
  padding: 4px 11px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  font-size: 12px;
  cursor: pointer;
}
.rec-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.app-body {
  flex: 1;
  display: flex;
  min-height: 0;
  overflow: hidden;
  position: relative;
}
.sidebar-hotzone {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  width: 10px;
  z-index: 1200;
}
.sidebar-slot {
  flex-shrink: 0;
  height: 100%;
  overflow: hidden;
}
.sidebar-slot.is-autohide {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  z-index: 1300;
  transform: translateX(-100%);
  transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.2s ease;
  pointer-events: none;
}
.sidebar-slot.is-autohide.is-revealed {
  transform: translateX(0);
  box-shadow: 6px 0 24px rgba(15, 23, 42, 0.16);
  pointer-events: auto;
}
.resizer-v {
  width: 6px;
  margin-left: -3px;
  margin-right: -3px;
  position: relative;
  z-index: 20;
  cursor: col-resize;
  background: transparent;
  flex-shrink: 0;
}
.resizer-v::after {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: 2px;
  width: 2px;
  background: transparent;
  transition: background 0.14s;
}
.resizer-v:hover::after {
  background: var(--accent);
}

.panes-container {
  flex: 1;
  display: flex;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.panes-container.split-vertical {
  flex-direction: row;
}
.panes-container.split-horizontal {
  flex-direction: column;
}
.pane-slot {
  display: flex;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.panes-container.is-resizing-panes :deep(iframe) {
  pointer-events: none;
}
.pane-resizer {
  flex-shrink: 0;
  background: var(--border-color);
  position: relative;
  transition: background 0.14s;
  z-index: 20;
}
.pane-resizer.is-vertical {
  width: 4px;
  cursor: col-resize;
}
.pane-resizer.is-horizontal {
  height: 4px;
  cursor: row-resize;
}
.pane-resizer:hover,
.panes-container.is-resizing-panes .pane-resizer:active {
  background: var(--accent);
}
.tab-drag-ghost {
  position: fixed;
  z-index: 9500;
  pointer-events: none;
  padding: 5px 12px;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  border: 1px solid var(--accent);
  color: var(--text-primary);
  font-size: 12.5px;
  font-weight: 600;
  box-shadow: var(--shadow-md);
  opacity: 0.94;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lightbox-overlay {
  position: fixed;
  inset: 0;
  background: rgba(10, 14, 24, 0.85);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  z-index: 4000;
  padding: 28px;
}
.lightbox-img {
  max-width: 92vw;
  max-height: 84vh;
  border-radius: 8px;
  object-fit: contain;
}
.lightbox-caption {
  color: #e2e8f0;
  font-size: 13px;
}
.lightbox-close {
  position: fixed;
  top: 18px;
  right: 22px;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.toast-pill {
  position: fixed;
  bottom: 34px;
  left: 50%;
  transform: translateX(-50%);
  padding: 8px 18px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.9);
  color: #ffffff;
  font-size: 13px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
  z-index: 4100;
  pointer-events: none;
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 8px);
}
</style>
