<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  X,
  Eye,
  Code2,
  Sun,
  Moon,
  List,
  Map as MapIcon,
  Paperclip,
  Columns2,
  Rows2,
  Download,
  Printer,
  AlertTriangle,
  GitCompare,
  FolderOpen,
  FileText,
  Image as ImageIcon,
  PanelLeftOpen,
  Minus,
  Square,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ExternalLink,
  Pin,
  PinOff,
  Check,
  Terminal as TerminalIcon,
} from "lucide-vue-next";
import MarkdownEditor from "./MarkdownEditor.vue";
import MarkdownPreviewPane from "./MarkdownPreviewPane.vue";
import TerminalPane from "./TerminalPane.vue";
import OutlinePanel from "./OutlinePanel.vue";
import AttachmentBar from "./AttachmentBar.vue";
import { toAssetUrl, ipc, isTauriRuntime } from "@/core/ipc/client";
import type { HeadingItem } from "@/core/markdown/outline";
import { tabDragState, resetTabDragState } from "@/core/ui/tabDrag";
import { useTabsStore, type EditorPane, type OpenTab } from "@/stores/tabs";
import { useSettingsStore } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";

const props = defineProps<{
  pane: EditorPane;
  isActivePane: boolean;
  showExpandSidebarBtn?: boolean;
  showWindowControls?: boolean;
}>();

const emit = defineEmits<{
  (e: "export-html", tabId: string): void;
  (e: "export-pdf", tabId: string): void;
  (e: "image-lightbox", payload: { src: string; alt: string }): void;
  (e: "expand-sidebar"): void;
}>();

const tabsStore = useTabsStore();
const settings = useSettingsStore();
const wsStore = useWorkspaceStore();

const editorRef = ref<InstanceType<typeof MarkdownEditor> | null>(null);
const tabStripRef = ref<HTMLDivElement | null>(null);
const editorSplitRef = ref<HTMLDivElement | null>(null);
const headings = ref<HeadingItem[]>([]);
const cursorInfo = ref({ line: 1, col: 1, words: 0, chars: 0 });
const editorScrollRatio = ref(0);

// Independent Source + Preview internal splitter ratio (percentage for left source editor)
const sourceSplitPct = ref(50);
let resizingSourceSplit = false;

// Tab strip overflow state
const canScrollLeft = ref(false);
const canScrollRight = ref(false);
const tabListMenuOpen = ref(false);
let stripResizeObserver: ResizeObserver | null = null;

// Pure pointer-based tab drag tracking (avoids Tauri WebView2 HTML5 DnD interception!)
let pendingDrag: {
  paneId: string;
  tabId: string;
  index: number;
  title: string;
  startX: number;
  startY: number;
} | null = null;
let suppressNextTabClick = false;

// Tab right-click context menu
const tabCtx = reactive<{
  visible: boolean;
  x: number;
  y: number;
  tab: OpenTab | null;
}>({
  visible: false,
  x: 0,
  y: 0,
  tab: null,
});

const activeTab = computed(() => {
  if (!props.pane.activeTabId) return null;
  return props.pane.tabs.find((t) => t.id === props.pane.activeTabId) ?? null;
});

const isDarkAppearance = computed(() => {
  if (settings.state.appearance === "dark") return true;
  if (settings.state.appearance === "light") return false;
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
});

function toggleLightDark() {
  settings.state.appearance = isDarkAppearance.value ? "light" : "dark";
}

const isSplitSelectionInThisPane = computed(
  () =>
    tabsStore.selectedSplitPaneId === props.pane.id &&
    tabsStore.selectedSplitTabIds.length >= 2
);

const activeBodyDropZone = computed(() =>
  tabDragState.active && tabDragState.bodyPaneId === props.pane.id
    ? tabDragState.bodyZone
    : null
);

function getSplitSelectionOrder(tabId: string): number {
  if (tabsStore.selectedSplitPaneId !== props.pane.id) return 0;
  const idx = tabsStore.selectedSplitTabIds.indexOf(tabId);
  return idx >= 0 ? idx + 1 : 0;
}

function isTabDropBefore(idx: number): boolean {
  return (
    tabDragState.active &&
    tabDragState.hoverPaneId === props.pane.id &&
    tabDragState.hoverTabIndex === idx &&
    tabDragState.hoverSide === "before"
  );
}

function isTabDropAfter(idx: number): boolean {
  return (
    tabDragState.active &&
    tabDragState.hoverPaneId === props.pane.id &&
    tabDragState.hoverTabIndex === idx &&
    tabDragState.hoverSide === "after"
  );
}

const htmlSrcDoc = computed(() => {
  const tab = activeTab.value;
  if (!tab || tab.kind !== "html" || !tab.dirty) return undefined;
  const baseDirUrl = toAssetUrl(tab.path.replace(/[^\\/]+$/, ""));
  const baseTag = `<base href="${baseDirUrl.endsWith("/") ? baseDirUrl : `${baseDirUrl}/`}" />`;
  if (/<head[^>]*>/i.test(tab.content)) {
    return tab.content.replace(/<head[^>]*>/i, (m) => `${m}\n${baseTag}`);
  }
  return `${baseTag}\n${tab.content}`;
});

function updateTabOverflow() {
  const el = tabStripRef.value;
  if (!el) return;
  canScrollLeft.value = el.scrollLeft > 2;
  canScrollRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
}

function scrollTabsBy(delta: number) {
  tabStripRef.value?.scrollBy({ left: delta, behavior: "smooth" });
}

function onTabStripWheel(e: WheelEvent) {
  const el = tabStripRef.value;
  if (!el) return;
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    e.preventDefault();
    el.scrollLeft += e.deltaY;
    updateTabOverflow();
  }
}

function scrollActiveTabIntoView() {
  nextTick(() => {
    const el = tabStripRef.value;
    if (!el) return;
    const activeEl = el.querySelector(".tab-item.active") as HTMLElement | null;
    activeEl?.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
    updateTabOverflow();
  });
}

function handleTabClick(tab: OpenTab, e: MouseEvent) {
  if (suppressNextTabClick) {
    suppressNextTabClick = false;
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    tabsStore.toggleSplitTabSelection(props.pane.id, tab.id);
    return;
  }
  if (tabsStore.selectedSplitTabIds.length > 0) {
    tabsStore.clearSplitSelection();
  }
  tabsStore.selectTab(props.pane.id, tab.id);
}

