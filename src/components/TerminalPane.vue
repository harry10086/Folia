<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { RotateCcw, Trash2, Terminal as TerminalIcon } from "lucide-vue-next";
import { ipc, isTauriRuntime, parseIpcError } from "@/core/ipc/client";
import { useSettingsStore } from "@/stores/settings";
import type { UnlistenFn } from "@tauri-apps/api/event";

const props = defineProps<{
  cwd: string;
  workspaceName: string;
}>();

const settings = useSettingsStore();

const hostRef = ref<HTMLDivElement | null>(null);
const activeShell = ref(settings.state.terminalShell);
const shellLabel = ref("终端");
const statusText = ref("正在启动终端...");
const exited = ref(false);

let term: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let sessionId: string | null = null;
let unlistenData: UnlistenFn | null = null;
let unlistenExit: UnlistenFn | null = null;
let resizeObserver: ResizeObserver | null = null;
let fitTimer: ReturnType<typeof setTimeout> | null = null;

function buildXtermTheme() {
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

function applyTerminalOptions() {
  if (!term) return;
  term.options.fontFamily =
    settings.state.terminalFont.trim() || "Cascadia Mono, Consolas, JetBrains Mono, monospace";
  term.options.fontSize = Math.max(10, Math.min(26, settings.state.terminalFontSize || 13));
  term.options.lineHeight = Math.max(1.0, Math.min(2.0, settings.state.terminalLineHeight || 1.35));
  term.options.cursorStyle = settings.state.terminalCursorStyle || "bar";
  term.options.theme = buildXtermTheme();
  scheduleFit();
}

function scheduleFit() {
  if (fitTimer) clearTimeout(fitTimer);
  fitTimer = setTimeout(() => {
    if (!fitAddon || !term || !hostRef.value) return;
    if (hostRef.value.clientWidth < 40 || hostRef.value.clientHeight < 40) return;
    try {
      fitAddon.fit();
      if (sessionId && isTauriRuntime()) {
        void ipc.terminalResize(sessionId, term.cols, term.rows);
      }
    } catch {
      // ignore transient zero-size layout
    }
  }, 45);
}

async function killCurrentSession() {
  const prev = sessionId;
  sessionId = null;
  if (prev && isTauriRuntime()) {
    await ipc.terminalKill(prev).catch(() => {});
  }
}

async function startSession() {
  await killCurrentSession();
  exited.value = false;
  statusText.value = "正在启动...";

  if (!isTauriRuntime()) {
    shellLabel.value = "预览模式";
    statusText.value = "仅在桌面端运行";
    term?.writeln("\x1b[33m当前为浏览器预览模式，请在 Tauri 桌面端使用内嵌命令终端。\x1b[0m");
    return;
  }

  try {
    const cols = term?.cols || 80;
    const rows = term?.rows || 24;
    const res = await ipc.terminalSpawn({
      cwd: props.cwd,
      shellType: activeShell.value,
      customPath: settings.state.terminalCustomPath || null,
      cols,
      rows,
    });
    sessionId = res.id;
    shellLabel.value = res.shellLabel;
    statusText.value = res.shellLabel;
    scheduleFit();
    term?.focus();
  } catch (err) {
    const msg = parseIpcError(err).message;
    statusText.value = "启动失败";
    exited.value = true;
    term?.writeln(`\r\n\x1b[31m终端启动失败: ${msg}\x1b[0m\r\n`);
  }
}

async function restartTerminal() {
  term?.clear();
  await startSession();
}

function clearTerminal() {
  term?.clear();
  term?.focus();
}

function handleShellChange() {
  void restartTerminal();
}

onMounted(async () => {
  if (!hostRef.value) return;

  term = new Terminal({
    cursorBlink: true,
    allowProposedApi: false,
    scrollback: 3000,
    fontFamily:
      settings.state.terminalFont.trim() || "Cascadia Mono, Consolas, JetBrains Mono, monospace",
    fontSize: Math.max(10, Math.min(26, settings.state.terminalFontSize || 13)),
    lineHeight: Math.max(1.0, Math.min(2.0, settings.state.terminalLineHeight || 1.35)),
    cursorStyle: settings.state.terminalCursorStyle || "bar",
    theme: buildXtermTheme(),
  });

  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(hostRef.value);

  // Ctrl+Shift+C copy & Ctrl+Shift+V paste convenience
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type === "keydown" && (ev.ctrlKey || ev.metaKey) && ev.shiftKey) {
      if (ev.key.toLowerCase() === "c" && term?.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        return false;
      }
      if (ev.key.toLowerCase() === "v") {
        void navigator.clipboard.readText().then((txt) => {
          if (txt && sessionId) void ipc.terminalWrite(sessionId, txt);
        }).catch(() => {});
        return false;
      }
    }
    return true;
  });

  term.onData((data) => {
    if (sessionId && isTauriRuntime()) {
      void ipc.terminalWrite(sessionId, data);
    }
  });

  if (isTauriRuntime()) {
    unlistenData = await ipc.onTerminalData((ev) => {
      if (ev.id === sessionId) {
        term?.write(ev.data);
      }
    });
    unlistenExit = await ipc.onTerminalExit((ev) => {
      if (ev.id === sessionId) {
        sessionId = null;
        exited.value = true;
        statusText.value = "进程已退出";
        term?.writeln("\r\n\x1b[90m[终端进程已结束，点击右上角重启按钮可重新打开]\x1b[0m");
      }
    });
  }

  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => scheduleFit());
    resizeObserver.observe(hostRef.value);
  }

  try {
    fitAddon.fit();
  } catch {
    // ignore
  }
  await startSession();
});

