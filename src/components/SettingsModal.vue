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
  getShortcutLabel,
} from "@/core/shortcuts/keymap";
import {
  GESTURE_ACTION_OPTIONS,
  formatGestureSequence,
  getGestureActionLabel,
  type GestureActionId,
} from "@/core/gestures/mouseGestures";
import { LOCALE_OPTIONS, useI18n, type MessageKey } from "@/core/i18n";
import {
  APP_AUTHOR,
  APP_AUTHOR_URL,
  APP_LICENSE,
  APP_VERSION,
  GITHUB_REPO_URL,
  checkGithubUpdate,
  type UpdateCheckResult,
} from "@/core/update/updater";
import { ipc, isTauriRuntime, type DetectedShellInfo, type HistoryStats } from "@/core/ipc/client";
import { useSettingsStore } from "@/stores/settings";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: "close"): void }>();

const settings = useSettingsStore();
const { t } = useI18n();
const activeTab = ref<"theme" | "editor" | "shortcuts" | "terminal" | "about">("theme");
const detectedShells = ref<DetectedShellInfo[]>([]);
const historyCacheStats = ref<HistoryStats>({ totalSnapshots: 0, totalBytes: 0 });
const historyClearFeedback = ref<string | null>(null);

async function refreshHistoryStats() {
  if (!isTauriRuntime()) return;
  try {
    historyCacheStats.value = await ipc.historyStats();
  } catch {
    // ignore
  }
}

