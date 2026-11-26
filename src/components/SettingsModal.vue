<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import {
  X,
  Monitor,
  Sun,
  Moon,
  Palette,
  Mountain,
  RotateCcw,
  Plus,
  Trash2,
  RefreshCw,
  ExternalLink,
  CheckCircle2,
  Download,
  Upload,
  Copy,
  ClipboardPaste,
  Code2,
  Save,
  AlertCircle,
} from "lucide-vue-next";
import { LIGHT_THEMES, DARK_THEMES, type ThemePalette } from "@/core/theme/themes";
import {
  CUSTOM_COLOR_FIELDS,
  resolveEffectiveTheme,
  type CustomThemeColors,
} from "@/core/theme/applyTheme";
import { parseThemeYaml, serializeThemeToYaml } from "@/core/theme/themeYaml";
import {
  DEFAULT_SHORTCUTS,
  eventToCombo,
  formatComboForPlatform,
  getEffectiveShortcuts,
} from "@/core/shortcuts/keymap";
import {
  GESTURE_ACTION_OPTIONS,
  formatGestureSequence,
  type GestureActionId,
} from "@/core/gestures/mouseGestures";
import {
  APP_AUTHOR,
  APP_AUTHOR_URL,
  APP_LICENSE,
  APP_VERSION,
  GITHUB_REPO_URL,
  checkGithubUpdate,
  type UpdateCheckResult,
} from "@/core/update/updater";
import { ipc, isTauriRuntime, type DetectedShellInfo } from "@/core/ipc/client";
import { useSettingsStore } from "@/stores/settings";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: "close"): void }>();

const settings = useSettingsStore();
const activeTab = ref<"theme" | "editor" | "shortcuts" | "terminal" | "about">("theme");
const detectedShells = ref<DetectedShellInfo[]>([]);

watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen && isTauriRuntime() && detectedShells.value.length === 0) {
      try {
        detectedShells.value = await ipc.terminalListShells();
      } catch {
        // ignore
      }
    }
  }
);

// Shortcut recording state
const recordingShortcutId = ref<string | null>(null);

// Gesture trajectory recording state
const recordingGestureIdx = ref<number | null>(null);
const gestureDraftSeq = ref<string>("");
let gestureDragActive = false;
let gestureLastX = 0;
let gestureLastY = 0;

// Update check state
const checkingUpdate = ref(false);
const updateResult = ref<UpdateCheckResult | null>(null);

// Custom theme & YAML editor state
const themeEditorMode = ref<"visual" | "yaml">("visual");
const yamlDraft = ref("");
const yamlError = ref<string | null>(null);
const yamlFeedback = ref<string | null>(null);
const editingCustomThemeId = ref<string | null>(null);
const yamlFileInputRef = ref<HTMLInputElement | null>(null);
let feedbackTimer: ReturnType<typeof setTimeout> | null = null;

function flashYamlFeedback(msg: string) {
  yamlFeedback.value = msg;
  if (feedbackTimer) clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => {
    yamlFeedback.value = null;
  }, 2400);
}

const effectiveShortcuts = computed(() => getEffectiveShortcuts(settings.state.customShortcuts));

const effectiveMode = computed<"light" | "dark">(() => {
  if (settings.state.appearance === "dark") return "dark";
  if (settings.state.appearance === "auto") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
});

const visibleThemes = computed(() => {
  const builtins = effectiveMode.value === "dark" ? DARK_THEMES : LIGHT_THEMES;
  const customs = (settings.state.customThemes ?? []).filter((t) => t.mode === effectiveMode.value);
  return [...builtins, ...customs];
});

const activeThemeId = computed(() =>
  effectiveMode.value === "dark" ? settings.state.darkThemeId : settings.state.lightThemeId
);

function isCustomTheme(id: string): boolean {
  return (settings.state.customThemes ?? []).some((t) => t.id === id);
}

const effectivePalette = computed(() => resolveEffectiveTheme(settings.state));

const hasCustomColors = computed(() => Object.keys(settings.state.customColors || {}).length > 0);

function syncYamlFromEffective(asNewCopy = false) {
  const cur = effectivePalette.value;
  const target: ThemePalette = asNewCopy
    ? { ...cur, name: `${cur.name} Custom` }
    : cur;
  yamlDraft.value = serializeThemeToYaml(target);
  yamlError.value = null;
  editingCustomThemeId.value = !asNewCopy && isCustomTheme(cur.id) ? cur.id : null;
}

watch(
  () => [effectivePalette.value, themeEditorMode.value] as const,
  ([, mode], prev) => {
    // Sync textarea when opening YAML tab or switching active theme while not mid-error
    if (mode === "yaml" && (!prev || prev[1] !== "yaml" || !yamlDraft.value)) {
      syncYamlFromEffective(false);
    }
  },
  { immediate: true }
);

function selectTheme(id: string, mode: "light" | "dark") {
  settings.resetCustomColors();
  if (mode === "dark") settings.state.darkThemeId = id;
  else settings.state.lightThemeId = id;
  if (themeEditorMode.value === "yaml") {
    syncYamlFromEffective(false);
  }
}

function startNewCustomTheme() {
  themeEditorMode.value = "yaml";
  syncYamlFromEffective(true);
  flashYamlFeedback("已基于当前配色生成新模板，编辑后点击「保存为新主题」即可");
}

function handleSaveYamlAsNew() {
  const parsed = parseThemeYaml(yamlDraft.value);
  if (!parsed.ok) {
    yamlError.value = parsed.error;
    return;
  }
  yamlError.value = null;
  settings.saveCustomTheme(parsed.theme);
  editingCustomThemeId.value = parsed.theme.id;
  yamlDraft.value = serializeThemeToYaml(parsed.theme);
  flashYamlFeedback(`已新增并应用主题「${parsed.theme.name}」`);
}

function handleUpdateEditingCustomTheme() {
  if (!editingCustomThemeId.value) return;
  const parsed = parseThemeYaml(yamlDraft.value, editingCustomThemeId.value);
  if (!parsed.ok) {
    yamlError.value = parsed.error;
    return;
  }
  yamlError.value = null;
  settings.saveCustomTheme(parsed.theme);
  yamlDraft.value = serializeThemeToYaml(parsed.theme);
  flashYamlFeedback(`已更新主题「${parsed.theme.name}」`);
}