watch(
  () => [
    settings.state.terminalFont,
    settings.state.terminalFontSize,
    settings.state.terminalLineHeight,
    settings.state.terminalCursorStyle,
    settings.state.appearance,
    settings.state.lightThemeId,
    settings.state.darkThemeId,
    settings.state.customColors,
    settings.state.customThemes,
  ],
  () => applyTerminalOptions(),
  { deep: true }
);

onBeforeUnmount(() => {
  if (fitTimer) clearTimeout(fitTimer);
  resizeObserver?.disconnect();
  unlistenData?.();
  unlistenExit?.();
  void killCurrentSession();
  term?.dispose();
  term = null;
  fitAddon = null;
});
</script>

<template>
  <div class="terminal-pane">
    <div class="terminal-toolbar">
      <div class="term-left">
        <TerminalIcon :size="14" class="term-ico" />
        <select
          v-model="activeShell"
          class="shell-select"
          @change="handleShellChange"
          data-tip="切换当前终端类型并重启"
        >
          <option value="git-bash">Git Bash</option>
          <option value="powershell">PowerShell</option>
          <option value="cmd">命令提示符 (CMD)</option>
          <option value="zsh">Zsh / Bash</option>
          <option value="custom">自定义终端</option>
        </select>
        <span class="term-cwd" :title="cwd">{{ cwd }}</span>
      </div>
      <div class="term-right">
        <span class="term-status" :class="{ exited }">{{ statusText }}</span>
        <button class="term-btn" @click="clearTerminal" data-tip="清空屏幕">
          <Trash2 :size="13" />
        </button>
        <button class="term-btn" @click="restartTerminal" data-tip="重启终端">
          <RotateCcw :size="13" />
        </button>
      </div>
    </div>

    <div ref="hostRef" class="terminal-host" @click="term?.focus()" />
  </div>
</template>

<style scoped>
.terminal-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--bg-surface);
  overflow: hidden;
}
.terminal-toolbar {
  height: 32px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 10px;
  background: var(--bg-base);
  border-bottom: 1px solid var(--border-color);
  font-size: 12px;
  user-select: none;
}
.term-left,
.term-right {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.term-left {
  flex: 1;
}
.term-ico {
  color: var(--accent);
  flex-shrink: 0;
}
.shell-select {
  height: 22px;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 11.5px;
  cursor: pointer;
  flex-shrink: 0;
}
.term-cwd {
  font-family: var(--font-editor);
  font-size: 11.5px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.term-status {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
}
.term-status.exited {
  color: var(--danger);
}
.term-btn {
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.term-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.terminal-host {
  flex: 1;
  min-width: 0;
  min-height: 0;
  padding: 8px 10px 6px;
  overflow: hidden;
  background: var(--bg-surface);
}
.terminal-host :deep(.xterm) {
  height: 100%;
}
.terminal-host :deep(.xterm-viewport) {
  overflow-y: auto !important;
}
</style>