async function handleClearAllHistory() {
  if (!isTauriRuntime()) return;
  try {
    const count = await ipc.historyClearAll();
    await refreshHistoryStats();
    historyClearFeedback.value = count > 0 ? t("settings.historyCleared", { count }) : t("settings.historyNone");
    setTimeout(() => {
      historyClearFeedback.value = null;
    }, 2500);
  } catch {
    historyClearFeedback.value = t("settings.historyClearFailed");
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen && isTauriRuntime()) {
      void refreshHistoryStats();
      if (detectedShells.value.length === 0) {
        try {
          detectedShells.value = await ipc.terminalListShells();
        } catch {
          // ignore
        }
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
  flashYamlFeedback(t("settings.yamlMsgTemplate"));
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
  flashYamlFeedback(t("settings.yamlMsgAdded", { name: parsed.theme.name }));
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
  flashYamlFeedback(t("settings.yamlMsgUpdated", { name: parsed.theme.name }));
}

function handleSaveVisualAsNewTheme() {
  const cur = effectivePalette.value;
  const baseName = cur.name.replace(/\s*Custom$/i, "");
  const count = (settings.state.customThemes ?? []).length + 1;
  const newTheme: ThemePalette = {
    ...cur,
    id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: `${baseName} ${t("common.custom")} ${count}`,
    swatches: [cur.bold, cur.accent, cur.heading, cur.textPrimary, cur.bgSidebar],
  };
  settings.saveCustomTheme(newTheme);
  editingCustomThemeId.value = newTheme.id;
  yamlDraft.value = serializeThemeToYaml(newTheme);
  flashYamlFeedback(t("settings.yamlMsgSaved", { name: newTheme.name }));
}

async function handleCopyYaml() {
  const text = themeEditorMode.value === "yaml" && yamlDraft.value.trim()
    ? yamlDraft.value
    : serializeThemeToYaml(effectivePalette.value);
  try {
    await navigator.clipboard.writeText(text);
    flashYamlFeedback(t("settings.yamlMsgCopied"));
  } catch {
    yamlError.value = t("settings.yamlMsgCopyErr");
  }
}

async function handlePasteYaml() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) {
      yamlError.value = t("settings.yamlMsgEmptyClip");
      return;
    }
    themeEditorMode.value = "yaml";
    yamlDraft.value = text;
    const parsed = parseThemeYaml(text);
    if (!parsed.ok) {
      yamlError.value = parsed.error;
    } else {
      yamlError.value = null;
      flashYamlFeedback(t("settings.yamlMsgPasted", { name: parsed.theme.name }));
    }
  } catch {
    themeEditorMode.value = "yaml";
    yamlError.value = t("settings.yamlMsgPasteErr");
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
    flashYamlFeedback(t("settings.yamlMsgImported", { name: parsed.theme.name }));
  } catch {
    yamlError.value = t("settings.yamlMsgImportErr");
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
  flashYamlFeedback(t("settings.yamlMsgExported", { name: safeName }));
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
          <div class="settings-brand">{{ t("settings.brand") }}</div>
          <button class="s-nav-item" :class="{ active: activeTab === 'theme' }" @click="activeTab = 'theme'">
            {{ t("settings.navTheme") }}
          </button>
          <button class="s-nav-item" :class="{ active: activeTab === 'editor' }" @click="activeTab = 'editor'">
            {{ t("settings.navEditor") }}
          </button>
          <button class="s-nav-item" :class="{ active: activeTab === 'shortcuts' }" @click="activeTab = 'shortcuts'">
            {{ t("settings.navShortcuts") }}
          </button>
          <button class="s-nav-item" :class="{ active: activeTab === 'terminal' }" @click="activeTab = 'terminal'">
            {{ t("settings.navTerminal") }}
          </button>
          <button class="s-nav-item" :class="{ active: activeTab === 'about' }" @click="activeTab = 'about'">
            {{ t("settings.navAbout") }}
          </button>
          <div class="settings-sidebar-footer">
            <button class="reset-btn" @click="settings.resetToDefaults()">
              <RotateCcw :size="13" /> {{ t("settings.resetAll") }}
            </button>
          </div>
        </div>

        <div class="settings-content">
          <button class="close-btn" @click="stopRecordingShortcut(); emit('close')" :title="t('settings.closeTip')">
            <X :size="18" />
          </button>

          <!-- TAB 1: LANGUAGE, THEME & FONTS -->
          <div v-if="activeTab === 'theme'" class="settings-page">
            <h2 class="section-title">{{ t("settings.langSection") }}</h2>
            <div class="form-row">
              <span class="row-label">{{ t("settings.langLabel") }}</span>
              <div class="segmented">
                <button
                  v-for="opt in LOCALE_OPTIONS"
                  :key="opt.value"
                  :class="{ active: settings.state.language === opt.value }"
                  @click="settings.state.language = opt.value"
                >
                  {{ opt.value === "auto" ? t("settings.langAuto") : opt.nativeLabel }}
                </button>
              </div>
            </div>

            <h2 class="section-title" style="margin-top: 22px">{{ t("settings.themeSection") }}</h2>

            <div class="form-row">
              <span class="row-label">{{ t("settings.borderRadius") }}</span>
              <div class="segmented">
                <button :class="{ active: settings.state.borderRadius === 'none' }" @click="settings.state.borderRadius = 'none'">{{ t("settings.radiusNone") }}</button>
                <button :class="{ active: settings.state.borderRadius === 'half' }" @click="settings.state.borderRadius = 'half'">{{ t("settings.radiusHalf") }}</button>
                <button :class="{ active: settings.state.borderRadius === 'full' }" @click="settings.state.borderRadius = 'full'">{{ t("settings.radiusFull") }}</button>
              </div>
            </div>

            <div class="form-row">
              <span class="row-label">{{ t("settings.darkSidebarAlways") }}</span>
              <label class="toggle-wrap"><input type="checkbox" v-model="settings.state.darkSidebarAlways" /><span class="toggle-track" /><span class="toggle-text">{{ settings.state.darkSidebarAlways ? t("common.on") : t("common.off") }}</span></label>
            </div>

            <div class="mode-bar">
              <div class="segmented">
                <button :class="{ active: settings.state.appearance === 'auto' }" @click="settings.state.appearance = 'auto'"><Monitor :size="13" /> {{ t("settings.appearanceAuto") }}</button>
                <button :class="{ active: settings.state.appearance === 'light' }" @click="settings.state.appearance = 'light'"><Sun :size="13" /> {{ t("settings.appearanceLight") }}</button>
                <button :class="{ active: settings.state.appearance === 'dark' }" @click="settings.state.appearance = 'dark'"><Moon :size="13" /> {{ t("settings.appearanceDark") }}</button>
              </div>

              <div class="segmented">
                <button :class="{ active: settings.state.renderColorMode === 'colorful' }" @click="settings.state.renderColorMode = 'colorful'"><Palette :size="13" /> {{ t("settings.renderColorful") }}</button>
                <button :class="{ active: settings.state.renderColorMode === 'monochrome' }" @click="settings.state.renderColorMode = 'monochrome'"><Mountain :size="13" /> {{ t("settings.renderMonochrome") }}</button>
              </div>
            </div>

            <p class="setting-hint">
              <strong>{{ t("settings.colorModeHintColorful") }}</strong>{{ t("settings.colorModeHintColorfulDesc") }}
              <strong>{{ t("settings.colorModeHintMono") }}</strong>{{ t("settings.colorModeHintMonoDesc") }}
            </p>

            <div class="theme-grid">
              <div
                v-for="tItem in visibleThemes"
                :key="tItem.id"
                class="theme-card"
                :class="{ selected: activeThemeId === tItem.id }"
                :style="{ background: tItem.bgBase, borderColor: activeThemeId === tItem.id ? tItem.accent : tItem.border, color: tItem.textPrimary }"
                @click="selectTheme(tItem.id, tItem.mode)"
              >
                <div class="theme-card-top">
                  <div class="swatches"><span v-for="(c, idx) in tItem.swatches" :key="idx" class="swatch-dot" :style="{ background: c }" /></div>
                  <button
                    v-if="isCustomTheme(tItem.id)"
                    type="button"
                    class="theme-del-btn"
                    :title="t('settings.deleteCustomThemeTip')"
                    @click.stop="handleDeleteCustomTheme(tItem.id)"
                  >
                    <Trash2 :size="12" />
                  </button>
                </div>
                <div class="theme-card-footer">
                  <span class="theme-card-name">{{ tItem.name }}</span>
                  <span v-if="isCustomTheme(tItem.id)" class="custom-tag">{{ t("common.custom") }}</span>
                </div>
              </div>

              <!-- Add New Custom Theme Card -->
              <button type="button" class="theme-card theme-add-card" @click="startNewCustomTheme">
                <Plus :size="16" />
                <span>{{ t("settings.addCustomTheme") }}</span>
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
                    <Palette :size="12" /> {{ t("settings.visualTweak") }}
                  </button>
                  <button
                    :class="{ active: themeEditorMode === 'yaml' }"
                    @click="themeEditorMode = 'yaml'; syncYamlFromEffective(false)"
                  >
                    <Code2 :size="12" /> {{ t("settings.yamlEdit") }}
                  </button>
                </div>

                <div class="theme-io-actions">
                  <button class="mini-action-btn" @click="handleCopyYaml" :title="t('settings.copyYamlTip')">
                    <Copy :size="12" /> {{ t("common.copy") }}
                  </button>
                  <button class="mini-action-btn" @click="handlePasteYaml" :title="t('settings.pasteYamlTip')">
                    <ClipboardPaste :size="12" /> {{ t("common.paste") }}
                  </button>
                  <button class="mini-action-btn" @click="triggerImportYamlFile" :title="t('settings.importYamlTip')">
                    <Upload :size="12" /> {{ t("common.import") }}
                  </button>
                  <button class="mini-action-btn" @click="handleExportYamlFile" :title="t('settings.exportYamlTip')">
                    <Download :size="12" /> {{ t("common.export") }}
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
                      <span class="color-chip-label">{{ t(`settings.colorLabels.${field.key}` as MessageKey) }}</span>
                      <span class="color-chip-hex">{{ getColorPickerValue(field.key) }}</span>
                    </div>
                    <button
                      v-if="settings.state.customColors[field.key]"
                      type="button"
                      class="color-reset-dot"
                      :title="t('settings.resetColorTip')"
                      @click.prevent="settings.setCustomColor(field.key, '')"
                    >
                      <RotateCcw :size="11" />
                    </button>
                  </label>
                </div>

                <div class="yaml-footer-bar">
                  <span v-if="yamlFeedback" class="yaml-ok-msg">{{ yamlFeedback }}</span>
                  <span v-else class="yaml-tip-msg">{{ t("settings.visualSaveTip") }}</span>
                  <div class="yaml-footer-btns">
                    <button v-if="hasCustomColors" class="mini-action-btn" @click="settings.resetCustomColors()">
                      <RotateCcw :size="12" /> {{ t("settings.resetTweaks") }}
                    </button>
                    <button class="mini-action-btn accent" @click="handleSaveVisualAsNewTheme">
                      <Save :size="12" /> {{ t("settings.saveAsNewTheme") }}
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
                  :placeholder="t('settings.yamlPlaceholder')"
                />
                <div v-if="yamlError" class="yaml-error-msg">
                  <AlertCircle :size="13" /> {{ yamlError }}
                </div>
                <div class="yaml-footer-bar">
                  <span v-if="yamlFeedback" class="yaml-ok-msg">{{ yamlFeedback }}</span>
                  <span v-else class="yaml-tip-msg">
                    {{ t("settings.yamlTipPrefix") }} <code>name</code> / <code>mode: light|dark</code> / <code>colors</code>{{ t("settings.yamlTipSuffix") }}
                  </span>
                  <div class="yaml-footer-btns">
                    <button
                      v-if="editingCustomThemeId"
                      class="mini-action-btn"
                      @click="handleUpdateEditingCustomTheme"
                    >
                      <Save :size="12" /> {{ t("settings.updateCurrentTheme") }}
                    </button>
                    <button class="mini-action-btn accent" @click="handleSaveYamlAsNew">
                      <Plus :size="12" /> {{ t("settings.saveNewTheme") }}
                    </button>
                  </div>
                </div>
              </template>
            </div>

            <h2 class="section-title" style="margin-top: 26px">{{ t("settings.fontsSection") }}</h2>

            <div class="form-row">
              <span class="row-label">{{ t("settings.uiFont") }}</span>
              <input v-model="settings.state.uiFont" :placeholder="t('settings.uiFontPlaceholder')" class="pill-input" />
            </div>

            <div class="form-row">
              <span class="row-label">{{ t("settings.editorFont") }}</span>
              <input v-model="settings.state.editorFont" :placeholder="t('settings.editorFontPlaceholder')" class="pill-input" />
            </div>

            <div class="form-row">
              <span class="row-label">{{ t("settings.editorFontSizeLineHeight") }}</span>
              <div class="inline-controls">
                <input type="number" v-model.number="settings.state.editorFontSize" min="12" max="26" class="num-input" />
                <span class="unit">px</span>
                <input type="number" v-model.number="settings.state.editorLineHeight" step="0.05" min="1.3" max="2.4" class="num-input" />
                <span class="unit">{{ t("settings.lineHeightUnit") }}</span>
              </div>
            </div>

            <div class="form-row">
              <span class="row-label">{{ t("settings.uiScale") }}</span>
              <div class="stepper">
                <button @click="adjustScale(-0.1)">-</button>
                <span>{{ settings.state.uiScale.toFixed(1) }}</span>
                <button @click="adjustScale(0.1)">+</button>
              </div>
            </div>
          </div>

          <!-- TAB 2: EDITOR, SAVING & ATTACHMENTS -->
          <div v-else-if="activeTab === 'editor'" class="settings-page">
            <h2 class="section-title">{{ t("settings.editorViewSection") }}</h2>
            <div class="form-row">
              <span class="row-label">{{ t("settings.defaultEditMode") }}</span>
              <div class="segmented">
                <button :class="{ active: settings.state.defaultEditMode === 'live' }" @click="settings.state.defaultEditMode = 'live'">{{ t("settings.editModeLive") }}</button>
                <button :class="{ active: settings.state.defaultEditMode === 'source' }" @click="settings.state.defaultEditMode = 'source'">{{ t("settings.editModeSource") }}</button>
              </div>
            </div>
            <div class="form-row">
              <span class="row-label">{{ t("settings.pageLayout") }}</span>
              <div class="segmented">
                <button :class="{ active: settings.state.editorPageLayout === 'left' }" @click="settings.state.editorPageLayout = 'left'">{{ t("settings.layoutLeft") }}</button>
                <button :class="{ active: settings.state.editorPageLayout === 'center' }" @click="settings.state.editorPageLayout = 'center'">{{ t("settings.layoutCenter") }}</button>
              </div>
            </div>
            <div v-if="settings.state.editorPageLayout === 'center'" class="form-row">
              <span class="row-label">{{ t("settings.centerMaxWidth") }}</span>
              <div class="inline-controls">
                <input type="number" v-model.number="settings.state.editorMaxWidth" step="20" min="560" max="1400" class="num-input" />
                <span class="unit">px</span>
              </div>
            </div>
            <div class="form-row"><span class="row-label">{{ t("settings.showLineNumbers") }}</span><label class="toggle-wrap"><input type="checkbox" v-model="settings.state.showLineNumbers" /><span class="toggle-track" /><span class="toggle-text">{{ settings.state.showLineNumbers ? t("common.on") : t("common.off") }}</span></label></div>
            <div class="form-row"><span class="row-label">{{ t("settings.showMinimap") }}</span><label class="toggle-wrap"><input type="checkbox" v-model="settings.state.showMinimap" /><span class="toggle-track" /><span class="toggle-text">{{ settings.state.showMinimap ? t("common.on") : t("common.off") }}</span></label></div>
            <div class="form-row"><span class="row-label">{{ t("settings.wordWrap") }}</span><label class="toggle-wrap"><input type="checkbox" v-model="settings.state.wordWrap" /><span class="toggle-track" /><span class="toggle-text">{{ settings.state.wordWrap ? t("common.on") : t("common.off") }}</span></label></div>
            <div class="form-row">
              <span class="row-label">{{ t("settings.linkInsertFormat") }}</span>
              <div class="segmented">
                <button :class="{ active: settings.state.linkInsertFormat === 'markdown' }" @click="settings.state.linkInsertFormat = 'markdown'">{{ t("settings.linkFormatMd") }}</button>
                <button :class="{ active: settings.state.linkInsertFormat === 'wikilink' }" @click="settings.state.linkInsertFormat = 'wikilink'">{{ t("settings.linkFormatWiki") }}</button>
              </div>
            </div>

            <h2 class="section-title" style="margin-top: 24px">{{ t("settings.autoSaveSection") }}</h2>
            <div class="form-row"><span class="row-label">{{ t("settings.autoSaveEnabled") }}</span><label class="toggle-wrap"><input type="checkbox" v-model="settings.state.autoSaveEnabled" /><span class="toggle-track" /><span class="toggle-text">{{ settings.state.autoSaveEnabled ? t("common.on") : t("common.off") }}</span></label></div>
            <div class="form-row">
              <span class="row-label">{{ t("settings.autoSaveDelay") }}</span>
              <div class="inline-controls"><input type="number" v-model.number="settings.state.autoSaveDelayMs" step="200" min="300" max="10000" class="num-input" /><span class="unit">{{ t("settings.msUnit") }}</span></div>
            </div>

            <h2 class="section-title" style="margin-top: 24px">{{ t("settings.historySection") }}</h2>
            <div class="form-row">
              <span class="row-label">{{ t("settings.historyEnabled") }}</span>
              <label class="toggle-wrap">
                <input type="checkbox" v-model="settings.state.historyEnabled" />
                <span class="toggle-track" />
                <span class="toggle-text">{{ settings.state.historyEnabled ? t("common.on") : t("common.off") }}</span>
              </label>
            </div>
            <div v-if="settings.state.historyEnabled" class="form-row">
              <span class="row-label">{{ t("settings.historyInterval") }}</span>
              <div class="inline-controls">
                <input type="number" v-model.number="settings.state.historyIntervalMinutes" step="1" min="1" max="60" class="num-input" />
                <span class="unit">{{ t("settings.historyIntervalUnit") }}</span>
              </div>
            </div>
            <div v-if="settings.state.historyEnabled" class="form-row">
              <span class="row-label">{{ t("settings.historyMaxSnapshots") }}</span>
              <div class="inline-controls">
                <input type="number" v-model.number="settings.state.historyMaxSnapshots" step="5" min="5" max="200" class="num-input" />
                <span class="unit">{{ t("settings.historyMaxUnit") }}</span>
              </div>
            </div>
            <div class="form-row">
              <span class="row-label">{{ t("settings.historyCache") }}</span>
              <div class="inline-controls">
                <span class="unit">{{ t("settings.historyCacheStat", { count: historyCacheStats.totalSnapshots, size: formatBytes(historyCacheStats.totalBytes) }) }}</span>
                <button class="mini-action-btn" @click="handleClearAllHistory">
                  <Trash2 :size="12" /> {{ t("settings.historyClearAll") }}
                </button>
                <span v-if="historyClearFeedback" class="yaml-ok-msg">{{ historyClearFeedback }}</span>
              </div>
            </div>
            <p class="setting-hint">
              {{ t("settings.historyStorageHint") }}
            </p>

            <h2 class="section-title" style="margin-top: 24px">{{ t("settings.imagesSection") }}</h2>
            <div class="form-row">
              <span class="row-label">{{ t("settings.imageStrategy") }}</span>
              <select v-model="settings.state.imageSaveStrategy" class="pill-select">
                <option value="noteSubfolder">{{ t("settings.imgNoteSubfolder") }}</option>
                <option value="sameDir">{{ t("settings.imgSameDir") }}</option>
                <option value="workspaceSubfolder">{{ t("settings.imgWorkspaceSubfolder") }}</option>
              </select>
            </div>
            <div v-if="settings.state.imageSaveStrategy !== 'sameDir'" class="form-row">
              <span class="row-label">{{ t("settings.subfolderName") }}</span>
              <input v-model="settings.state.imageSubfolderName" class="pill-input" placeholder="images" />
            </div>

            <h2 class="section-title" style="margin-top: 24px">{{ t("settings.traySection") }}</h2>
            <div class="form-row">
              <span class="row-label auto-width">{{ t("settings.minToTray") }}</span>
              <label class="toggle-wrap">
                <input type="checkbox" v-model="settings.state.minimizeToTray" />
                <span class="toggle-track" />
                <span class="toggle-text">{{ settings.state.minimizeToTray ? t("common.on") : t("common.off") }}</span>
              </label>
            </div>
            <div class="form-row">
              <span class="row-label auto-width">{{ t("settings.closeToTray") }}</span>
              <label class="toggle-wrap">
                <input type="checkbox" v-model="settings.state.closeToTray" />
                <span class="toggle-track" />
                <span class="toggle-text">{{ settings.state.closeToTray ? t("common.on") : t("common.off") }}</span>
              </label>
            </div>
          </div>

          <!-- TAB 3: EDITABLE SHORTCUTS & MOUSE GESTURES -->
          <div v-else-if="activeTab === 'shortcuts'" class="settings-page">
            <div class="section-header-row">
              <h2 class="section-title no-border">{{ t("settings.gesturesSection") }}</h2>
              <div class="section-header-actions">
                <button class="mini-action-btn" @click="settings.addGesture()">
                  <Plus :size="13" /> {{ t("settings.addGesture") }}
                </button>
                <button class="mini-action-btn" @click="settings.resetAllGestures()">
                  <RotateCcw :size="12" /> {{ t("common.resetDefault") }}
                </button>
              </div>
            </div>

            <div class="form-row">
              <span class="row-label">{{ t("settings.enableGestures") }}</span>
              <label class="toggle-wrap">
                <input type="checkbox" v-model="settings.state.mouseGesturesEnabled" />
                <span class="toggle-track" />
                <span class="toggle-text">{{ settings.state.mouseGesturesEnabled ? t("common.on") : t("common.off") }}</span>
              </label>
            </div>

            <p class="setting-hint">
              {{ t("settings.gesturesHint") }}
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
                  :title="t('settings.gestureRecordTip')"
                >
                  <template v-if="recordingGestureIdx === idx">
                    {{ gestureDraftSeq ? formatGestureSequence(gestureDraftSeq) : t("settings.gestureRecording") }}
                  </template>
                  <template v-else>
                    {{ formatGestureSequence(g.sequence) || t("settings.gestureRecordIdle") }}
                  </template>
                </button>

                <input
                  :value="g.sequence"
                  @input="onGestureSeqInput(idx, $event)"
                  :placeholder="t('settings.gestureSeqPlaceholder')"
                  maxlength="4"
                  class="seq-input"
                  :title="t('settings.gestureSeqTip')"
                />

                <select
                  :value="g.action"
                  @change="onGestureActionChange(idx, $event)"
                  class="gesture-action-select"
                >
                  <option v-for="opt in GESTURE_ACTION_OPTIONS" :key="opt.value" :value="opt.value">
                    {{ getGestureActionLabel(opt.value) }}
                  </option>
                </select>

                <button class="row-icon-btn danger" @click="settings.removeGesture(idx)" :title="t('settings.deleteGestureTip')">
                  <Trash2 :size="14" />
                </button>
              </div>
            </div>

            <div class="section-header-row">
              <h2 class="section-title no-border">{{ t("settings.shortcutsSection") }}</h2>
              <div class="section-header-actions">
                <button class="mini-action-btn" @click="settings.resetAllShortcuts()">
                  <RotateCcw :size="12" /> {{ t("common.resetDefault") }}
                </button>
              </div>
            </div>

            <p class="setting-hint">
              {{ t("settings.shortcutsHintPrefix") }} <kbd>Esc</kbd> {{ t("settings.shortcutsHintMid") }} <kbd>Backspace</kbd> {{ t("settings.shortcutsHintSuffix") }}
            </p>

            <div class="shortcut-list">
              <div v-for="s in effectiveShortcuts" :key="s.id" class="shortcut-row">
                <span class="shortcut-label">{{ getShortcutLabel(s.id) }}</span>
                <div class="shortcut-controls">
                  <button
                    class="kbd-edit-btn"
                    :class="{ recording: recordingShortcutId === s.id, unbound: !s.combo }"
                    @click="startRecordingShortcut(s.id)"
                    :title="t('settings.shortcutClickTip')"
                  >
                    {{ recordingShortcutId === s.id ? t("settings.shortcutPressKey") : formatComboForPlatform(s.combo) }}
                  </button>
                  <button
                    v-if="isShortcutCustomized(s.id)"
                    class="row-icon-btn"
                    @click="settings.resetShortcut(s.id)"
                    :title="t('settings.shortcutResetTip', { combo: formatComboForPlatform(DEFAULT_SHORTCUTS.find((d) => d.id === s.id)?.combo ?? '') })"
                  >
                    <RotateCcw :size="13" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- TAB 4: TERMINAL SETTINGS -->
          <div v-else-if="activeTab === 'terminal'" class="settings-page">
            <h2 class="section-title">{{ t("settings.terminalSection") }}</h2>

            <div class="form-row">
              <span class="row-label">{{ t("settings.terminalType") }}</span>
              <select v-model="settings.state.terminalShell" class="pill-select">
                <option value="git-bash">{{ t("settings.termGitBash") }}</option>
                <option value="powershell">PowerShell</option>
                <option value="cmd">{{ t("settings.termCmd") }}</option>
                <option value="zsh">{{ t("settings.termZsh") }}</option>
                <option value="custom">{{ t("settings.termCustom") }}</option>
              </select>
            </div>

            <div v-if="settings.state.terminalShell === 'custom'" class="form-row">
              <span class="row-label">{{ t("settings.termCustomPath") }}</span>
              <input
                v-model="settings.state.terminalCustomPath"
                placeholder="C:\Program Files\Git\bin\bash.exe"
                class="pill-input"
              />
            </div>

            <div v-if="detectedShells.length > 0" class="shell-detect-box">
              <div class="shell-detect-title">{{ t("settings.termDetectedTitle") }}</div>
              <div v-for="sh in detectedShells" :key="sh.id" class="shell-detect-row">
                <span class="sd-name">{{ sh.label }}</span>
                <span class="sd-status" :class="{ ok: sh.available }">
                  {{ sh.available ? sh.path || t("common.available") : t("common.notDetected") }}
                </span>
              </div>
            </div>

            <h2 class="section-title" style="margin-top: 24px">{{ t("settings.termAppearanceSection") }}</h2>

            <div class="form-row">
              <span class="row-label">{{ t("settings.termFont") }}</span>
              <input
                v-model="settings.state.terminalFont"
                placeholder="Cascadia Mono, Consolas, JetBrains Mono, monospace"
                class="pill-input"
              />
            </div>

            <div class="form-row">
              <span class="row-label">{{ t("settings.termSizeLineHeight") }}</span>
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
                <span class="unit">{{ t("settings.lineHeightUnit") }}</span>
              </div>
            </div>

            <div class="form-row">
              <span class="row-label">{{ t("settings.termCursorStyle") }}</span>
              <div class="segmented">
                <button
                  :class="{ active: settings.state.terminalCursorStyle === 'bar' }"
                  @click="settings.state.terminalCursorStyle = 'bar'"
                >
                  {{ t("settings.cursorBar") }}
                </button>
                <button
                  :class="{ active: settings.state.terminalCursorStyle === 'block' }"
                  @click="settings.state.terminalCursorStyle = 'block'"
                >
                  {{ t("settings.cursorBlock") }}
                </button>
                <button
                  :class="{ active: settings.state.terminalCursorStyle === 'underline' }"
                  @click="settings.state.terminalCursorStyle = 'underline'"
                >
                  {{ t("settings.cursorUnderline") }}
                </button>
              </div>
            </div>

            <p class="setting-hint">
              {{ t("settings.termHint") }}
            </p>
          </div>

          <!-- TAB 5: ABOUT & AUTO UPDATE -->
          <div v-else class="settings-page">
            <h2 class="section-title">{{ t("settings.aboutSection") }}</h2>

            <div class="about-hero">
              <img src="/logo.svg" alt="Folia Logo" class="about-logo" />
              <div class="about-meta">
                <div class="about-title-row">
                  <span class="about-name">{{ t("app.windowTitle") }}</span>
                  <span class="version-badge">v{{ APP_VERSION }}</span>
                </div>
                <p class="about-desc">
                  {{ t("app.aboutDesc") }}
                </p>
              </div>
            </div>

            <div class="about-info-list">
              <div class="about-info-row">
                <span class="about-key">{{ t("settings.author") }}</span>
                <span class="about-val">
                  {{ APP_AUTHOR }} (
                  <button class="link-btn" @click="openExternal(APP_AUTHOR_URL)">
                    mianao.info <ExternalLink :size="12" />
                  </button>
                  )
                </span>
              </div>
              <div class="about-info-row">
                <span class="about-key">{{ t("settings.currentVersion") }}</span>
                <span class="about-val mono">v{{ APP_VERSION }}</span>
              </div>
              <div class="about-info-row">
                <span class="about-key">{{ t("settings.license") }}</span>
                <span class="about-val">{{ APP_LICENSE }}</span>
              </div>
              <div class="about-info-row">
                <span class="about-key">{{ t("settings.repo") }}</span>
                <button class="link-btn" @click="openExternal(GITHUB_REPO_URL)">
                  github.com/harry10086/Folia <ExternalLink :size="12" />
                </button>
              </div>
            </div>

            <h2 class="section-title" style="margin-top: 26px">{{ t("settings.updateSection") }}</h2>

            <div class="form-row">
              <span class="row-label">{{ t("settings.autoCheckUpdates") }}</span>
              <label class="toggle-wrap">
                <input type="checkbox" v-model="settings.state.autoCheckUpdates" />
                <span class="toggle-track" />
                <span class="toggle-text">{{ settings.state.autoCheckUpdates ? t("common.on") : t("common.off") }}</span>
              </label>
            </div>

            <div class="update-actions-row">
              <button
                class="update-check-btn"
                :disabled="checkingUpdate"
                @click="handleCheckUpdate"
              >
                <RefreshCw :size="14" :class="{ spin: checkingUpdate }" />
                <span>{{ checkingUpdate ? t("settings.checkingUpdate") : t("settings.checkUpdateBtn") }}</span>
              </button>
            </div>

            <div v-if="updateResult" class="update-result-card" :class="updateResult.status">
              <template v-if="updateResult.status === 'update-available'">
                <div class="ur-head">
                  <Download :size="16" />
                  <strong>{{ t("settings.newVersionFound", { version: updateResult.latestVersion ?? "" }) }}</strong>
                </div>
                <p v-if="updateResult.notes" class="ur-notes">{{ updateResult.notes.slice(0, 320) }}</p>
                <div class="ur-actions">
                  <button class="update-download-btn" @click="openExternal(updateResult.releaseUrl)">
                    <ExternalLink :size="13" /> {{ t("settings.goDownloadUpdate") }}
                  </button>
                </div>
              </template>

              <template v-else-if="updateResult.status === 'up-to-date'">
                <div class="ur-head">
                  <CheckCircle2 :size="16" />
                  <span>{{ t("settings.upToDate", { current: updateResult.currentVersion, latest: updateResult.latestVersion ?? "" }) }}</span>
                </div>
                <div class="ur-actions">
                  <button class="mini-action-btn" @click="openExternal(updateResult.releaseUrl)">
                    <ExternalLink :size="12" /> {{ t("settings.viewReleasePage") }}
                  </button>
                </div>
              </template>

              <template v-else-if="updateResult.status === 'no-release'">
                <div class="ur-head">
                  <CheckCircle2 :size="16" />
                  <span>{{ t("settings.noReleaseYet", { current: updateResult.currentVersion }) }}</span>
                </div>
                <div class="ur-actions">
                  <button class="mini-action-btn" @click="openExternal(updateResult.releaseUrl)">
                    <ExternalLink :size="12" /> {{ t("settings.viewRepoReleases") }}
                  </button>
                </div>
              </template>

              <template v-else>
                <div class="ur-head">
                  <AlertCircle :size="16" />
                  <span>{{ t("settings.checkUpdateFailed", { msg: updateResult.errorMessage ?? "" }) }}</span>
                </div>
                <div class="ur-actions">
                  <button class="mini-action-btn" @click="openExternal(updateResult.releaseUrl)">
                    <ExternalLink :size="12" /> {{ t("settings.openReleasesManually") }}
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
.setting-hint { margin: 0 0 12px; font-size: 12px; line-height: 1.55; color: var(--text-muted); }
.setting-hint strong { color: var(--text-secondary); font-weight: 600; }
.form-row { display: flex; align-items: center; gap: 16px; margin-bottom: 14px; }
.row-label { width: 150px; flex-shrink: 0; font-size: 13px; color: var(--text-secondary); }
.row-label.auto-width { width: auto; min-width: 248px; white-space: nowrap; }
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
