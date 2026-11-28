<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import "@xterm/xterm/css/xterm.css";
import { RotateCcw, Trash2, Terminal as TerminalIcon } from "lucide-vue-next";
import { ipc, isTauriRuntime } from "@/core/ipc/client";
import { useI18n } from "@/core/i18n";
import { useSettingsStore } from "@/stores/settings";
import {
  buildXtermTheme,
  getOrCreateTerminalInstance,
  startInstanceSession,
  type LiveTerminalInstance,
} from "@/core/terminal/terminalRegistry";

const { t } = useI18n();

const props = defineProps<{
  tabId: string;
  cwd: string;
  workspaceName: string;
  visible?: boolean;
}>();

const settings = useSettingsStore();

const inst: LiveTerminalInstance = getOrCreateTerminalInstance(props.tabId, props.cwd, settings.state);
const hostRef = ref<HTMLDivElement | null>(null);
const activeShell = inst.activeShell;
const statusText = inst.statusText;
const exited = inst.exited;

let resizeObserver: ResizeObserver | null = null;
let fitTimer: ReturnType<typeof setTimeout> | null = null;

function applyTerminalOptions() {
  if (inst.disposed) return;
  inst.term.options.fontFamily =
    settings.state.terminalFont.trim() || "Cascadia Mono, Consolas, JetBrains Mono, monospace";
  inst.term.options.fontSize = Math.max(10, Math.min(26, settings.state.terminalFontSize || 13));
  inst.term.options.lineHeight = Math.max(1.0, Math.min(2.0, settings.state.terminalLineHeight || 1.35));
  inst.term.options.cursorStyle = settings.state.terminalCursorStyle || "bar";
  inst.term.options.theme = buildXtermTheme();
  scheduleFit();
}

function scheduleFit() {
  if (fitTimer) clearTimeout(fitTimer);
  fitTimer = setTimeout(() => {
    if (inst.disposed || !hostRef.value) return;
    if (hostRef.value.clientWidth < 40 || hostRef.value.clientHeight < 40) return;
    try {
      inst.fitAddon.fit();
      if (inst.sessionId && isTauriRuntime()) {
        void ipc.terminalResize(inst.sessionId, inst.term.cols, inst.term.rows);
      }
    } catch {
      // ignore transient zero-size layout
    }
  }, 45);
}

async function restartTerminal() {
  inst.term.clear();
  await startInstanceSession(inst, settings.state.terminalCustomPath || null, scheduleFit);
}

function clearTerminal() {
  inst.term.clear();
  inst.term.focus();
}

function handleShellChange() {
  void restartTerminal();
}

onMounted(async () => {
  if (!hostRef.value) return;

  // Attach (or re-attach after cross-pane move) the persistent xterm host element
  hostRef.value.appendChild(inst.containerEl);

  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => scheduleFit());
    resizeObserver.observe(hostRef.value);
  }

  if (!inst.started) {
    inst.started = true;
    inst.term.open(inst.containerEl);

    if (isTauriRuntime()) {
      inst.unlistenData = await ipc.onTerminalData((ev) => {
        if (ev.id === inst.sessionId && !inst.disposed) {
          inst.term.write(ev.data);
        }
      });
      inst.unlistenExit = await ipc.onTerminalExit((ev) => {
        if (ev.id === inst.sessionId && !inst.disposed) {
          inst.sessionId = null;
          inst.exited.value = true;
          inst.statusText.value = t("terminal.exited");
          inst.term.writeln("\r\n\x1b[90m[终端进程已结束，点击右上角重启按钮可重新打开]\x1b[0m");
        }
      });
    }

    try {
      inst.fitAddon.fit();
    } catch {
      // ignore
    }
    await startInstanceSession(inst, settings.state.terminalCustomPath || null, scheduleFit);
  } else {
    // Re-attached after moving to another pane: preserve running PTY & full scrollback
    applyTerminalOptions();
    await nextTick();
    scheduleFit();
    if (props.visible !== false) {
      inst.term.focus();
    }
  }
});

watch(
  () => props.visible,
  (isVisible) => {
    if (isVisible) {
      void nextTick(() => {
        scheduleFit();
        inst.term.focus();
      });
    }
  }
);

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
  // Keep PTY & xterm buffer alive in terminalRegistry until the tab is explicitly closed
  if (inst.containerEl.parentNode === hostRef.value) {
    inst.containerEl.remove();
  }
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
          :data-tip="t('terminal.switchShellTip')"
        >
          <option value="git-bash">Git Bash</option>
          <option value="powershell">PowerShell</option>
          <option value="cmd">{{ t("terminal.cmdOption") }}</option>
          <option value="zsh">Zsh / Bash</option>
          <option value="custom">{{ t("terminal.customOption") }}</option>
        </select>
        <span class="term-cwd" :title="cwd">{{ cwd }}</span>
      </div>
      <div class="term-right">
        <span class="term-status" :class="{ exited }">{{ statusText }}</span>
        <button class="term-btn" @click="clearTerminal" :data-tip="t('terminal.clearTip')">
          <Trash2 :size="13" />
        </button>
        <button class="term-btn" @click="restartTerminal" :data-tip="t('terminal.restartTip')">
          <RotateCcw :size="13" />
        </button>
      </div>
    </div>

    <div ref="hostRef" class="terminal-host" @click="inst.term.focus()" />
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