function openTabContextMenu(tab: OpenTab, e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
  tabCtx.visible = true;
  tabCtx.x = Math.min(e.clientX, window.innerWidth - 210);
  tabCtx.y = Math.min(e.clientY, window.innerHeight - 240);
  tabCtx.tab = tab;
}

function closeTabContextMenu() {
  tabCtx.visible = false;
  tabCtx.tab = null;
}

// ===== Pure Pointer-Based Tab Reorder & Cross-Pane / Edge Split =====
function onTabMouseDown(tab: OpenTab, index: number, e: MouseEvent) {
  if (e.button !== 0 || e.ctrlKey || e.metaKey) return;
  // Don't start drag when clicking close or pin icon button
  const targetEl = e.target as HTMLElement | null;
  if (targetEl?.closest("button")) return;

  pendingDrag = {
    paneId: props.pane.id,
    tabId: tab.id,
    index,
    title: tabsStore.getDisplayTabTitle(tab),
    startX: e.clientX,
    startY: e.clientY,
  };

  window.addEventListener("mousemove", onWindowTabDragMove);
  window.addEventListener("mouseup", onWindowTabDragEnd);
  window.addEventListener("keydown", onWindowTabDragKey);
}

function updatePointerDropTarget(clientX: number, clientY: number) {
  tabDragState.clientX = clientX;
  tabDragState.clientY = clientY;
  tabDragState.hoverPaneId = null;
  tabDragState.hoverTabIndex = null;
  tabDragState.hoverSide = null;
  tabDragState.bodyPaneId = null;
  tabDragState.bodyZone = null;

  const els = document.elementsFromPoint(clientX, clientY) as HTMLElement[];

  // 1) Check if hovering over any tab strip (same pane or another pane)
  const stripEl = els.find((el) => el.dataset?.tabStripPane);
  if (stripEl) {
    const targetPaneId = stripEl.dataset.tabStripPane!;
    tabDragState.hoverPaneId = targetPaneId;
    const tabEls = Array.from(stripEl.querySelectorAll<HTMLElement>("[data-tab-index]"));
    if (tabEls.length === 0) {
      tabDragState.hoverTabIndex = 0;
      tabDragState.hoverSide = "before";
      return;
    }

    for (let i = 0; i < tabEls.length; i++) {
      const rect = tabEls[i].getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      if (clientX < midX) {
        tabDragState.hoverTabIndex = i;
        tabDragState.hoverSide = "before";
        return;
      }
    }
    tabDragState.hoverTabIndex = tabEls.length - 1;
    tabDragState.hoverSide = "after";
    return;
  }

  // 2) Otherwise check if hovering over any pane body (left/right edge split or cross-pane move)
  const bodyEl = els.find((el) => el.dataset?.paneBodyId);
  if (bodyEl) {
    const targetPaneId = bodyEl.dataset.paneBodyId!;
    const rect = bodyEl.getBoundingClientRect();
    const relX = (clientX - rect.left) / Math.max(1, rect.width);
    const canSplitMore = tabsStore.panes.length < 3;

    if (canSplitMore && relX >= 0.75) {
      tabDragState.bodyPaneId = targetPaneId;
      tabDragState.bodyZone = "right";
    } else if (canSplitMore && relX <= 0.25) {
      tabDragState.bodyPaneId = targetPaneId;
      tabDragState.bodyZone = "left";
    } else if (tabDragState.sourcePaneId !== targetPaneId) {
      tabDragState.bodyPaneId = targetPaneId;
      tabDragState.bodyZone = "center";
    }
  }
}

function onWindowTabDragMove(e: MouseEvent) {
  if (!pendingDrag) return;
  if (!tabDragState.active) {
    const dist = Math.hypot(e.clientX - pendingDrag.startX, e.clientY - pendingDrag.startY);
    if (dist < 5) return;
    tabDragState.active = true;
    tabDragState.sourcePaneId = pendingDrag.paneId;
    tabDragState.tabId = pendingDrag.tabId;
    tabDragState.sourceIndex = pendingDrag.index;
    tabDragState.title = pendingDrag.title;
    suppressNextTabClick = true;
    document.body.style.userSelect = "none";
  }
  updatePointerDropTarget(e.clientX, e.clientY);
}

function cleanupTabDragListeners() {
  window.removeEventListener("mousemove", onWindowTabDragMove);
  window.removeEventListener("mouseup", onWindowTabDragEnd);
  window.removeEventListener("keydown", onWindowTabDragKey);
  document.body.style.userSelect = "";
}

function onWindowTabDragKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    pendingDrag = null;
    resetTabDragState();
    cleanupTabDragListeners();
  }
}

function onWindowTabDragEnd() {
  cleanupTabDragListeners();
  const drag = pendingDrag;
  pendingDrag = null;

  if (!drag || !tabDragState.active) {
    resetTabDragState();
    return;
  }

  const srcPaneId = tabDragState.sourcePaneId;
  const tabId = tabDragState.tabId;
  const srcIndex = tabDragState.sourceIndex;

  if (srcPaneId && tabId) {
    if (tabDragState.hoverPaneId && tabDragState.hoverTabIndex !== null) {
      const targetPaneId = tabDragState.hoverPaneId;
      let insertIdx =
        tabDragState.hoverSide === "after"
          ? tabDragState.hoverTabIndex + 1
          : tabDragState.hoverTabIndex;

      if (targetPaneId === srcPaneId) {
        if (srcIndex < insertIdx) insertIdx -= 1;
        if (srcIndex !== insertIdx) {
          tabsStore.reorderTab(srcPaneId, srcIndex, insertIdx);
        }
      } else {
        tabsStore.moveTabToPane(srcPaneId, tabId, targetPaneId, insertIdx);
      }
    } else if (tabDragState.bodyPaneId && tabDragState.bodyZone) {
      if (tabDragState.bodyZone === "left" || tabDragState.bodyZone === "right") {
        tabsStore.splitTabToNewPane(srcPaneId, tabId, tabDragState.bodyZone);
      } else if (tabDragState.bodyPaneId !== srcPaneId) {
        tabsStore.moveTabToPane(srcPaneId, tabId, tabDragState.bodyPaneId);
      }
    }
  }

  resetTabDragState();
  setTimeout(() => {
    suppressNextTabClick = false;
  }, 50);
}

