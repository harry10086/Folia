import { isMacPlatform } from "@/core/ipc/client";
import { t, type MessageKey } from "@/core/i18n";

export interface ShortcutBinding {
  id: string;
  label: string;
  combo: string; // e.g. "Mod+S", "Mod+Shift+F"
}

export function getShortcutLabel(id: string): string {
  return t(`shortcuts.${id}` as MessageKey);
}

export const DEFAULT_SHORTCUTS: ShortcutBinding[] = [
  { id: "save", label: "保存当前文件", combo: "Mod+S" },
  { id: "newNote", label: "新建笔记", combo: "Mod+N" },
  { id: "closeTab", label: "关闭当前标签页", combo: "Mod+W" },
  { id: "quickOpen", label: "快速打开文件", combo: "Mod+P" },
  { id: "globalSearch", label: "聚焦文件过滤 / 全库搜索", combo: "Mod+Shift+F" },
  { id: "toggleMode", label: "切换源码 / 实时预览", combo: "Mod+Shift+L" },
  { id: "toggleSidebar", label: "显示 / 隐藏左侧文件栏", combo: "Mod+Shift+B" },
  { id: "toggleOutline", label: "显示 / 隐藏目录大纲", combo: "Mod+Shift+O" },
  { id: "toggleMinimap", label: "显示 / 隐藏右侧缩略图", combo: "Mod+Shift+M" },
  { id: "toggleAttachments", label: "显示 / 隐藏底部附件栏", combo: "Mod+Shift+A" },
  { id: "splitRight", label: "左右分屏", combo: "Mod+\\" },
  { id: "splitDown", label: "上下分屏", combo: "Mod+Shift+\\" },
  { id: "openSettings", label: "打开设置", combo: "Mod+," },
  { id: "exportHtml", label: "导出为 HTML", combo: "Mod+Shift+E" },
  { id: "exportPdf", label: "打印 / 导出为 PDF", combo: "Mod+Shift+P" },
];

export function getEffectiveShortcuts(customMap?: Record<string, string>): ShortcutBinding[] {
  if (!customMap) return DEFAULT_SHORTCUTS;
  return DEFAULT_SHORTCUTS.map((item) => ({
    ...item,
    combo: customMap[item.id] ?? item.combo,
  }));
}

export function formatComboForPlatform(combo: string): string {
  if (!combo) return t("settings.shortcutUnbound");
  const mac = isMacPlatform();
  return combo
    .replace(/Mod/g, mac ? "⌘" : "Ctrl")
    .replace(/Shift/g, mac ? "⇧" : "Shift")
    .replace(/Alt/g, mac ? "⌥" : "Alt");
}

/**
 * Convert a KeyboardEvent into a normalized cross-platform combo string (e.g. "Mod+Shift+K").
 * Returns null if only modifier keys were pressed.
 */
export function eventToCombo(e: KeyboardEvent): string | null {
  const key = e.key;
  if (["Control", "Meta", "Shift", "Alt", "OS", "Dead", "Process"].includes(key)) {
    return null;
  }

  const mac = isMacPlatform();
  const hasMod = mac ? e.metaKey : e.ctrlKey;
  const parts: string[] = [];
  if (hasMod) parts.push("Mod");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");

  let normalizedKey = key;
  if (key === " ") normalizedKey = "Space";
  else if (key.length === 1) normalizedKey = key.toUpperCase();
  else if (key === "|") normalizedKey = "\\";
  else if (key === "<") normalizedKey = ",";

  parts.push(normalizedKey);
  return parts.join("+");
}

export function matchesCombo(e: KeyboardEvent, combo: string): boolean {
  if (!combo || !combo.trim()) return false;
  const parts = combo.split("+").map((p) => p.trim().toLowerCase());
  const mac = isMacPlatform();
  const needMod = parts.includes("mod");
  const needShift = parts.includes("shift");
  const needAlt = parts.includes("alt");
  const mainKey = parts.find((p) => !["mod", "shift", "alt", "ctrl", "meta"].includes(p));
  if (!mainKey) return false;

  const hasMod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (needMod !== hasMod) return false;
  if (needShift !== e.shiftKey) return false;
  if (needAlt !== e.altKey) return false;

  const pressed = e.key.toLowerCase();
  if (mainKey === "space" && pressed === " ") return true;
  if (mainKey === "\\" && (pressed === "\\" || pressed === "|")) return true;
  if (mainKey === "," && (pressed === "," || pressed === "<")) return true;
  return pressed === mainKey;
}
