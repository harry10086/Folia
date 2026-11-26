import { acceptHMRUpdate, defineStore } from "pinia";
import { reactive, watch } from "vue";
import {
  applyThemeToDocument,
  type CustomThemeColors,
  type ThemeSettings,
} from "@/core/theme/applyTheme";
import type { ThemePalette } from "@/core/theme/themes";
import { ipc, isTauriRuntime } from "@/core/ipc/client";
import { DEFAULT_GESTURES, type GestureActionId, type GestureDefinition } from "@/core/gestures/mouseGestures";

export interface AppSettings extends ThemeSettings {
  defaultEditMode: "live" | "source";
  showLineNumbers: boolean;
  showOutline: boolean;
  showMinimap: boolean;
  showAttachmentsBar: boolean;
  wordWrap: boolean;
  autoSaveEnabled: boolean;
  autoSaveDelayMs: number;
  imageSaveStrategy: "noteSubfolder" | "sameDir" | "workspaceSubfolder";
  imageSubfolderName: string;
  linkInsertFormat: "markdown" | "wikilink";
  mouseGesturesEnabled: boolean;
  customShortcuts: Record<string, string>;
  customGestures: GestureDefinition[];
  showHiddenFiles: boolean;
  sidebarAutoHide: boolean;
  sidebarWidth: number;
  outlineWidth: number;
  autoCheckUpdates: boolean;
  terminalShell: "git-bash" | "powershell" | "cmd" | "zsh" | "custom";
  terminalCustomPath: string;
  terminalFont: string;
  terminalFontSize: number;
  terminalLineHeight: number;
  terminalCursorStyle: "bar" | "block" | "underline";
}

function cloneDefaultGestures(): GestureDefinition[] {
  return DEFAULT_GESTURES.map((g) => ({ ...g }));
}

export const DEFAULT_SETTINGS: AppSettings = {
  appearance: "light",
  lightThemeId: "studio-daylight",
  darkThemeId: "obsidian-night",
  renderColorMode: "colorful",
  borderRadius: "full",
  darkSidebarAlways: false,
  customColors: {},
  customThemes: [],
  uiFont: "",
  editorFont: "Consolas",
  editorFontSize: 15,
  editorLineHeight: 1.75,
  uiScale: 1.0,
  editorMaxWidth: 880,
  defaultEditMode: "live",
  showLineNumbers: true,
  showOutline: true,
  showMinimap: true,
  showAttachmentsBar: false,
  wordWrap: true,
  autoSaveEnabled: true,
  autoSaveDelayMs: 1500,
  imageSaveStrategy: "noteSubfolder",
  imageSubfolderName: "images",
  linkInsertFormat: "markdown",
  mouseGesturesEnabled: true,
  customShortcuts: {},
  customGestures: cloneDefaultGestures(),
  showHiddenFiles: false,
  sidebarAutoHide: false,
  sidebarWidth: 256,
  outlineWidth: 220,
  autoCheckUpdates: true,
  terminalShell: "git-bash",
  terminalCustomPath: "",
  terminalFont: "Cascadia Mono, Consolas, JetBrains Mono, monospace",
  terminalFontSize: 13,
  terminalLineHeight: 1.35,
  terminalCursorStyle: "bar",
};

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let externalSaveHook: (() => void) | null = null;

export function registerConfigPersistHook(fn: () => void) {
  externalSaveHook = fn;
}