// ===== Resizable Divider for Independent Source + Preview Mode =====
function startSourceSplitResize(e: MouseEvent) {
  e.preventDefault();
  resizingSourceSplit = true;
  window.addEventListener("mousemove", onSourceSplitMove);
  window.addEventListener("mouseup", stopSourceSplitResize);
}
function onSourceSplitMove(e: MouseEvent) {
  if (!resizingSourceSplit || !editorSplitRef.value) return;
  const rect = editorSplitRef.value.getBoundingClientRect();
  const pct = ((e.clientX - rect.left) / Math.max(1, rect.width)) * 100;
  sourceSplitPct.value = Math.max(22, Math.min(78, pct));
}
function stopSourceSplitResize() {
  resizingSourceSplit = false;
  window.removeEventListener("mousemove", onSourceSplitMove);
  window.removeEventListener("mouseup", stopSourceSplitResize);
}

function selectTabFromDropdown(tabId: string) {
  tabsStore.selectTab(props.pane.id, tabId);
  tabListMenuOpen.value = false;
  scrollActiveTabIntoView();
}

function focusPane() {
  tabsStore.focusPaneAndReveal(props.pane.id);
}
function handleJumpLine(line: number) {
  editorRef.value?.scrollToLine(line);
}
function handleInsertMarkdown(snippet: string) {
  editorRef.value?.insertTextAtCursor(snippet);
}
function scrollTop() {
  editorRef.value?.scrollToTop();
}
function scrollBottom() {
  editorRef.value?.scrollToBottom();
}

function winMinimize() {
  if (isTauriRuntime()) void getCurrentWindow().minimize();
}
function winToggleMaximize() {
  if (isTauriRuntime()) void getCurrentWindow().toggleMaximize();
}
function winClose() {
  if (isTauriRuntime()) void getCurrentWindow().close();
}

watch(
  () => [props.pane.tabs.length, props.pane.activeTabId],
  () => {
    scrollActiveTabIntoView();
  }
);

onMounted(() => {
  updateTabOverflow();
  if (tabStripRef.value && typeof ResizeObserver !== "undefined") {
    stripResizeObserver = new ResizeObserver(() => updateTabOverflow());
    stripResizeObserver.observe(tabStripRef.value);
  }
});

onBeforeUnmount(() => {
  stripResizeObserver?.disconnect();
  cleanupTabDragListeners();
  stopSourceSplitResize();
});

defineExpose({ scrollTop, scrollBottom });
</script>