function handleSaveVisualAsNewTheme() {
  const cur = effectivePalette.value;
  const baseName = cur.name.replace(/\s*Custom$/i, "");
  const count = (settings.state.customThemes ?? []).length + 1;
  const newTheme: ThemePalette = {
    ...cur,
    id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: `${baseName} 自定义 ${count}`,
    swatches: [cur.bold, cur.accent, cur.heading, cur.textPrimary, cur.bgSidebar],
  };
  settings.saveCustomTheme(newTheme);
  editingCustomThemeId.value = newTheme.id;
  yamlDraft.value = serializeThemeToYaml(newTheme);
  flashYamlFeedback(`已保存为新主题「${newTheme.name}」`);
}

async function handleCopyYaml() {
  const text = themeEditorMode.value === "yaml" && yamlDraft.value.trim()
    ? yamlDraft.value
    : serializeThemeToYaml(effectivePalette.value);
  try {
    await navigator.clipboard.writeText(text);
    flashYamlFeedback("已复制 YAML 配色代码到剪贴板");
  } catch {
    yamlError.value = "剪贴板写入失败，请手动全选文本框复制";
  }
}

async function handlePasteYaml() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) {
      yamlError.value = "剪贴板为空";
      return;
    }
    themeEditorMode.value = "yaml";
    yamlDraft.value = text;
    const parsed = parseThemeYaml(text);
    if (!parsed.ok) {
      yamlError.value = parsed.error;
    } else {
      yamlError.value = null;
      flashYamlFeedback(`已粘贴「${parsed.theme.name}」，点击「保存为新主题」生效`);
    }
  } catch {
    themeEditorMode.value = "yaml";
    yamlError.value = "无法自动读取剪贴板，请直接在下方代码框按 Ctrl+V 粘贴";
  }
}

function triggerImportYamlFile() {
  yamlFileInputRef.value?.click();
}

async function handleImportYamlFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    themeEditorMode.value = "yaml";
    yamlDraft.value = text;
    const parsed = parseThemeYaml(text);
    if (!parsed.ok) {
      yamlError.value = parsed.error;
      return;
    }
    yamlError.value = null;
    settings.saveCustomTheme(parsed.theme);
    editingCustomThemeId.value = parsed.theme.id;
    yamlDraft.value = serializeThemeToYaml(parsed.theme);
    flashYamlFeedback(`已导入并应用主题「${parsed.theme.name}」`);
  } catch {
    yamlError.value = "读取 YAML 文件失败";
  }
}

