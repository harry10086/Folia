import { findThemeById, type ThemePalette } from "./themes";
import { isMacPlatform, isWindowsPlatform } from "@/core/ipc/client";

export interface CustomThemeColors {
  bgBase?: string;
  bgSurface?: string;
  bgSidebar?: string;
  textPrimary?: string;
  accent?: string;
  heading?: string;
  bold?: string;
  code?: string;
  link?: string;
}

export const CUSTOM_COLOR_FIELDS: Array<{
  key: keyof CustomThemeColors;
  label: string;
}> = [
  { key: "bgBase", label: "窗口背景" },
  { key: "bgSurface", label: "编辑区背景" },
  { key: "bgSidebar", label: "侧边栏背景" },
  { key: "textPrimary", label: "正文文字" },
  { key: "accent", label: "主题强调色" },
  { key: "heading", label: "标题颜色" },
  { key: "bold", label: "加粗颜色" },
  { key: "code", label: "行内代码" },
  { key: "link", label: "链接颜色" },
];

export interface ThemeSettings {
  appearance: "auto" | "light" | "dark";
  lightThemeId: string;
  darkThemeId: string;
  renderColorMode: "colorful" | "monochrome";
  borderRadius: "none" | "half" | "full";
  darkSidebarAlways: boolean;
  customColors: CustomThemeColors;
  customThemes: ThemePalette[];
  uiFont: string;
  editorFont: string;
  editorFontSize: number;
  editorLineHeight: number;
  uiScale: number;
  editorMaxWidth: number;
}

export function getPlatformFallbackUiFont(): string {
  if (isMacPlatform()) {
    return `-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", sans-serif`;
  }
  if (isWindowsPlatform()) {
    return `"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif`;
  }
  return `"Inter", "Noto Sans CJK SC", "WenQuanYi Micro Hei", sans-serif`;
}

export function getPlatformFallbackEditorFont(): string {
  if (isMacPlatform()) {
    return `"SF Mono", "PingFang SC", "JetBrains Mono", Menlo, monospace`;
  }
  if (isWindowsPlatform()) {
    return `"Cascadia Mono", "Consolas", "Microsoft YaHei UI", monospace`;
  }
  return `"JetBrains Mono", "Noto Sans Mono CJK SC", "Fira Code", monospace`;
}

export function resolveActiveTheme(settings: ThemeSettings): ThemePalette {
  let effectiveMode: "light" | "dark" = "light";
  if (settings.appearance === "dark") {
    effectiveMode = "dark";
  } else if (settings.appearance === "auto") {
    effectiveMode = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  const id = effectiveMode === "dark" ? settings.darkThemeId : settings.lightThemeId;
  const customMatch = (settings.customThemes ?? []).find((t) => t.id === id);
  if (customMatch) return customMatch;
  return findThemeById(id, effectiveMode);
}

export function resolveEffectiveTheme(settings: ThemeSettings): ThemePalette {
  const base = resolveActiveTheme(settings);
  const c = settings.customColors ?? {};
  const merged: ThemePalette = {
    ...base,
    bgBase: c.bgBase || base.bgBase,
    bgSurface: c.bgSurface || base.bgSurface,
    bgSidebar: c.bgSidebar || base.bgSidebar,
    textPrimary: c.textPrimary || base.textPrimary,
    accent: c.accent || base.accent,
    heading: c.heading || base.heading,
    bold: c.bold || base.bold,
    code: c.code || base.code,
    link: c.link || base.link,
  };
  if (c.accent) {
    merged.accentSoft = `color-mix(in srgb, ${c.accent} 16%, transparent)`;
  }
  return merged;
}

export function applyThemeToDocument(settings: ThemeSettings): ThemePalette {
  const theme = resolveEffectiveTheme(settings);
  const root = document.documentElement;

  root.dataset.themeMode = theme.mode;
  root.dataset.darkSidebar = settings.darkSidebarAlways ? "true" : "false";
  root.dataset.colorMode = settings.renderColorMode;

  const set = (k: string, v: string) => root.style.setProperty(k, v);

  set("--bg-base", theme.bgBase);
  set("--bg-surface", theme.bgSurface);
  set("--bg-elevated", theme.bgElevated);
  set("--bg-hover", theme.bgHover);
  set("--bg-active", theme.bgActive);
  set("--border-color", theme.border);
  set("--text-primary", theme.textPrimary);
  set("--text-secondary", theme.textSecondary);
  set("--text-muted", theme.textMuted);
  set("--accent", theme.accent);
  set("--accent-soft", theme.accentSoft);
  set("--danger", theme.danger);
  set("--mark-bg", theme.markBg);

  if (settings.darkSidebarAlways && theme.mode === "light") {
    set("--bg-sidebar", "#191c24");
    set("--sidebar-text", "#e2e8f0");
    set("--sidebar-text-muted", "#8b98b0");
    set("--sidebar-hover", "#242936");
    set("--sidebar-active", "#2e3648");
    set("--sidebar-border", "#262c3a");
  } else {
    set("--bg-sidebar", theme.bgSidebar);
    set("--sidebar-text", theme.textPrimary);
    set("--sidebar-text-muted", theme.textMuted);
    set("--sidebar-hover", theme.bgHover);
    set("--sidebar-active", theme.bgActive);
    set("--sidebar-border", theme.border);
  }

  if (settings.renderColorMode === "monochrome") {
    set("--md-heading", theme.textPrimary);
    set("--md-bold", theme.textPrimary);
    set("--md-code", theme.textPrimary);
    set("--md-code-bg", theme.bgHover);
    set("--md-link", theme.textSecondary);
    set("--md-quote-bar", theme.textMuted);
  } else {
    set("--md-heading", theme.heading);
    set("--md-bold", theme.bold);
    set("--md-code", theme.code);
    set("--md-code-bg", theme.codeBg);
    set("--md-link", theme.link);
    set("--md-quote-bar", theme.quoteBar);
  }

  const radiusMap = {
    none: { sm: "0px", md: "0px", lg: "0px", pill: "0px" },
    half: { sm: "4px", md: "6px", lg: "10px", pill: "8px" },
    full: { sm: "6px", md: "10px", lg: "14px", pill: "9999px" },
  }[settings.borderRadius];

  set("--radius-sm", radiusMap.sm);
  set("--radius-md", radiusMap.md);
  set("--radius-lg", radiusMap.lg);
  set("--radius-pill", radiusMap.pill);

  set("--shadow-sm", "none");
  set(
    "--shadow-md",
    theme.mode === "dark"
      ? "0 8px 26px rgba(0, 0, 0, 0.48)"
      : "0 6px 20px rgba(15, 23, 42, 0.12)"
  );

  const uiFontStack = settings.uiFont.trim()
    ? `"${settings.uiFont.trim()}", ${getPlatformFallbackUiFont()}`
    : getPlatformFallbackUiFont();
  const editorFontStack = settings.editorFont.trim()
    ? `"${settings.editorFont.trim()}", ${getPlatformFallbackEditorFont()}`
    : getPlatformFallbackEditorFont();

  set("--font-ui", uiFontStack);
  set("--font-editor", editorFontStack);
  set("--editor-font-size", `${settings.editorFontSize}px`);
  set("--editor-line-height", `${settings.editorLineHeight}`);
  set("--editor-max-width", settings.editorMaxWidth > 0 ? `${settings.editorMaxWidth}px` : "100%");
  set("--ui-scale", `${settings.uiScale}`);
  root.style.fontSize = `${Math.round(14 * settings.uiScale)}px`;

  return theme;
}