<template>
  <section class="editor-pane" :class="{ 'is-active-pane': isActivePane }" @mousedown="focusPane">
    <!-- Top Tab Bar (drag-region placed ONLY on empty spacer so tabs & tooltips work reliably) -->
    <div class="tab-bar" @dblclick.self="winToggleMaximize">
      <button
        v-if="showExpandSidebarBtn"
        class="tb-btn expand-sidebar-btn"
        @click="emit('expand-sidebar')"
        data-tip="展开左侧文件栏 (Ctrl+Shift+B)"
      >
        <PanelLeftOpen :size="15" />
      </button>

      <!-- Left scroll arrow when tabs overflow -->
      <button
        v-if="canScrollLeft"
        class="tab-scroll-btn"
        @click="scrollTabsBy(-180)"
        data-tip="向左滚动标签栏"
      >
        <ChevronLeft :size="14" />
      </button>

      <div
        ref="tabStripRef"
        class="tab-strip"
        :data-tab-strip-pane="pane.id"
        @wheel="onTabStripWheel"
        @scroll="updateTabOverflow"
      >
        <div
          v-for="(tab, idx) in pane.tabs"
          :key="tab.id"
          class="tab-item"
          :data-tab-index="idx"
          :class="{
            active: pane.activeTabId === tab.id,
            pinned: tab.pinned,
            'split-selected': getSplitSelectionOrder(tab.id) > 0,
            'is-dragging': tabDragState.active && tabDragState.tabId === tab.id,
            'drop-before': isTabDropBefore(idx),
            'drop-after': isTabDropAfter(idx),
          }"
          @mousedown="onTabMouseDown(tab, idx, $event)"
          @click="handleTabClick(tab, $event)"
          @contextmenu="openTabContextMenu(tab, $event)"
          @mousedown.middle.prevent="tabsStore.closeTab(pane.id, tab.id)"
          :data-tip="`${tab.path}\n按住拖动排序或拖至编辑区边缘分栏 · Ctrl+点击多选合并分栏 · 右键固定`"
        >
          <span v-if="getSplitSelectionOrder(tab.id) > 0" class="split-order-badge">
            {{ getSplitSelectionOrder(tab.id) }}
          </span>
          <TerminalIcon v-if="tab.kind === 'terminal'" :size="13" class="tab-term-ico" />
          <span v-if="tab.dirty" class="dirty-dot" />
          <span class="tab-title">{{ tabsStore.getDisplayTabTitle(tab) }}</span>

          <!-- Pinned tabs show Pin icon (click to unpin); normal tabs show larger crisp Close button -->
          <button
            v-if="tab.pinned"
            class="tab-pin-btn"
            @click.stop="tabsStore.togglePinTab(pane.id, tab.id)"
            data-tip="已固定（点击取消固定）"
          >
            <Pin :size="13" :stroke-width="2.2" />
          </button>
          <button
            v-else
            class="tab-close"
            @click.stop="tabsStore.closeTab(pane.id, tab.id)"
            data-tip="关闭标签 (Ctrl+W)"
          >
            <X :size="15" :stroke-width="2.3" />
          </button>
        </div>

        <!-- Dedicated window drag spacer right after the tabs -->
        <div class="tab-drag-spacer" data-tauri-drag-region @dblclick="winToggleMaximize" />
      </div>

      <!-- Ctrl+Click Multi-Tab Split Action Pill (appears when 2 or 3 tabs are selected) -->
      <div v-if="isSplitSelectionInThisPane" class="split-merge-pill">
        <button
          class="split-merge-btn"
          @click="tabsStore.mergeSelectedTabsToColumns()"
          :data-tip="`将已选中的 ${tabsStore.selectedSplitTabIds.length} 个标签页并排显示`"
        >
          <Check :size="13" />
          <span>合并为 {{ tabsStore.selectedSplitTabIds.length }} 分栏</span>
        </button>
        <button
          v-if="tabsStore.selectedSplitTabIds.length === 2"
          class="split-merge-btn"
          @click="tabsStore.diffSelectedTabs()"
          data-tip="打开行级差异对比（Diff）"
        >
          <GitCompare :size="13" />
          <span>对比差异</span>
        </button>
        <button
          class="split-cancel-btn"
          @click="tabsStore.clearSplitSelection()"
          data-tip="取消多选"
        >
          <X :size="13" />
        </button>
      </div>

      <!-- Right scroll arrow + All Tabs dropdown -->
      <button
        v-if="canScrollRight"
        class="tab-scroll-btn"
        @click="scrollTabsBy(180)"
        data-tip="向右滚动标签栏"
      >
        <ChevronRight :size="14" />
      </button>

      <div v-if="pane.tabs.length > 0" class="tab-list-dropdown-wrap">
        <button
          class="tb-btn"
          :class="{ active: tabListMenuOpen }"
          @click.stop="tabListMenuOpen = !tabListMenuOpen"
          :data-tip="`所有已打开标签页 (${pane.tabs.length})`"
        >
          <ChevronDown :size="14" />
        </button>

        <div v-if="tabListMenuOpen" class="tab-dropdown-backdrop" @click="tabListMenuOpen = false" />
        <div v-if="tabListMenuOpen" class="tab-dropdown-menu" @click.stop>
          <div class="td-header">
            <span>已打开标签（{{ pane.tabs.length }}）</span>
            <div class="td-header-actions">
              <button
                v-if="activeTab && pane.tabs.length > 1"
                class="td-mini-link"
                @click="tabsStore.closeOtherTabs(pane.id, activeTab.id); tabListMenuOpen = false"
              >
                关闭其他
              </button>
              <button
                class="td-mini-link danger"
                @click="tabsStore.closeAllTabs(pane.id); tabListMenuOpen = false"
              >
                关闭未固定
              </button>
            </div>
          </div>
          <div class="td-list">
            <div
              v-for="tab in pane.tabs"
              :key="tab.id"
              class="td-item"
              :class="{ active: pane.activeTabId === tab.id }"
              @click="selectTabFromDropdown(tab.id)"
            >
              <Pin v-if="tab.pinned" :size="12" class="td-pin-ico" />
              <span v-if="tab.dirty" class="dirty-dot" />
              <span class="td-name">{{ tabsStore.getDisplayTabTitle(tab) }}</span>
              <button
                v-if="!tab.pinned"
                class="td-close"
                @click.stop="tabsStore.closeTab(pane.id, tab.id)"
                data-tip="关闭"
              >
                <X :size="14" :stroke-width="2.2" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Pane Toolbar: Editor Mode + Independent Source-Preview Split + Workspace Multi-Column Split -->
      <div class="pane-toolbar">
        <template v-if="activeTab && activeTab.kind === 'markdown'">
          <button
            class="tb-btn"
            :class="{ active: activeTab.editMode === 'live' }"
            @click="activeTab.editMode = activeTab.editMode === 'live' ? 'source' : 'live'"
            :data-tip="activeTab.editMode === 'live' ? '当前：实时预览（点击切换源码双栏预览）' : '当前：源码双栏预览（点击切换实时预览）'"
          >
            <Eye v-if="activeTab.editMode === 'live'" :size="15" />
            <Code2 v-else :size="15" />
          </button>
          <button
            class="tb-btn"
            :class="{ active: settings.state.showOutline }"
            @click="settings.state.showOutline = !settings.state.showOutline"
            data-tip="目录大纲 (Ctrl+Shift+O)"
          >
            <List :size="15" />
          </button>
          <button
            class="tb-btn"
            :class="{ active: settings.state.showMinimap }"
            @click="settings.state.showMinimap = !settings.state.showMinimap"
            data-tip="右侧缩略图 (Ctrl+Shift+M)"
          >
            <MapIcon :size="15" />
          </button>
          <button
            class="tb-btn"
            :class="{ active: settings.state.showAttachmentsBar }"
            @click="settings.state.showAttachmentsBar = !settings.state.showAttachmentsBar"
            data-tip="底部附件栏 (Ctrl+Shift+A)"
          >
            <Paperclip :size="15" />
          </button>
          <button class="tb-btn" @click="emit('export-html', activeTab.id)" data-tip="导出为 HTML (Ctrl+Shift+E)">
            <Download :size="15" />
          </button>
          <button class="tb-btn" @click="emit('export-pdf', activeTab.id)" data-tip="导出 / 打印为 PDF (Ctrl+Shift+P)">
            <Printer :size="15" />
          </button>
        </template>

        <template v-else-if="activeTab && activeTab.kind === 'html'">
          <button
            class="tb-btn"
            :class="{ active: activeTab.editMode === 'live' }"
            @click="activeTab.editMode = activeTab.editMode === 'live' ? 'source' : 'live'"
            :data-tip="activeTab.editMode === 'live' ? '当前：HTML 浏览预览（点击切换源码编辑）' : '当前：HTML 源码编辑（点击切换网页预览）'"
          >
            <Eye v-if="activeTab.editMode === 'live'" :size="15" />
            <Code2 v-else :size="15" />
          </button>
          <button
            v-if="activeTab.editMode === 'source'"
            class="tb-btn"
            :class="{ active: settings.state.showMinimap }"
            @click="settings.state.showMinimap = !settings.state.showMinimap"
            data-tip="右侧缩略图 (Ctrl+Shift+M)"
          >
            <MapIcon :size="15" />
          </button>
          <button
            class="tb-btn"
            @click="ipc.openSystemPath(activeTab.path)"
            data-tip="使用系统默认浏览器打开"
          >
            <ExternalLink :size="14" />
          </button>
        </template>

        <div class="tb-sep" />
        <button
          class="tb-btn"
          :class="{ active: tabsStore.splitDirection === 'vertical' }"
          @click="tabsStore.toggleSplit('vertical')"
          :data-tip="
            tabsStore.panes.length === 1
              ? '分栏显示：点击切换 2 分栏（单栏 → 2 栏 → 3 栏循环）'
              : tabsStore.panes.length === 2 && tabsStore.splitDirection === 'vertical'
                ? '分栏显示：点击切换 3 分栏'
                : '分栏显示：点击恢复单栏（合并所有分栏标签）'
          "
        >
          <Columns2 :size="15" />
        </button>
        <button
          class="tb-btn"
          :class="{ active: tabsStore.splitDirection === 'horizontal' }"
          @click="tabsStore.toggleSplit('horizontal')"
          :data-tip="
            tabsStore.panes.length === 1
              ? '上下分屏：点击切换 2 分栏（单栏 → 2 栏 → 3 栏循环）'
              : tabsStore.panes.length === 2 && tabsStore.splitDirection === 'horizontal'
                ? '上下分屏：点击切换 3 分栏'
                : tabsStore.splitDirection === 'horizontal'
                  ? '上下分屏：点击恢复单栏（合并所有分栏标签）'
                  : '切换为上下排列'
          "
        >
          <Rows2 :size="15" />
        </button>
        <button
          v-if="tabsStore.panes.length > 1"
          class="tb-btn"
          @click="tabsStore.closeSplitPane(pane.id)"
          data-tip="关闭此分栏（标签将合并到相邻栏）"
        >
          <X :size="15" />
        </button>

        <template v-if="showWindowControls">
          <div class="tb-sep" />
          <button
            class="tb-btn"
            @click="toggleLightDark"
            :data-tip="isDarkAppearance ? '当前：深色模式（点击切换浅色模式）' : '当前：浅色模式（点击切换深色模式）'"
          >
            <Sun v-if="isDarkAppearance" :size="15" />
            <Moon v-else :size="15" />
          </button>
          <div class="tb-sep" />
          <div class="win-controls">
            <button class="win-btn" @click="winMinimize" data-tip="最小化">
              <Minus :size="14" />
            </button>
            <button class="win-btn" @click="winToggleMaximize" data-tip="最大化 / 还原">
              <Square :size="12" />
            </button>
            <button class="win-btn win-close" @click="winClose" data-tip="关闭">
              <X :size="14" />
            </button>
          </div>
        </template>
      </div>
    </div>

    <!-- External Modification / Deletion Conflict Banner -->
    <div v-if="activeTab?.externalConflict" class="conflict-banner">
      <div class="conflict-msg">
        <AlertTriangle :size="15" />
        <span v-if="activeTab.externalConflict.kind === 'modified'">
          检测到外部程序已修改 <strong>{{ activeTab.name }}</strong>，为防止数据覆盖，已暂停自动保存。
        </span>
        <span v-else>
          文件 <strong>{{ activeTab.name }}</strong> 已被外部删除或移动。
        </span>
      </div>
      <div class="conflict-actions">
        <template v-if="activeTab.externalConflict.kind === 'modified'">
          <button class="c-btn" @click="tabsStore.openConflictDiff(activeTab.id)">
            <GitCompare :size="13" /> 对比差异
          </button>
          <button class="c-btn" @click="tabsStore.reloadTabFromDisk(activeTab.id)">
            重新加载磁盘版本
          </button>
          <button class="c-btn primary" @click="tabsStore.keepLocalAndOverwrite(activeTab.id)">
            保留当前编辑
          </button>
        </template>
        <template v-else>
          <button class="c-btn primary" @click="tabsStore.keepLocalAndOverwrite(activeTab.id)">
            重新写入磁盘
          </button>
          <button class="c-btn" @click="tabsStore.closeTab(pane.id, activeTab.id, true)">
            关闭标签
          </button>
        </template>
      </div>
    </div>

    <!-- Main Pane Workspace (also acts as pointer drag-to-split target) -->
    <div class="pane-content" :data-pane-body-id="pane.id">
      <!-- Visual drop overlay when dragging a tab onto left/right edge or across panes -->
      <div v-if="activeBodyDropZone" class="pane-drop-overlay" :class="`zone-${activeBodyDropZone}`">
        <span class="drop-label">
          {{
            activeBodyDropZone === "right"
              ? "释放以在右侧新建分栏"
              : activeBodyDropZone === "left"
                ? "释放以在左侧新建分栏"
                : "释放以移动标签到此栏"
          }}
        </span>
      </div>

      <template v-if="activeTab">
        <!-- Markdown / Plain Text Editor (+ Optional Independent Source+Preview Side-by-Side) -->
        <template v-if="activeTab.kind === 'markdown' || activeTab.kind === 'other'">
          <div class="editor-and-outline">
            <div ref="editorSplitRef" class="editor-and-source-preview">
              <div
                class="source-editor-slot"
                :style="
                  activeTab.kind === 'markdown' && activeTab.editMode === 'source' && !activeTab.isLarge
                    ? { flex: `${sourceSplitPct} 1 0%` }
                    : { flex: '1 1 0%' }
                "
              >
                <MarkdownEditor
                  :key="activeTab.id"
                  ref="editorRef"
                  :tab="activeTab"
                  @outline-change="(h) => (headings = h)"
                  @cursor-change="(c) => (cursorInfo = c)"
                  @scroll-ratio="(r) => (editorScrollRatio = r)"
                  @image-lightbox="(p) => emit('image-lightbox', p)"
                />
              </div>

              <template
                v-if="activeTab.kind === 'markdown' && activeTab.editMode === 'source' && !activeTab.isLarge"
              >
                <div
                  class="source-split-resizer"
                  data-tip="拖动调整源码与预览比例（双击恢复 50%）"
                  @mousedown="startSourceSplitResize"
                  @dblclick="sourceSplitPct = 50"
                />
                <div
                  class="source-preview-slot"
                  :style="{ flex: `${100 - sourceSplitPct} 1 0%` }"
                >
                  <MarkdownPreviewPane
                    :content="activeTab.content"
                    :note-path="activeTab.path"
                    :scroll-ratio="editorScrollRatio"
                    @image-lightbox="(p) => emit('image-lightbox', p)"
                  />
                </div>
              </template>
            </div>

            <OutlinePanel
              v-if="settings.state.showOutline && activeTab.kind === 'markdown'"
              :headings="headings"
              :active-line="cursorInfo.line"
              @jump="handleJumpLine"
            />
          </div>
          <AttachmentBar
            v-if="settings.state.showAttachmentsBar && activeTab.kind === 'markdown'"
            :note-path="activeTab.path"
            @insert-markdown="handleInsertMarkdown"
            @preview-image="(p) => emit('image-lightbox', p)"
          />
        </template>

        <!-- HTML Browse & Source Edit -->
        <template v-else-if="activeTab.kind === 'html'">
          <div v-if="activeTab.editMode === 'live'" class="html-viewer">
            <iframe
              v-if="activeTab.dirty"
              :srcdoc="htmlSrcDoc"
              sandbox="allow-scripts allow-same-origin"
              class="html-frame"
            />
            <iframe
              v-else
              :key="`${activeTab.path}-${activeTab.mtimeMs}`"
              :src="toAssetUrl(activeTab.path, activeTab.mtimeMs, activeTab.path)"
              sandbox="allow-scripts allow-same-origin"
              class="html-frame"
            />
          </div>
          <div v-else class="editor-and-outline">
            <MarkdownEditor
              :key="activeTab.id"
              ref="editorRef"
              :tab="activeTab"
              @cursor-change="(c) => (cursorInfo = c)"
            />
          </div>
        </template>

        <!-- Image Viewer -->
        <div v-else-if="activeTab.kind === 'image'" class="asset-viewer">
          <div class="asset-preview-card">
            <img
              :src="toAssetUrl(activeTab.path, activeTab.mtimeMs)"
              :alt="activeTab.name"
              class="asset-image"
              @click="
                emit('image-lightbox', {
                  src: toAssetUrl(activeTab.path, activeTab.mtimeMs),
                  alt: activeTab.name,
                })
              "
            />
            <div class="asset-caption">
              <ImageIcon :size="14" />
              <span>{{ activeTab.path }}</span>
            </div>
          </div>
        </div>

        <!-- PDF Viewer -->
        <div v-else-if="activeTab.kind === 'pdf'" class="pdf-viewer">
          <iframe :src="toAssetUrl(activeTab.path, activeTab.mtimeMs)" class="pdf-frame" />
          <div class="pdf-fallback-bar">
            <span>{{ activeTab.name }}</span>
            <button class="c-btn" @click="ipc.openSystemPath(activeTab.path)">
              使用系统默认 PDF 阅读器打开
            </button>
          </div>
        </div>

        <!-- Embedded Command Terminal -->
        <TerminalPane
          v-else-if="activeTab.kind === 'terminal'"
          :key="activeTab.id"
          :cwd="activeTab.path"
          :workspace-name="activeTab.name"
        />
      </template>

      <div v-else class="welcome-state">
        <div class="welcome-card">
          <img src="/logo.svg" alt="Folia" class="welcome-icon" />
          <div class="welcome-logo">Folia</div>
          <p class="welcome-sub">本地文件夹优先 · 零数据库 · 轻量简洁的 Markdown 笔记工作台</p>
          <div class="welcome-actions">
            <button class="welcome-btn primary" @click="wsStore.pickAndAddWorkspace()">
              <FolderOpen :size="16" /> 打开本地笔记文件夹
            </button>
          </div>
          <div v-if="tabsStore.recentFiles.length > 0" class="welcome-recent">
            <div class="wr-title">最近打开</div>
            <button
              v-for="r in tabsStore.recentFiles.slice(0, 5)"
              :key="r.path"
              class="wr-item"
              @click="tabsStore.openFile(r.path, { paneId: pane.id, workspaceId: r.workspaceId })"
            >
              <FileText :size="14" /><span>{{ r.name }}</span>
              <span class="wr-path">{{ r.path }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="activeTab" class="pane-status">
      <div class="status-left">
        <span class="status-chip">
          <template v-if="activeTab.kind === 'html'">
            {{ activeTab.editMode === "live" ? "HTML 浏览" : "HTML 源码" }}
          </template>
          <template v-else-if="activeTab.kind === 'markdown'">
            {{
              activeTab.editMode === "live"
                ? "实时预览"
                : activeTab.isLarge
                  ? "源码（大文件）"
                  : "源码分栏预览"
            }}
          </template>
          <template v-else-if="activeTab.kind === 'terminal'">命令终端</template>
          <template v-else>{{ activeTab.kind.toUpperCase() }}</template>
        </span>
        <template v-if="activeTab.kind !== 'terminal'">
          <span v-if="activeTab.dirty" class="status-dirty">● 未保存</span>
          <span v-else class="status-saved">已保存</span>
        </template>
      </div>
      <div class="status-right">
        <template v-if="activeTab.kind === 'markdown' || activeTab.kind === 'html'">
          <span>行 {{ cursorInfo.line }}, 列 {{ cursorInfo.col }}</span>
          <span v-if="activeTab.kind === 'markdown'">{{ cursorInfo.words }} 词</span>
          <span>{{ activeTab.encoding }}{{ activeTab.hasBom ? " BOM" : "" }}</span>
          <span>{{ activeTab.lineEnding }}</span>
        </template>
      </div>
    </div>

    <!-- Tab Right-Click Context Menu -->
    <Teleport to="body">
      <div
        v-if="tabCtx.visible && tabCtx.tab"
        class="tab-ctx-backdrop"
        @click="closeTabContextMenu"
        @contextmenu.prevent="closeTabContextMenu"
      >
        <div
          class="tab-ctx-menu"
          :style="{ left: `${tabCtx.x}px`, top: `${tabCtx.y}px` }"
          @click.stop
        >
          <button
            class="tab-ctx-item"
            @click="tabsStore.togglePinTab(pane.id, tabCtx.tab.id); closeTabContextMenu()"
          >
            <PinOff v-if="tabCtx.tab.pinned" :size="14" />
            <Pin v-else :size="14" />
            <span>{{ tabCtx.tab.pinned ? "取消固定标签页" : "固定标签页" }}</span>
          </button>

          <button
            v-if="tabsStore.panes.length < 3"
            class="tab-ctx-item"
            @click="tabsStore.splitTabToNewPane(pane.id, tabCtx.tab.id, 'right'); closeTabContextMenu()"
          >
            <Columns2 :size="14" />
            <span>向右新建分栏打开</span>
          </button>

          <button
            v-if="
              activeTab &&
              tabCtx.tab.id !== activeTab.id &&
              (activeTab.kind === 'markdown' || activeTab.kind === 'html' || activeTab.kind === 'other') &&
              (tabCtx.tab.kind === 'markdown' || tabCtx.tab.kind === 'html' || tabCtx.tab.kind === 'other')
            "
            class="tab-ctx-item"
            @click="tabsStore.openFilesDiff(activeTab.path, tabCtx.tab.path); closeTabContextMenu()"
          >
            <GitCompare :size="14" />
            <span>与当前标签 Diff 对比</span>
          </button>

          <button
            v-if="isSplitSelectionInThisPane"
            class="tab-ctx-item"
            @click="tabsStore.mergeSelectedTabsToColumns(); closeTabContextMenu()"
          >
            <Check :size="14" />
            <span>将已选 {{ tabsStore.selectedSplitTabIds.length }} 个标签合并为分栏</span>
          </button>

          <div class="tab-ctx-sep" />

          <button
            class="tab-ctx-item"
            @click="tabsStore.closeTab(pane.id, tabCtx.tab.id, true); closeTabContextMenu()"
          >
            <X :size="14" />
            <span>关闭此标签页</span>
          </button>
          <button
            class="tab-ctx-item"
            @click="tabsStore.closeOtherTabs(pane.id, tabCtx.tab.id); closeTabContextMenu()"
          >
            <span>关闭其他未固定标签页</span>
          </button>
          <button
            class="tab-ctx-item danger"
            @click="tabsStore.closeAllTabs(pane.id); closeTabContextMenu()"
          >
            <span>关闭全部未固定标签页</span>
          </button>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.editor-pane { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--bg-surface); overflow: hidden; position: relative; }