export const useSettingsStore = defineStore("settings", () => {
  const state = reactive<AppSettings>({
    ...DEFAULT_SETTINGS,
    customColors: {},
    customThemes: [],
    customShortcuts: {},
    customGestures: cloneDefaultGestures(),
  });

  function applyTheme() {
    applyThemeToDocument(state);
  }

  function hydrate(partial: Partial<AppSettings> | undefined) {
    if (!partial) return;
    const sanitized = { ...(partial as Record<string, unknown>) };
    delete sanitized.elevationShadow;
    delete sanitized.minimalMode;

    Object.assign(state, {
      ...DEFAULT_SETTINGS,
      ...sanitized,
      customColors: { ...(partial.customColors ?? {}) },
      customThemes: Array.isArray(partial.customThemes)
        ? partial.customThemes.map((t) => ({ ...t, swatches: [...t.swatches] as ThemePalette["swatches"] }))
        : [],
      customShortcuts: { ...(partial.customShortcuts ?? {}) },
      customGestures:
        Array.isArray(partial.customGestures) && partial.customGestures.length > 0
          ? partial.customGestures.map((g) => ({
              sequence: String(g.sequence || "").toUpperCase(),
              action: g.action as GestureActionId,
            }))
          : cloneDefaultGestures(),
    });
    applyTheme();
  }

  function setCustomColor(key: keyof CustomThemeColors, value: string) {
    const next = { ...state.customColors };
    if (!value) {
      delete next[key];
    } else {
      next[key] = value;
    }
    state.customColors = next;
  }

  function resetCustomColors() {
    state.customColors = {};
  }

  function saveCustomTheme(theme: ThemePalette) {
    const clone: ThemePalette = {
      ...theme,
      swatches: [...theme.swatches] as ThemePalette["swatches"],
    };
    const idx = state.customThemes.findIndex((t) => t.id === clone.id);
    if (idx >= 0) {
      const next = [...state.customThemes];
      next[idx] = clone;
      state.customThemes = next;
    } else {
      state.customThemes = [...state.customThemes, clone];
    }

    // Bake into active selection and clear transient overrides
    state.customColors = {};
    if (clone.mode === "dark") {
      state.darkThemeId = clone.id;
      if (state.appearance === "light") state.appearance = "dark";
    } else {
      state.lightThemeId = clone.id;
      if (state.appearance === "dark") state.appearance = "light";
    }
    applyTheme();
  }

  function deleteCustomTheme(id: string) {
    state.customThemes = state.customThemes.filter((t) => t.id !== id);
    if (state.lightThemeId === id) state.lightThemeId = DEFAULT_SETTINGS.lightThemeId;
    if (state.darkThemeId === id) state.darkThemeId = DEFAULT_SETTINGS.darkThemeId;
    applyTheme();
  }

  function setShortcut(id: string, combo: string) {
    state.customShortcuts = { ...state.customShortcuts, [id]: combo };
  }

  function resetShortcut(id: string) {
    const next = { ...state.customShortcuts };
    delete next[id];
    state.customShortcuts = next;
  }

  function resetAllShortcuts() {
    state.customShortcuts = {};
  }

  function updateGesture(index: number, patch: Partial<GestureDefinition>) {
    if (index < 0 || index >= state.customGestures.length) return;
    const next = state.customGestures.map((g, i) =>
      i === index
        ? {
            sequence: (patch.sequence ?? g.sequence).toUpperCase().replace(/[^LRUD]/g, "").slice(0, 4),
            action: patch.action ?? g.action,
          }
        : g
    );
    state.customGestures = next;
  }

  function addGesture(sequence = "DL", action: GestureActionId = "toggleSidebar") {
    state.customGestures = [...state.customGestures, { sequence, action }];
  }

  function removeGesture(index: number) {
    state.customGestures = state.customGestures.filter((_, i) => i !== index);
  }

  function resetAllGestures() {
    state.customGestures = cloneDefaultGestures();
  }

  function resetToDefaults() {
    Object.assign(state, {
      ...DEFAULT_SETTINGS,
      customColors: {},
      customThemes: [],
      customShortcuts: {},
      customGestures: cloneDefaultGestures(),
    });
    applyTheme();
  }

  watch(
    () => ({
      ...state,
      customColors: { ...state.customColors },
      customThemes: state.customThemes.map((t) => ({ ...t })),
      customShortcuts: { ...state.customShortcuts },
      customGestures: state.customGestures.map((g) => ({ ...g })),
    }),
    () => {
      applyTheme();
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        if (externalSaveHook) {
          externalSaveHook();
        } else if (!isTauriRuntime()) {
          localStorage.setItem("folia_settings", JSON.stringify(state));
        }
      }, 350);
    },
    { deep: true }
  );

  if (typeof window !== "undefined" && window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (state.appearance === "auto") applyTheme();
    });
  }

  applyTheme();

  return {
    state,
    applyTheme,
    hydrate,
    setCustomColor,
    resetCustomColors,
    saveCustomTheme,
    deleteCustomTheme,
    setShortcut,
    resetShortcut,
    resetAllShortcuts,
    updateGesture,
    addGesture,
    removeGesture,
    resetAllGestures,
    resetToDefaults,
    ipc,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSettingsStore, import.meta.hot));
}