function handleExportYamlFile() {
  const cur = effectivePalette.value;
  const text = themeEditorMode.value === "yaml" && yamlDraft.value.trim()
    ? yamlDraft.value
    : serializeThemeToYaml(cur);
  const safeName = (cur.name || "folia-theme").replace(/[\\/:*?"<>|]+/g, "-").trim();
  const blob = new Blob([text], { type: "text/yaml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeName}.yaml`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  flashYamlFeedback(`已导出 ${safeName}.yaml`);
}

function handleDeleteCustomTheme(id: string) {
  settings.deleteCustomTheme(id);
  if (editingCustomThemeId.value === id) {
    editingCustomThemeId.value = null;
  }
  if (themeEditorMode.value === "yaml") {
    syncYamlFromEffective(false);
  }
}

function getColorPickerValue(key: keyof CustomThemeColors): string {
  const raw = effectivePalette.value[key] || "#000000";
  return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : "#334155";
}

function onCustomColorInput(key: keyof CustomThemeColors, e: Event) {
  const val = (e.target as HTMLInputElement).value;
  settings.setCustomColor(key, val);
}

function adjustScale(delta: number) {
  const next = Math.round((settings.state.uiScale + delta) * 10) / 10;
  settings.state.uiScale = Math.max(0.8, Math.min(1.5, next));
}

function isShortcutCustomized(id: string): boolean {
  return id in settings.state.customShortcuts;
}

function startRecordingShortcut(id: string) {
  stopRecordingShortcut();
  recordingShortcutId.value = id;
  window.addEventListener("keydown", handleShortcutCapture, true);
}

function stopRecordingShortcut() {
  recordingShortcutId.value = null;
  window.removeEventListener("keydown", handleShortcutCapture, true);
}

function handleShortcutCapture(e: KeyboardEvent) {
  if (!recordingShortcutId.value) return;
  e.preventDefault();
  e.stopPropagation();

  if (e.key === "Escape") {
    stopRecordingShortcut();
    return;
  }
  if (e.key === "Backspace" && !e.ctrlKey && !e.metaKey && !e.altKey) {
    settings.setShortcut(recordingShortcutId.value, "");
    stopRecordingShortcut();
    return;
  }

  const combo = eventToCombo(e);
  if (!combo) return;
  settings.setShortcut(recordingShortcutId.value, combo);
  stopRecordingShortcut();
}

// Gesture sequence recording by dragging on the button (left or right mouse button)
function startGesturePadDown(index: number, e: MouseEvent) {
  e.preventDefault();
  recordingGestureIdx.value = index;
  gestureDraftSeq.value = "";
  gestureDragActive = true;
  gestureLastX = e.clientX;
  gestureLastY = e.clientY;
  window.addEventListener("mousemove", onGesturePadMove, true);
  window.addEventListener("mouseup", onGesturePadUp, true);
}

function onGesturePadMove(e: MouseEvent) {
  if (!gestureDragActive) return;
  const dx = e.clientX - gestureLastX;
  const dy = e.clientY - gestureLastY;
  if (Math.hypot(dx, dy) >= 20) {
    const dir = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "R" : "L") : dy > 0 ? "D" : "U";
    if (!gestureDraftSeq.value.endsWith(dir) && gestureDraftSeq.value.length < 4) {
      gestureDraftSeq.value += dir;
    }
    gestureLastX = e.clientX;
    gestureLastY = e.clientY;
  }
}

function onGesturePadUp() {
  if (!gestureDragActive) return;
  gestureDragActive = false;
  window.removeEventListener("mousemove", onGesturePadMove, true);
  window.removeEventListener("mouseup", onGesturePadUp, true);

  if (recordingGestureIdx.value !== null && gestureDraftSeq.value.length > 0) {
    settings.updateGesture(recordingGestureIdx.value, { sequence: gestureDraftSeq.value });
  }
  recordingGestureIdx.value = null;
  gestureDraftSeq.value = "";
}

function onGestureActionChange(index: number, e: Event) {
  const val = (e.target as HTMLSelectElement).value as GestureActionId;
  settings.updateGesture(index, { action: val });
}

function onGestureSeqInput(index: number, e: Event) {
  const val = (e.target as HTMLInputElement).value;
  settings.updateGesture(index, { sequence: val });
}

async function openExternal(url: string) {
  try {
    if (isTauriRuntime()) {
      await ipc.openExternalUrl(url);
      return;
    }
  } catch {
    // fallback below
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

async function handleCheckUpdate() {
  if (checkingUpdate.value) return;
  checkingUpdate.value = true;
  try {
    updateResult.value = await checkGithubUpdate();
  } finally {
    checkingUpdate.value = false;
  }
}

onBeforeUnmount(() => {
  stopRecordingShortcut();
  window.removeEventListener("mousemove", onGesturePadMove, true);
  window.removeEventListener("mouseup", onGesturePadUp, true);
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="settings-backdrop" @click="stopRecordingShortcut(); emit('close')">
      <div class="settings-modal" @click.stop>
        <div class="settings-sidebar">
          <div class="settings-brand">设置中心</div>
          <button class="s-nav-item" :class="{ active: activeTab === 'theme' }" @click="activeTab = 'theme'">
            界面主题与字体
          </button>
          <button class="s-nav-item" :class="{ active: activeTab === 'editor' }" @click="activeTab = 'editor'">
            编辑器、保存与附件
          </button>
          <button class="s-nav-item" :class="{ active: activeTab === 'shortcuts' }" @click="activeTab = 'shortcuts'">
            快捷键与鼠标手势
          </button>
          <button class="s-nav-item" :class="{ active: activeTab === 'terminal' }" @click="activeTab = 'terminal'">
            命令终端
          </button>
          <button class="s-nav-item" :class="{ active: activeTab === 'about' }" @click="activeTab = 'about'">
            关于与更新
          </button>
          <div class="settings-sidebar-footer">
            <button class="reset-btn" @click="settings.resetToDefaults()">
              <RotateCcw :size="13" /> 恢复全部默认
            </button>
          </div>
        </div>

        <div class="settings-content">
          <button class="close-btn" @click="stopRecordingShortcut(); emit('close')" title="关闭设置">
            <X :size="18" />
          </button>

          <!-- TAB 1: THEME & FONTS -->
          <div v-if="activeTab === 'theme'" class="settings-page">
            <h2 class="section-title">界面主题</h2>

            <div class="form-row">
              <span class="row-label">圆角</span>
              <div class="segmented">
                <button :class="{ active: settings.state.borderRadius === 'none' }" @click="settings.state.borderRadius = 'none'">直角</button>
                <button :class="{ active: settings.state.borderRadius === 'half' }" @click="settings.state.borderRadius = 'half'">半圆角</button>
                <button :class="{ active: settings.state.borderRadius === 'full' }" @click="settings.state.borderRadius = 'full'">全圆角</button>
              </div>
            </div>

            <div class="form-row">
              <span class="row-label">边栏始终深色</span>
              <label class="toggle-wrap"><input type="checkbox" v-model="settings.state.darkSidebarAlways" /><span class="toggle-track" /><span class="toggle-text">{{ settings.state.darkSidebarAlways ? "开启" : "关闭" }}</span></label>
            </div>

            <div class="mode-bar">
              <div class="segmented">
                <button :class="{ active: settings.state.appearance === 'auto' }" @click="settings.state.appearance = 'auto'"><Monitor :size="13" /> 自动</button>
                <button :class="{ active: settings.state.appearance === 'light' }" @click="settings.state.appearance = 'light'"><Sun :size="13" /> 浅色</button>
                <button :class="{ active: settings.state.appearance === 'dark' }" @click="settings.state.appearance = 'dark'"><Moon :size="13" /> 深色</button>
              </div>

              <div class="segmented">
                <button :class="{ active: settings.state.renderColorMode === 'colorful' }" @click="settings.state.renderColorMode = 'colorful'"><Palette :size="13" /> 彩色渲染</button>
                <button :class="{ active: settings.state.renderColorMode === 'monochrome' }" @click="settings.state.renderColorMode = 'monochrome'"><Mountain :size="13" /> 单色渲染</button>
              </div>
            </div>

            <p class="color-mode-hint">
              <strong>彩色渲染</strong>：使用主题配色区分标题、加粗、行内代码、链接与引用线；
              <strong>单色渲染</strong>：将所有 Markdown 语法统一为黑白灰墨色层级，专注写作与纸质阅读体验。
            </p>

            <div class="theme-grid">
              <div
                v-for="t in visibleThemes"
                :key="t.id"
                class="theme-card"
                :class="{ selected: activeThemeId === t.id }"
                :style="{ background: t.bgBase, borderColor: activeThemeId === t.id ? t.accent : t.border, color: t.textPrimary }"
                @click="selectTheme(t.id, t.mode)"
              >
                <div class="theme-card-top">
                  <div class="swatches"><span v-for="(c, idx) in t.swatches" :key="idx" class="swatch-dot" :style="{ background: c }" /></div>
                  <button
                    v-if="isCustomTheme(t.id)"
                    type="button"
                    class="theme-del-btn"
                    title="删除此自定义主题"
                    @click.stop="handleDeleteCustomTheme(t.id)"
                  >
                    <Trash2 :size="12" />
                  </button>
                </div>
                <div class="theme-card-footer">
                  <span class="theme-card-name">{{ t.name }}</span>
                  <span v-if="isCustomTheme(t.id)" class="custom-tag">自定义</span>
                </div>
              </div>

              <!-- Add New Custom Theme Card -->
              <button type="button" class="theme-card theme-add-card" @click="startNewCustomTheme">
                <Plus :size="16" />
                <span>新增自定义配色</span>
              </button>
            </div>

            <!-- Custom Theme Editor: Visual Color Pickers + YAML Code Import/Export -->
            <div class="custom-colors-section">
              <div class="custom-colors-header">
                <div class="segmented compact">
                  <button
                    :class="{ active: themeEditorMode === 'visual' }"
                    @click="themeEditorMode = 'visual'"
                  >
                    <Palette :size="12" /> 可视化微调
                  </button>
                  <button
                    :class="{ active: themeEditorMode === 'yaml' }"
                    @click="themeEditorMode = 'yaml'; syncYamlFromEffective(false)"
                  >
                    <Code2 :size="12" /> YAML 代码编辑
                  </button>
                </div>

                <div class="theme-io-actions">
                  <button class="mini-action-btn" @click="handleCopyYaml" title="复制当前配色 YAML">
                    <Copy :size="12" /> 复制
                  </button>
                  <button class="mini-action-btn" @click="handlePasteYaml" title="从剪贴板粘贴 YAML">
                    <ClipboardPaste :size="12" /> 粘贴
                  </button>
                  <button class="mini-action-btn" @click="triggerImportYamlFile" title="导入 .yaml 配色文件">
                    <Upload :size="12" /> 导入
                  </button>
                  <button class="mini-action-btn" @click="handleExportYamlFile" title="导出为 .yaml 文件">
                    <Download :size="12" /> 导出
                  </button>
                  <input
                    ref="yamlFileInputRef"
                    type="file"
                    accept=".yaml,.yml,.txt"
                    style="display: none"
                    @change="handleImportYamlFile"
                  />
                </div>
              </div>

              <!-- Visual Color Picker Grid -->
              <template v-if="themeEditorMode === 'visual'">
                <div class="custom-color-grid">
                  <label
                    v-for="field in CUSTOM_COLOR_FIELDS"
                    :key="field.key"
                    class="color-chip-item"
                    :class="{ customized: Boolean(settings.state.customColors[field.key]) }"
                  >
                    <input
                      type="color"
                      class="color-input"
                      :value="getColorPickerValue(field.key)"
                      @input="onCustomColorInput(field.key, $event)"
                    />
                    <div class="color-chip-meta">
                      <span class="color-chip-label">{{ field.label }}</span>
                      <span class="color-chip-hex">{{ getColorPickerValue(field.key) }}</span>
                    </div>
                    <button
                      v-if="settings.state.customColors[field.key]"
                      type="button"
                      class="color-reset-dot"
                      title="恢复预设颜色"
                      @click.prevent="settings.setCustomColor(field.key, '')"
                    >
                      <RotateCcw :size="11" />
                    </button>
                  </label>
                </div>

                <div class="yaml-footer-bar">
                  <span v-if="yamlFeedback" class="yaml-ok-msg">{{ yamlFeedback }}</span>
                  <span v-else class="yaml-tip-msg">微调后可点击右侧保存为独立的新主题卡片</span>
                  <div class="yaml-footer-btns">
                    <button v-if="hasCustomColors" class="mini-action-btn" @click="settings.resetCustomColors()">
                      <RotateCcw :size="12" /> 重置微调
                    </button>
                    <button class="mini-action-btn accent" @click="handleSaveVisualAsNewTheme">
                      <Save :size="12" /> 另存为新主题
                    </button>
                  </div>
                </div>
              </template>

              <!-- YAML Code Editor -->
              <template v-else>
                <textarea
                  v-model="yamlDraft"
                  class="yaml-editor-textarea"
                  spellcheck="false"
                  placeholder="粘贴或编写 Folia 主题 YAML 配置..."
                />
                <div v-if="yamlError" class="yaml-error-msg">
                  <AlertCircle :size="13" /> {{ yamlError }}
                </div>
                <div class="yaml-footer-bar">
                  <span v-if="yamlFeedback" class="yaml-ok-msg">{{ yamlFeedback }}</span>
                  <span v-else class="yaml-tip-msg">
                    支持 <code>name</code>、<code>mode: light|dark</code> 与 <code>colors</code>，未写字段自动补全
                  </span>
                  <div class="yaml-footer-btns">
                    <button
                      v-if="editingCustomThemeId"
                      class="mini-action-btn"
                      @click="handleUpdateEditingCustomTheme"
                    >
                      <Save :size="12" /> 更新当前主题
                    </button>
                    <button class="mini-action-btn accent" @click="handleSaveYamlAsNew">
                      <Plus :size="12" /> 保存为新主题
                    </button>
                  </div>
                </div>
              </template>
            </div>

            <h2 class="section-title" style="margin-top: 26px">字体与缩放</h2>

            <div class="form-row">
              <span class="row-label">界面字体</span>
              <input v-model="settings.state.uiFont" placeholder="留空则使用系统默认中文字体" class="pill-input" />
            </div>

            <div class="form-row">
              <span class="row-label">编辑器字体</span>
              <input v-model="settings.state.editorFont" placeholder="例如 Consolas, JetBrains Mono" class="pill-input" />
            </div>

            <div class="form-row">
              <span class="row-label">编辑器字号 / 行高</span>
              <div class="inline-controls">
                <input type="number" v-model.number="settings.state.editorFontSize" min="12" max="26" class="num-input" />
                <span class="unit">px</span>
                <input type="number" v-model.number="settings.state.editorLineHeight" step="0.05" min="1.3" max="2.4" class="num-input" />
                <span class="unit">倍行距</span>
              </div>
            </div>

            <div class="form-row">
              <span class="row-label">界面缩放系数</span>
              <div class="stepper">
                <button @click="adjustScale(-0.1)">-</button>
                <span>{{ settings.state.uiScale.toFixed(1) }}</span>
                <button @click="adjustScale(0.1)">+</button>
              </div>
            </div>
          </div>

          <!-- TAB 2: EDITOR, SAVING & ATTACHMENTS -->
          <div v-else-if="activeTab === 'editor'" class="settings-page">
            <h2 class="section-title">编辑与视图</h2>
            <div class="form-row">
              <span class="row-label">默认编辑模式</span>
              <div class="segmented">
                <button :class="{ active: settings.state.defaultEditMode === 'live' }" @click="settings.state.defaultEditMode = 'live'">实时预览</button>
                <button :class="{ active: settings.state.defaultEditMode === 'source' }" @click="settings.state.defaultEditMode = 'source'">源码模式</button>
              </div>
            </div>
            <div class="form-row"><span class="row-label">显示行号</span><label class="toggle-wrap"><input type="checkbox" v-model="settings.state.showLineNumbers" /><span class="toggle-track" /><span class="toggle-text">{{ settings.state.showLineNumbers ? "开启" : "关闭" }}</span></label></div>
            <div class="form-row"><span class="row-label">显示右侧缩略图</span><label class="toggle-wrap"><input type="checkbox" v-model="settings.state.showMinimap" /><span class="toggle-track" /><span class="toggle-text">{{ settings.state.showMinimap ? "开启" : "关闭" }}</span></label></div>
            <div class="form-row"><span class="row-label">自动换行</span><label class="toggle-wrap"><input type="checkbox" v-model="settings.state.wordWrap" /><span class="toggle-track" /><span class="toggle-text">{{ settings.state.wordWrap ? "开启" : "关闭" }}</span></label></div>
            <div class="form-row">
              <span class="row-label">双向链接写入格式</span>
              <div class="segmented">
                <button :class="{ active: settings.state.linkInsertFormat === 'markdown' }" @click="settings.state.linkInsertFormat = 'markdown'">标准相对路径 [名称](路径.md)</button>
                <button :class="{ active: settings.state.linkInsertFormat === 'wikilink' }" @click="settings.state.linkInsertFormat = 'wikilink'">[[双链语法]]</button>
              </div>
            </div>

            <h2 class="section-title" style="margin-top: 24px">自动保存与防覆盖</h2>
            <div class="form-row"><span class="row-label">开启自动保存</span><label class="toggle-wrap"><input type="checkbox" v-model="settings.state.autoSaveEnabled" /><span class="toggle-track" /><span class="toggle-text">{{ settings.state.autoSaveEnabled ? "开启" : "关闭" }}</span></label></div>
            <div class="form-row">
              <span class="row-label">自动保存延迟</span>
              <div class="inline-controls"><input type="number" v-model.number="settings.state.autoSaveDelayMs" step="200" min="300" max="10000" class="num-input" /><span class="unit">毫秒 (ms)</span></div>
            </div>

            <h2 class="section-title" style="margin-top: 24px">图片与附件保存位置</h2>
            <div class="form-row">
              <span class="row-label">粘贴/拖入图片位置</span>
              <select v-model="settings.state.imageSaveStrategy" class="pill-select">
                <option value="noteSubfolder">当前笔记所在目录的子文件夹</option>
                <option value="sameDir">与当前笔记同级目录</option>
                <option value="workspaceSubfolder">工作区根目录下的子文件夹</option>
              </select>
            </div>
            <div v-if="settings.state.imageSaveStrategy !== 'sameDir'" class="form-row">
              <span class="row-label">子文件夹名称</span>
              <input v-model="settings.state.imageSubfolderName" class="pill-input" placeholder="images" />
            </div>
          </div>

          <!-- TAB 3: EDITABLE SHORTCUTS & MOUSE GESTURES -->
          <div v-else-if="activeTab === 'shortcuts'" class="settings-page">
            <div class="section-header-row">
              <h2 class="section-title no-border">鼠标手势（按住鼠标右键拖动）</h2>
              <div class="section-header-actions">
                <button class="mini-action-btn" @click="settings.addGesture()">
                  <Plus :size="13" /> 添加手势
                </button>
                <button class="mini-action-btn" @click="settings.resetAllGestures()">
                  <RotateCcw :size="12" /> 恢复默认
                </button>
              </div>
            </div>

            <div class="form-row">
              <span class="row-label">启用右键鼠标手势</span>
              <label class="toggle-wrap">
                <input type="checkbox" v-model="settings.state.mouseGesturesEnabled" />
                <span class="toggle-track" />
                <span class="toggle-text">{{ settings.state.mouseGesturesEnabled ? "开启" : "关闭" }}</span>
              </label>
            </div>

            <p class="edit-hint">
              在“按住拖动录制”按钮上直接拖动鼠标即可录制新轨迹，或直接输入方向字母（L=左、R=右、U=上、D=下）。
            </p>

            <div class="shortcut-list" style="margin-bottom: 24px">
              <div
                v-for="(g, idx) in settings.state.customGestures"
                :key="idx"
                class="gesture-edit-row"
              >
                <button
                  class="gesture-record-btn"
                  :class="{ recording: recordingGestureIdx === idx }"
                  data-gesture-recorder="true"
                  @mousedown="startGesturePadDown(idx, $event)"
                  @contextmenu.prevent
                  title="按住鼠标左键或右键并拖动以录制轨迹"
                >
                  <template v-if="recordingGestureIdx === idx">
                    {{ gestureDraftSeq ? formatGestureSequence(gestureDraftSeq) : "拖动录制中..." }}
                  </template>
                  <template v-else>
                    {{ formatGestureSequence(g.sequence) || "拖动录制" }}
                  </template>
                </button>

                <input
                  :value="g.sequence"
                  @input="onGestureSeqInput(idx, $event)"
                  placeholder="如 L / DR"
                  maxlength="4"
                  class="seq-input"
                  title="手动输入方向序列（L/R/U/D）"
                />

                <select
                  :value="g.action"
                  @change="onGestureActionChange(idx, $event)"
                  class="gesture-action-select"
                >
                  <option v-for="opt in GESTURE_ACTION_OPTIONS" :key="opt.value" :value="opt.value">
                    {{ opt.label }}
                  </option>
                </select>

                <button class="row-icon-btn danger" @click="settings.removeGesture(idx)" title="删除该手势">
                  <Trash2 :size="14" />
                </button>
              </div>
            </div>

            <div class="section-header-row">
              <h2 class="section-title no-border">全局快捷键</h2>
              <div class="section-header-actions">
                <button class="mini-action-btn" @click="settings.resetAllShortcuts()">
                  <RotateCcw :size="12" /> 恢复默认
                </button>
              </div>
            </div>

            <p class="edit-hint">
              点击右侧快捷键按钮后按下新的组合键即可修改；按 <kbd>Esc</kbd> 取消录制，按 <kbd>Backspace</kbd> 清除绑定。
            </p>

            <div class="shortcut-list">
              <div v-for="s in effectiveShortcuts" :key="s.id" class="shortcut-row">
                <span class="shortcut-label">{{ s.label }}</span>
                <div class="shortcut-controls">
                  <button
                    class="kbd-edit-btn"
                    :class="{ recording: recordingShortcutId === s.id, unbound: !s.combo }"
                    @click="startRecordingShortcut(s.id)"
                    title="点击后按下新快捷键"
                  >
                    {{ recordingShortcutId === s.id ? "请按下组合键..." : formatComboForPlatform(s.combo) }}
                  </button>
                  <button
                    v-if="isShortcutCustomized(s.id)"
                    class="row-icon-btn"
                    @click="settings.resetShortcut(s.id)"
                    :title="`恢复默认: ${formatComboForPlatform(DEFAULT_SHORTCUTS.find((d) => d.id === s.id)?.combo ?? '')}`"
                  >
                    <RotateCcw :size="13" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- TAB 4: TERMINAL SETTINGS -->
          <div v-else-if="activeTab === 'terminal'" class="settings-page">
            <h2 class="section-title">默认终端程序</h2>

            <div class="form-row">
              <span class="row-label">默认终端类型</span>
              <select v-model="settings.state.terminalShell" class="pill-select">
                <option value="git-bash">Git Bash（推荐默认，未安装自动回退）</option>
                <option value="powershell">PowerShell</option>
                <option value="cmd">命令提示符 (CMD)</option>
                <option value="zsh">Zsh / Bash（macOS / Linux）</option>
                <option value="custom">自定义终端路径</option>
              </select>
            </div>

            <div v-if="settings.state.terminalShell === 'custom'" class="form-row">
              <span class="row-label">自定义程序路径</span>
              <input
                v-model="settings.state.terminalCustomPath"
                placeholder="例如 C:\Program Files\Git\bin\bash.exe"
                class="pill-input"
              />
            </div>

            <div v-if="detectedShells.length > 0" class="shell-detect-box">
              <div class="shell-detect-title">本机已探测到的终端：</div>
              <div v-for="sh in detectedShells" :key="sh.id" class="shell-detect-row">
                <span class="sd-name">{{ sh.label }}</span>
                <span class="sd-status" :class="{ ok: sh.available }">
                  {{ sh.available ? sh.path || "可用" : "未检测到" }}
                </span>
              </div>
            </div>

            <h2 class="section-title" style="margin-top: 24px">终端外观与字体</h2>

            <div class="form-row">
              <span class="row-label">终端字体</span>
              <input
                v-model="settings.state.terminalFont"
                placeholder="Cascadia Mono, Consolas, JetBrains Mono, monospace"
                class="pill-input"
              />
            </div>

            <div class="form-row">
              <span class="row-label">字号 / 行高</span>
              <div class="inline-controls">
                <input
                  type="number"
                  v-model.number="settings.state.terminalFontSize"
                  min="10"
                  max="26"
                  class="num-input"
                />
                <span class="unit">px</span>
                <input
                  type="number"
                  v-model.number="settings.state.terminalLineHeight"
                  step="0.05"
                  min="1.0"
                  max="2.0"
                  class="num-input"
                />
                <span class="unit">倍行距</span>
              </div>
            </div>

            <div class="form-row">
              <span class="row-label">光标样式</span>
              <div class="segmented">
                <button
                  :class="{ active: settings.state.terminalCursorStyle === 'bar' }"
                  @click="settings.state.terminalCursorStyle = 'bar'"
                >
                  竖线
                </button>
                <button
                  :class="{ active: settings.state.terminalCursorStyle === 'block' }"
                  @click="settings.state.terminalCursorStyle = 'block'"
                >
                  方块
                </button>
                <button
                  :class="{ active: settings.state.terminalCursorStyle === 'underline' }"
                  @click="settings.state.terminalCursorStyle = 'underline'"
                >
                  下划线
                </button>
              </div>
            </div>

            <p class="edit-hint">
              点击左侧栏任意笔记库横条上的终端图标，将在右侧打开对应路径的命令分栏；支持 Ctrl+Shift+C 复制与 Ctrl+Shift+V 粘贴。
            </p>
          </div>

          <!-- TAB 5: ABOUT & AUTO UPDATE -->
          <div v-else class="settings-page">
            <h2 class="section-title">关于 Folia</h2>

            <div class="about-hero">
              <img src="/logo.svg" alt="Folia Logo" class="about-logo" />
              <div class="about-meta">
                <div class="about-title-row">
                  <span class="about-name">Folia</span>
                  <span class="version-badge">v{{ APP_VERSION }}</span>
                </div>
                <p class="about-desc">
                  本地文件夹优先、零隐藏数据库的轻量跨平台 Markdown 笔记工作台。
                </p>
              </div>
            </div>

            <div class="about-info-list">
              <div class="about-info-row">
                <span class="about-key">作者</span>
                <span class="about-val">
                  {{ APP_AUTHOR }}（
                  <button class="link-btn" @click="openExternal(APP_AUTHOR_URL)">
                    mianao.info <ExternalLink :size="12" />
                  </button>
                  ）
                </span>
              </div>
              <div class="about-info-row">
                <span class="about-key">当前版本</span>
                <span class="about-val mono">v{{ APP_VERSION }}</span>
              </div>
              <div class="about-info-row">
                <span class="about-key">开源协议</span>
                <span class="about-val">{{ APP_LICENSE }}</span>
              </div>
              <div class="about-info-row">
                <span class="about-key">项目仓库</span>
                <button class="link-btn" @click="openExternal(GITHUB_REPO_URL)">
                  github.com/harry10086/Folia <ExternalLink :size="12" />
                </button>
              </div>
            </div>

            <h2 class="section-title" style="margin-top: 26px">自动更新</h2>

            <div class="form-row">
              <span class="row-label">启动时自动检查更新</span>
              <label class="toggle-wrap">
                <input type="checkbox" v-model="settings.state.autoCheckUpdates" />
                <span class="toggle-track" />
                <span class="toggle-text">{{ settings.state.autoCheckUpdates ? "开启" : "关闭" }}</span>
              </label>
            </div>

            <div class="update-actions-row">
              <button
                class="update-check-btn"
                :disabled="checkingUpdate"
                @click="handleCheckUpdate"
              >
                <RefreshCw :size="14" :class="{ spin: checkingUpdate }" />
                <span>{{ checkingUpdate ? "正在检查 GitHub Release..." : "检查 GitHub 新版本" }}</span>
              </button>
            </div>

            <div v-if="updateResult" class="update-result-card" :class="updateResult.status">
              <template v-if="updateResult.status === 'update-available'">
                <div class="ur-head">
                  <Download :size="16" />
                  <strong>发现新版本 {{ updateResult.latestVersion }}</strong>
                </div>
                <p v-if="updateResult.notes" class="ur-notes">{{ updateResult.notes.slice(0, 320) }}</p>
                <div class="ur-actions">
                  <button class="update-download-btn" @click="openExternal(updateResult.releaseUrl)">
                    <ExternalLink :size="13" /> 前往 GitHub 下载更新
                  </button>
                </div>
              </template>

              <template v-else-if="updateResult.status === 'up-to-date'">
                <div class="ur-head">
                  <CheckCircle2 :size="16" />
                  <span>当前已是最新版本（v{{ updateResult.currentVersion }}，远端最新 {{ updateResult.latestVersion }}）</span>
                </div>
                <div class="ur-actions">
                  <button class="mini-action-btn" @click="openExternal(updateResult.releaseUrl)">
                    <ExternalLink :size="12" /> 查看版本发布页
                  </button>
                </div>
              </template>

              <template v-else-if="updateResult.status === 'no-release'">
                <div class="ur-head">
                  <CheckCircle2 :size="16" />
                  <span>GitHub 仓库暂未发布正式 Release（当前版本 v{{ updateResult.currentVersion }}）</span>
                </div>
                <div class="ur-actions">
                  <button class="mini-action-btn" @click="openExternal(updateResult.releaseUrl)">
                    <ExternalLink :size="12" /> 查看仓库 Releases
                  </button>
                </div>
              </template>

              <template v-else>
                <div class="ur-head">
                  <AlertCircle :size="16" />
                  <span>检查更新失败：{{ updateResult.errorMessage }}</span>
                </div>
                <div class="ur-actions">
                  <button class="mini-action-btn" @click="openExternal(updateResult.releaseUrl)">
                    <ExternalLink :size="12" /> 手动前往 GitHub Releases
                  </button>
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.settings-backdrop { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.38); display: flex; align-items: center; justify-content: center; z-index: 3300; padding: 20px; }
.settings-modal { width: min(880px, 92vw); height: min(680px, 86vh); background: var(--bg-elevated); border: 1px solid var(--border-color); border-radius: var(--radius-lg); box-shadow: var(--shadow-md); display: flex; overflow: hidden; position: relative; }
.settings-sidebar { width: 205px; background: var(--bg-base); border-right: 1px solid var(--border-color); padding: 18px 10px; display: flex; flex-direction: column; gap: 4px; }
.settings-brand { font-size: 14px; font-weight: 700; padding: 4px 10px 14px; color: var(--text-primary); }
.s-nav-item { border: none; background: transparent; text-align: left; padding: 9px 12px; border-radius: var(--radius-sm); font-size: 13px; color: var(--text-secondary); cursor: pointer; }
.s-nav-item:hover { background: var(--bg-hover); color: var(--text-primary); }
.s-nav-item.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.settings-sidebar-footer { margin-top: auto; padding-top: 12px; }
.reset-btn { width: 100%; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 7px 10px; border: 1px solid var(--border-color); background: transparent; color: var(--text-muted); border-radius: var(--radius-sm); font-size: 12px; cursor: pointer; }
.reset-btn:hover { color: var(--text-primary); border-color: var(--text-muted); }
.settings-content { flex: 1; overflow-y: auto; padding: 24px 30px; position: relative; }
.close-btn { position: sticky; top: 0; float: right; border: none; background: var(--bg-base); color: var(--text-muted); width: 30px; height: 30px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; z-index: 2; }
.close-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.section-title { font-size: 14px; font-weight: 700; margin: 0 0 16px; padding-bottom: 8px; border-bottom: 1px solid var(--border-color); color: var(--text-primary); }
.section-title.no-border { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
.section-header-row { display: flex; align-items: center; justify-content: space-between; padding-bottom: 8px; margin-bottom: 14px; border-bottom: 1px solid var(--border-color); }
.section-header-actions { display: flex; align-items: center; gap: 6px; margin-right: 36px; }
.mini-action-btn { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border-radius: var(--radius-pill); border: 1px solid var(--border-color); background: var(--bg-base); color: var(--text-secondary); font-size: 12px; cursor: pointer; }
.mini-action-btn:hover { border-color: var(--accent); color: var(--accent); }
.edit-hint { font-size: 12px; color: var(--text-muted); margin: 0 0 10px; }
.form-row { display: flex; align-items: center; gap: 16px; margin-bottom: 14px; }
.row-label { width: 150px; flex-shrink: 0; font-size: 13px; color: var(--text-secondary); }
.segmented { display: inline-flex; border: 1px solid var(--border-color); border-radius: var(--radius-pill); padding: 2px; background: var(--bg-base); gap: 2px; }
.segmented button { display: inline-flex; align-items: center; gap: 5px; border: none; background: transparent; padding: 5px 13px; border-radius: var(--radius-pill); font-size: 12.5px; color: var(--text-secondary); cursor: pointer; }
.segmented button.active { background: var(--bg-active); color: var(--text-primary); font-weight: 600; }
.toggle-wrap { display: inline-flex; align-items: center; gap: 10px; cursor: pointer; }
.toggle-wrap input { display: none; }
.toggle-track { width: 40px; height: 22px; border-radius: 999px; background: var(--border-color); position: relative; transition: background 0.16s; }
.toggle-track::after { content: ""; position: absolute; width: 16px; height: 16px; border-radius: 50%; background: #ffffff; top: 3px; left: 3px; transition: transform 0.16s; }
.toggle-wrap input:checked + .toggle-track { background: var(--text-primary); }
.toggle-wrap input:checked + .toggle-track::after { transform: translateX(18px); }
.toggle-text { font-size: 12.5px; color: var(--text-secondary); }
.mode-bar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin: 18px 0 8px; }
.color-mode-hint { margin: 0 0 14px; font-size: 12px; line-height: 1.55; color: var(--text-muted); background: var(--bg-base); padding: 8px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-color); }
.color-mode-hint strong { color: var(--text-secondary); font-weight: 600; }
.theme-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(145px, 1fr)); gap: 10px; }
.theme-card { border: 2px solid transparent; border-radius: var(--radius-md); padding: 10px 12px; text-align: left; cursor: pointer; transition: transform 0.12s ease, box-shadow 0.12s ease; position: relative; }
.theme-card:hover { transform: translateY(-1px); }
.theme-card.selected { box-shadow: 0 0 0 1px var(--accent); }
.theme-card-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.swatches { display: flex; gap: 5px; }
.swatch-dot { width: 11px; height: 11px; border-radius: 50%; }
.theme-card-footer { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
.theme-card-name { font-size: 12px; font-weight: 500; font-family: var(--font-editor); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.custom-tag { font-size: 10px; padding: 1px 5px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); flex-shrink: 0; }
.theme-del-btn { width: 20px; height: 20px; border: none; border-radius: 4px; background: transparent; color: inherit; opacity: 0.45; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.theme-card:hover .theme-del-btn { opacity: 0.9; }
.theme-del-btn:hover { background: color-mix(in srgb, var(--danger) 18%, transparent); color: var(--danger); opacity: 1; }
.theme-add-card { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px; border: 1.5px dashed var(--border-color); background: var(--bg-base); color: var(--text-muted); font-size: 12px; min-height: 60px; }
.theme-add-card:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }

.custom-colors-section { margin-top: 18px; padding: 12px 14px; border-radius: var(--radius-md); background: var(--bg-base); border: 1px solid var(--border-color); }
.custom-colors-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.segmented.compact button { padding: 4px 10px; font-size: 12px; }
.theme-io-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.mini-action-btn.accent { border-color: var(--accent); color: var(--accent); background: var(--bg-surface); font-weight: 500; }
.mini-action-btn.accent:hover { background: var(--accent-soft); }
.custom-color-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(156px, 1fr)); gap: 8px; }
.color-chip-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: var(--radius-sm); background: var(--bg-surface); border: 1px solid var(--border-color); cursor: pointer; }
.color-chip-item.customized { border-color: var(--accent); }
.color-input { width: 24px; height: 24px; padding: 0; border: 1px solid var(--border-color); border-radius: 5px; background: transparent; cursor: pointer; flex-shrink: 0; }
.color-chip-meta { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.color-chip-label { font-size: 12px; color: var(--text-primary); line-height: 1.25; }
.color-chip-hex { font-size: 10.5px; font-family: var(--font-editor); color: var(--text-muted); text-transform: uppercase; }
.color-reset-dot { width: 20px; height: 20px; border: none; background: transparent; color: var(--text-muted); border-radius: 4px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.color-reset-dot:hover { background: var(--bg-hover); color: var(--accent); }

.yaml-editor-textarea {
  width: 100%;
  min-height: 220px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-family: var(--font-editor);
  font-size: 12px;
  line-height: 1.55;
  resize: vertical;
  outline: none;
}
.yaml-editor-textarea:focus { border-color: var(--accent); }
.yaml-error-msg {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  color: var(--danger);
  font-size: 12px;
}
.yaml-footer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
.yaml-tip-msg { font-size: 11.5px; color: var(--text-muted); }
.yaml-tip-msg code { font-family: var(--font-editor); background: var(--bg-surface); padding: 1px 4px; border-radius: 3px; }
.yaml-ok-msg { font-size: 12px; color: var(--accent); font-weight: 500; }
.yaml-footer-btns { display: flex; align-items: center; gap: 6px; }

.pill-input, .pill-select { flex: 1; max-width: 360px; height: 34px; padding: 0 14px; border: 1px solid var(--border-color); border-radius: var(--radius-pill); background: var(--bg-base); color: var(--text-primary); font-size: 13px; outline: none; }
.pill-input:focus, .pill-select:focus { border-color: var(--accent); }
.inline-controls { display: flex; align-items: center; gap: 8px; }
.num-input { width: 78px; height: 32px; padding: 0 10px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-base); color: var(--text-primary); font-size: 13px; }
.unit { font-size: 12px; color: var(--text-muted); }
.stepper { display: inline-flex; align-items: center; border: 1px solid var(--border-color); border-radius: var(--radius-pill); overflow: hidden; background: var(--bg-base); }
.stepper button { width: 34px; height: 32px; border: none; background: transparent; cursor: pointer; font-size: 15px; }
.stepper button:hover { background: var(--bg-hover); }
.stepper span { min-width: 48px; text-align: center; font-size: 13px; font-weight: 600; }

.shortcut-list { display: flex; flex-direction: column; gap: 6px; }
.shortcut-row,
.gesture-edit-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 10px; border-radius: var(--radius-sm); background: var(--bg-base); font-size: 13px; }
.shortcut-controls { display: flex; align-items: center; gap: 6px; }

.kbd-edit-btn {
  min-width: 118px;
  height: 28px;
  padding: 0 10px;
  font-family: var(--font-editor);
  font-size: 12px;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  color: var(--text-primary);
  cursor: pointer;
  transition: border-color 0.14s, background 0.14s;
}
.kbd-edit-btn:hover { border-color: var(--accent); }
.kbd-edit-btn.recording {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
.kbd-edit-btn.unbound { color: var(--text-muted); }

.gesture-record-btn {
  min-width: 96px;
  height: 28px;
  padding: 0 10px;
  border: 1px dashed var(--border-color);
  border-radius: 6px;
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 600;
  cursor: grab;
  user-select: none;
}
.gesture-record-btn:hover,
.gesture-record-btn.recording {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}
.seq-input {
  width: 68px;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-surface);
  color: var(--text-primary);
  font-family: var(--font-editor);
  font-size: 12px;
  text-transform: uppercase;
  text-align: center;
}
.gesture-action-select {
  flex: 1;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 12.5px;
}
.row-icon-btn {
  width: 26px;
  height: 26px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.row-icon-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.row-icon-btn.danger:hover { color: var(--danger); }

.shell-detect-box { margin-top: 8px; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--bg-base); border: 1px solid var(--border-color); font-size: 12px; display: flex; flex-direction: column; gap: 6px; }
.shell-detect-title { font-weight: 600; color: var(--text-secondary); }
.shell-detect-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.sd-name { color: var(--text-primary); }
.sd-status { font-family: var(--font-editor); font-size: 11.5px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 340px; }
.sd-status.ok { color: var(--accent); }

/* About & Update tab */
.about-hero { display: flex; align-items: center; gap: 16px; padding: 14px 16px; border-radius: var(--radius-md); background: var(--bg-base); border: 1px solid var(--border-color); margin-bottom: 16px; }
.about-logo { width: 54px; height: 54px; border-radius: 13px; flex-shrink: 0; }
.about-meta { flex: 1; min-width: 0; }
.about-title-row { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
.about-name { font-size: 20px; font-weight: 700; color: var(--text-primary); }
.version-badge { font-size: 11.5px; font-family: var(--font-editor); padding: 2px 8px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.about-desc { margin: 0; font-size: 12.5px; color: var(--text-muted); line-height: 1.5; }

.about-info-list { display: flex; flex-direction: column; gap: 8px; padding: 12px 16px; border-radius: var(--radius-md); background: var(--bg-base); border: 1px solid var(--border-color); }
.about-info-row { display: flex; align-items: center; font-size: 13px; gap: 12px; }
.about-key { width: 92px; flex-shrink: 0; color: var(--text-muted); }
.about-val { color: var(--text-primary); display: inline-flex; align-items: center; }
.about-val.mono { font-family: var(--font-editor); }
.link-btn { display: inline-flex; align-items: center; gap: 4px; border: none; background: transparent; color: var(--accent); font-size: 13px; padding: 0; cursor: pointer; }
.link-btn:hover { text-decoration: underline; }

.update-actions-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 8px; }
.update-check-btn { display: inline-flex; align-items: center; gap: 7px; padding: 7px 15px; border-radius: var(--radius-pill); border: 1px solid var(--border-color); background: var(--bg-base); color: var(--text-primary); font-size: 13px; font-weight: 500; cursor: pointer; transition: border-color 0.14s, background 0.14s, color 0.14s; }
.update-check-btn:hover:not(:disabled) { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.update-check-btn:disabled { opacity: 0.65; cursor: wait; }
.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.update-result-card { margin-top: 14px; padding: 12px 14px; border-radius: var(--radius-md); border: 1px solid var(--border-color); background: var(--bg-base); font-size: 12.5px; }
.update-result-card.update-available { border-color: var(--accent); background: var(--accent-soft); }
.ur-head { display: flex; align-items: center; gap: 8px; color: var(--text-primary); }
.ur-notes { margin: 8px 0 0; font-size: 12px; color: var(--text-secondary); white-space: pre-wrap; line-height: 1.5; }
.ur-actions { margin-top: 10px; display: flex; gap: 8px; }
.update-download-btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; border-radius: var(--radius-pill); border: 1px solid var(--accent); background: var(--bg-surface); color: var(--accent); font-size: 12.5px; font-weight: 600; cursor: pointer; transition: background 0.14s; }
.update-download-btn:hover { background: var(--accent-soft); }
</style>