.tab-bar { height: 38px; flex-shrink: 0; display: flex; align-items: center; background: var(--bg-base); border-bottom: 1px solid var(--border-color); padding: 0 6px; gap: 4px; user-select: none; position: relative; }
.expand-sidebar-btn { flex-shrink: 0; }

.tab-scroll-btn {
  width: 22px;
  height: 26px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  color: var(--text-secondary);
  border-radius: 5px;
  cursor: pointer;
}
.tab-scroll-btn:hover { background: var(--bg-hover); color: var(--text-primary); }

.tab-strip {
  flex: 1;
  min-width: 0;
  height: 100%;
  display: flex;
  align-items: center;
  gap: 3px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.tab-strip::-webkit-scrollbar { display: none; }

.tab-drag-spacer {
  flex: 1;
  min-width: 24px;
  height: 100%;
}

.tab-item {
  height: 30px;
  max-width: 210px;
  min-width: 82px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 5px 0 10px;
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  color: var(--text-secondary);
  cursor: pointer;
  flex-shrink: 0;
  border: 1px solid transparent;
  position: relative;
  transition: background 0.12s, border-color 0.12s, opacity 0.12s;
}
.tab-item:hover { background: var(--bg-hover); color: var(--text-primary); }
.tab-item.active {
  background: var(--bg-surface);
  color: var(--text-primary);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
  border-color: var(--border-color);
}
.tab-item.pinned {
  min-width: 72px;
}
.tab-item.split-selected {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}
.tab-item.is-dragging {
  opacity: 0.4;
}
.tab-item.drop-before::before {
  content: "";
  position: absolute;
  left: -3px;
  top: 3px;
  bottom: 3px;
  width: 2.5px;
  border-radius: 2px;
  background: var(--accent);
}
.tab-item.drop-after::after {
  content: "";
  position: absolute;
  right: -3px;
  top: 3px;
  bottom: 3px;
  width: 2.5px;
  border-radius: 2px;
  background: var(--accent);
}

.split-order-badge {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--accent);
  color: #ffffff;
  font-size: 10.5px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.dirty-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }
