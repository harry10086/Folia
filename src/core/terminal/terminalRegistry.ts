import { ref, type Ref } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ipc, isTauriRuntime, parseIpcError } from "@/core/ipc/client";
import { t } from "@/core/i18n";
import type { AppSettings } from "@/stores/settings";
import type { UnlistenFn } from "@tauri-apps/api/event";

export interface LiveTerminalInstance {
  tabId: string;
  cwd: string;
  containerEl: HTMLDivElement;
  term: Terminal;
  fitAddon: FitAddon;
  sessionId: string | null;
  activeShell: Ref<AppSettings["terminalShell"]>;
  shellLabel: Ref<string>;
  statusText: Ref<string>;
  exited: Ref<boolean>;
  unlistenData: UnlistenFn | null;
  unlistenExit: UnlistenFn | null;
  started: boolean;
  disposed: boolean;
}

const registry = new Map<string, LiveTerminalInstance>();

export function buildXtermTheme() {
  const styles = getComputedStyle(document.documentElement);
  const isDark = document.documentElement.dataset.themeMode === "dark";
  const bg = styles.getPropertyValue("--bg-surface").trim() || (isDark ? "#1e1f26" : "#ffffff");
  const fg = styles.getPropertyValue("--text-primary").trim() || (isDark ? "#e2e8f0" : "#1e293b");
  const accent = styles.getPropertyValue("--accent").trim() || "#2563eb";
  const muted = styles.getPropertyValue("--text-muted").trim() || "#64748b";

  return {
    background: bg,
    foreground: fg,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: isDark ? "rgba(124, 143, 248, 0.32)" : "rgba(37, 99, 235, 0.22)",
    black: isDark ? "#1e293b" : "#334155",
    red: isDark ? "#f87171" : "#dc2626",
    green: isDark ? "#4ade80" : "#15803d",
    yellow: isDark ? "#facc15" : "#b45309",
    blue: isDark ? "#60a5fa" : "#2563eb",
    magenta: isDark ? "#c084fc" : "#7c3aed",
    cyan: isDark ? "#22d3ee" : "#0e7490",
    white: isDark ? "#e2e8f0" : "#475569",
    brightBlack: muted,
    brightRed: isDark ? "#fca5a5" : "#ef4444",
    brightGreen: isDark ? "#86efac" : "#16a34a",
    brightYellow: isDark ? "#fde047" : "#ca8a04",
    brightBlue: isDark ? "#93c5fd" : "#3b82f6",
    brightMagenta: isDark ? "#d8b4fe" : "#9333ea",
    brightCyan: isDark ? "#67e8f9" : "#0891b2",
    brightWhite: isDark ? "#f8fafc" : "#0f172a",
  };
}

export function getOrCreateTerminalInstance(
  tabId: string,
  cwd: string,
  settingsState: AppSettings
): LiveTerminalInstance {
  const existing = registry.get(tabId);
  if (existing && !existing.disposed) {
    return existing;
  }

  const containerEl = document.createElement("div");
  containerEl.style.width = "100%";
  containerEl.style.height = "100%";

  const term = new Terminal({
    cursorBlink: true,
    allowProposedApi: false,
    scrollback: 3000,
    fontFamily:
      settingsState.terminalFont.trim() || "Cascadia Mono, Consolas, JetBrains Mono, monospace",
    fontSize: Math.max(10, Math.min(26, settingsState.terminalFontSize || 13)),
    lineHeight: Math.max(1.0, Math.min(2.0, settingsState.terminalLineHeight || 1.35)),
    cursorStyle: settingsState.terminalCursorStyle || "bar",
    theme: buildXtermTheme(),
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);

  const inst: LiveTerminalInstance = {
    tabId,
    cwd,
    containerEl,
    term,
    fitAddon,
    sessionId: null,
    activeShell: ref(settingsState.terminalShell),
    shellLabel: ref(t("terminal.label")),
    statusText: ref(t("terminal.starting")),
    exited: ref(false),
    unlistenData: null,
    unlistenExit: null,
    started: false,
    disposed: false,
  };

  // Ctrl+Shift+C copy & Ctrl+Shift+V paste convenience
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type === "keydown" && (ev.ctrlKey || ev.metaKey) && ev.shiftKey) {
      if (ev.key.toLowerCase() === "c" && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        return false;
      }
      if (ev.key.toLowerCase() === "v") {
        void navigator.clipboard
          .readText()
          .then((txt) => {
            if (txt && inst.sessionId) void ipc.terminalWrite(inst.sessionId, txt);
          })
          .catch(() => {});
        return false;
      }
    }
    return true;
  });

  term.onData((data) => {
    if (inst.sessionId && isTauriRuntime()) {
      void ipc.terminalWrite(inst.sessionId, data);
    }
  });

  registry.set(tabId, inst);
  return inst;
}

export async function killInstanceSession(inst: LiveTerminalInstance) {
  const prev = inst.sessionId;
  inst.sessionId = null;
  if (prev && isTauriRuntime()) {
    await ipc.terminalKill(prev).catch(() => {});
  }
}

export async function startInstanceSession(
  inst: LiveTerminalInstance,
  customPath: string | null,
  onReadyFit?: () => void
) {
  await killInstanceSession(inst);
  if (inst.disposed) return;

  inst.exited.value = false;
  inst.statusText.value = t("terminal.startingShort");

  if (!isTauriRuntime()) {
    inst.shellLabel.value = t("terminal.previewMode");
    inst.statusText.value = t("terminal.desktopOnly");
    inst.term.writeln("\x1b[33m当前为浏览器预览模式，请在 Tauri 桌面端使用内嵌命令终端。\x1b[0m");
    return;
  }

  try {
    const cols = inst.term.cols || 80;
    const rows = inst.term.rows || 24;
    const res = await ipc.terminalSpawn({
      cwd: inst.cwd,
      shellType: inst.activeShell.value,
      customPath: customPath || null,
      cols,
      rows,
    });
    if (inst.disposed) {
      await ipc.terminalKill(res.id).catch(() => {});
      return;
    }
    inst.sessionId = res.id;
    inst.shellLabel.value = res.shellLabel;
    inst.statusText.value = res.shellLabel;
    onReadyFit?.();
    inst.term.focus();
  } catch (err) {
    const msg = parseIpcError(err).message;
    inst.statusText.value = t("terminal.startFailed");
    inst.exited.value = true;
    inst.term.writeln(`\r\n\x1b[31m终端启动失败: ${msg}\x1b[0m\r\n`);
  }
}

export function destroyTerminalInstance(tabId: string) {
  const inst = registry.get(tabId);
  if (!inst) return;
  registry.delete(tabId);
  inst.disposed = true;
  inst.unlistenData?.();
  inst.unlistenExit?.();
  inst.unlistenData = null;
  inst.unlistenExit = null;
  void killInstanceSession(inst);
  try {
    inst.term.dispose();
  } catch {
    // ignore
  }
  inst.containerEl.remove();
}

export function destroyAllTerminalInstances() {
  for (const id of Array.from(registry.keys())) {
    destroyTerminalInstance(id);
  }
}