.tab-term-ico { color: var(--accent); flex-shrink: 0; }
.tab-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }

/* Larger, clearer tab close button & pin indicator */
.tab-close,
.tab-pin-btn {
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0.85;
  transition: background 0.12s, color 0.12s, opacity 0.12s;
}
.tab-pin-btn { color: var(--accent); opacity: 0.95; }
.tab-pin-btn:hover { background: var(--accent-soft); }
.tab-item.active .tab-close,
.tab-item:hover .tab-close { opacity: 1; }
.tab-close:hover {
  background: color-mix(in srgb, var(--danger) 18%, transparent);
  color: var(--danger);
}

/* Ctrl+Click multi-tab split merge pill */
.split-merge-pill {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-pill);
  background: var(--accent-soft);
  border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  flex-shrink: 0;
}
.split-merge-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 9px;
  border: none;
  border-radius: var(--radius-pill);
  background: var(--bg-surface);
  color: var(--accent);
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
}
.split-merge-btn:hover { background: var(--accent); color: #ffffff; }
.split-cancel-btn {
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  color: var(--accent);
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.split-cancel-btn:hover { background: color-mix(in srgb, var(--accent) 16%, transparent); }

/* All-tabs overflow dropdown */
.tab-list-dropdown-wrap { position: relative; flex-shrink: 0; }
.tab-dropdown-backdrop { position: fixed; inset: 0; z-index: 2500; }
.tab-dropdown-menu { position: absolute; top: 34px; right: 0; width: 270px; max-height: 360px; background: var(--bg-elevated); border: 1px solid var(--border-color); border-radius: var(--radius-md); box-shadow: var(--shadow-md); z-index: 2600; display: flex; flex-direction: column; overflow: hidden; }
.td-header { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; border-bottom: 1px solid var(--border-color); font-size: 12px; font-weight: 600; color: var(--text-secondary); }
.td-header-actions { display: flex; gap: 8px; }
.td-mini-link { border: none; background: transparent; color: var(--accent); font-size: 11.5px; cursor: pointer; padding: 0; }
.td-mini-link.danger { color: var(--danger); }
.td-list { overflow-y: auto; padding: 4px; }
.td-item { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: var(--radius-sm); font-size: 12.5px; cursor: pointer; color: var(--text-primary); }
.td-item:hover { background: var(--bg-hover); }
.td-item.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.td-pin-ico { color: var(--accent); flex-shrink: 0; }
.td-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.td-close { width: 22px; height: 22px; border: none; background: transparent; color: var(--text-secondary); border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.td-close:hover { background: color-mix(in srgb, var(--danger) 16%, transparent); color: var(--danger); }

.pane-toolbar { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
.tb-btn { width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; border: none; background: transparent; color: var(--text-secondary); border-radius: var(--radius-sm); cursor: pointer; }
.tb-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.tb-btn.active { background: var(--accent-soft); color: var(--accent); }
.tb-sep { width: 1px; height: 16px; background: var(--border-color); margin: 0 4px; }
.win-controls { display: inline-flex; align-items: center; margin-left: 2px; }
.win-btn { width: 32px; height: 30px; display: inline-flex; align-items: center; justify-content: center; border: none; background: transparent; color: var(--text-secondary); border-radius: var(--radius-sm); cursor: pointer; }
.win-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.win-btn.win-close:hover { background: #dc2626; color: #ffffff; }

.conflict-banner { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding: 8px 14px; background: rgba(217, 119, 6, 0.12); border-bottom: 1px solid rgba(217, 119, 6, 0.35); color: var(--text-primary); font-size: 12.5px; }
.conflict-msg { display: flex; align-items: center; gap: 7px; }
.conflict-actions { display: flex; gap: 6px; }
.c-btn { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border-radius: var(--radius-pill); border: 1px solid var(--border-color); background: var(--bg-surface); color: var(--text-primary); font-size: 12px; cursor: pointer; }
.c-btn.primary { background: var(--accent); border-color: var(--accent); color: #ffffff; }

.pane-content { flex: 1; display: flex; flex-direction: column; min-height: 0; min-width: 0; overflow: hidden; position: relative; }
.editor-and-outline { flex: 1; display: flex; min-height: 0; min-width: 0; overflow: hidden; }
.editor-and-source-preview { flex: 1; display: flex; min-height: 0; min-width: 0; overflow: hidden; }
.source-editor-slot,
.source-preview-slot { display: flex; min-width: 0; min-height: 0; overflow: hidden; }
.source-split-resizer {
  width: 4px;
  flex-shrink: 0;
  cursor: col-resize;
  background: var(--border-color);
  transition: background 0.14s;
}
.source-split-resizer:hover { background: var(--accent); }

/* Drag-to-split visual indicator overlay */
.pane-drop-overlay {
  position: absolute;
  top: 8px;
  bottom: 8px;
  z-index: 500;
  border: 2px dashed var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.pane-drop-overlay.zone-right { right: 8px; width: 42%; }
.pane-drop-overlay.zone-left { left: 8px; width: 42%; }
.pane-drop-overlay.zone-center { left: 8px; right: 8px; }
.drop-label {
  padding: 6px 14px;
  border-radius: var(--radius-pill);
  background: var(--bg-elevated);
  border: 1px solid var(--accent);
  color: var(--accent);
  font-size: 12.5px;
  font-weight: 600;
  box-shadow: var(--shadow-md);
}

.html-viewer { flex: 1; display: flex; min-height: 0; background: #ffffff; }
.html-frame { flex: 1; width: 100%; height: 100%; border: none; background: #ffffff; }

.asset-viewer { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px; overflow: auto; background: var(--bg-base); }
.asset-preview-card { display: flex; flex-direction: column; align-items: center; gap: 12px; max-width: 100%; }
.asset-image { max-width: 90%; max-height: 75vh; border-radius: var(--radius-md); border: 1px solid var(--border-color); cursor: zoom-in; }
.asset-caption { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-muted); }

.pdf-viewer { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.pdf-frame { flex: 1; border: none; width: 100%; background: #525659; }
.pdf-fallback-bar { display: flex; align-items: center; justify-content: space-between; padding: 6px 14px; border-top: 1px solid var(--border-color); background: var(--bg-base); font-size: 12px; }

.welcome-state { flex: 1; display: flex; align-items: center; justify-content: center; padding: 32px; }
.welcome-card { max-width: 460px; width: 100%; text-align: center; }
.welcome-icon { width: 58px; height: 58px; margin-bottom: 10px; border-radius: 14px; }
.welcome-logo { font-size: 32px; font-weight: 800; letter-spacing: -0.03em; color: var(--md-heading); margin-bottom: 8px; }
.welcome-sub { font-size: 13.5px; color: var(--text-muted); margin: 0 0 22px; }
.welcome-actions { display: flex; justify-content: center; gap: 10px; }
.welcome-btn { display: inline-flex; align-items: center; gap: 7px; padding: 9px 18px; border-radius: var(--radius-pill); border: none; font-size: 13.5px; font-weight: 500; cursor: pointer; }
.welcome-btn.primary { background: var(--accent); color: #ffffff; }
.welcome-recent { margin-top: 28px; text-align: left; border-top: 1px solid var(--border-color); padding-top: 14px; }
.wr-title { font-size: 12px; font-weight: 600; color: var(--text-muted); margin-bottom: 8px; }
.wr-item { width: 100%; display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: none; background: transparent; border-radius: var(--radius-sm); cursor: pointer; color: var(--text-primary); font-size: 13px; }
.wr-item:hover { background: var(--bg-hover); }
.wr-path { margin-left: auto; font-size: 11px; color: var(--text-muted); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.pane-status { height: 25px; display: flex; align-items: center; justify-content: space-between; padding: 0 12px; border-top: 1px solid var(--border-color); background: var(--bg-base); font-size: 11.5px; color: var(--text-muted); user-select: none; }
.status-left, .status-right { display: flex; align-items: center; gap: 12px; }
.status-chip { color: var(--text-secondary); font-weight: 500; }
.status-dirty { color: var(--accent); font-weight: 600; }
.status-saved { color: var(--text-muted); }

/* Tab right-click menu */
.tab-ctx-backdrop { position: fixed; inset: 0; z-index: 3200; }
.tab-ctx-menu {
  position: fixed;
  width: 205px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  padding: 5px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tab-ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 12.5px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  text-align: left;
}
.tab-ctx-item:hover { background: var(--bg-hover); }
.tab-ctx-item.danger { color: var(--danger); }
.tab-ctx-sep { height: 1px; background: var(--border-color); margin: 4px 2px; }
</style>
