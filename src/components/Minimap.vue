<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useSettingsStore } from "@/stores/settings";

const props = defineProps<{
  content: string;
  scrollRatio: number;
  viewportRatio: number;
  activeLine?: number;
}>();

const emit = defineEmits<{
  (e: "seek", ratio: number): void;
}>();

const settings = useSettingsStore();

const containerRef = ref<HTMLDivElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const dragging = ref(false);
const hovering = ref(false);

const MINIMAP_WIDTH = 94;
const PAD_X = 7;
const PAD_TOP = 6;
const LINE_PITCH = 3; // 2px glyph height + 1px gap — matches VS Code's crisp minimap density
const CHAR_STEP = 1.5; // crisp micro-character advance
const MAX_COLS = Math.floor((MINIMAP_WIDTH - PAD_X * 2) / CHAR_STEP);

let resizeObserver: ResizeObserver | null = null;
let dragGrabOffsetRatio = 0.5;
let rafId: number | null = null;

interface TokenRun {
  text: string;
  color: string;
  alpha: number;
  bold?: boolean;
}

function isWideChar(code: number): boolean {
  return code >= 0x2e80 && code <= 0x9fff;
}

function tokenizeMarkdownLine(
  raw: string,
  inCodeBlock: boolean,
  palette: {
    heading: string;
    bold: string;
    code: string;
    link: string;
    quote: string;
    accent: string;
    text: string;
    muted: string;
  }
): {
  kind: "heading" | "code" | "quote" | "hr" | "normal";
  headingLevel: number;
  runs: TokenRun[];
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { kind: inCodeBlock ? "code" : "normal", headingLevel: 0, runs: [] };
  }

  if (inCodeBlock || /^```/.test(trimmed)) {
    return {
      kind: "code",
      headingLevel: 0,
      runs: [{ text: raw, color: palette.code, alpha: /^```/.test(trimmed) ? 0.55 : 0.72 }],
    };
  }

  if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
    return { kind: "hr", headingLevel: 0, runs: [] };
  }

  const hMatch = raw.match(/^(#{1,6})\s+(.*)$/);
  if (hMatch) {
    const level = hMatch[1].length;
    return {
      kind: "heading",
      headingLevel: level,
      runs: [
        { text: hMatch[1] + " ", color: palette.accent, alpha: 0.55, bold: true },
        { text: hMatch[2], color: palette.heading, alpha: level <= 2 ? 0.92 : 0.78, bold: true },
      ],
    };
  }

  if (/^\s*>/.test(raw)) {
    return {
      kind: "quote",
      headingLevel: 0,
      runs: [{ text: raw.replace(/^\s*>\s?/, "  "), color: palette.muted, alpha: 0.68 }],
    };
  }

  // Inline tokenizer for bold, inline code, links, list markers, normal text
  const runs: TokenRun[] = [];
  const listMatch = raw.match(/^(\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?)(.*)$/);
  let rest = raw;
  if (listMatch) {
    runs.push({ text: listMatch[1], color: palette.accent, alpha: 0.72 });
    rest = listMatch[2];
  }

  const inlineRe = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|!?\[[^\]]+\]\([^)]+\)|\[\[[^\]]+\]\])/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = inlineRe.exec(rest)) !== null) {
    if (m.index > lastIdx) {
      runs.push({ text: rest.slice(lastIdx, m.index), color: palette.text, alpha: 0.44 });
    }
    const seg = m[0];
    if (seg.startsWith("`")) {
      runs.push({ text: seg.slice(1, -1), color: palette.code, alpha: 0.78 });
    } else if (seg.startsWith("**") || seg.startsWith("__")) {
      runs.push({ text: seg.slice(2, -2), color: palette.bold, alpha: 0.78, bold: true });
    } else {
      runs.push({ text: seg, color: palette.link, alpha: 0.72 });
    }
    lastIdx = inlineRe.lastIndex;
  }
  if (lastIdx < rest.length) {
    runs.push({ text: rest.slice(lastIdx), color: palette.text, alpha: 0.44 });
  }

  return { kind: "normal", headingLevel: 0, runs };
}

function getLayoutMetrics(lineCount: number, viewH: number) {
  const contentH = PAD_TOP * 2 + lineCount * LINE_PITCH;
  const scrollableContent = Math.max(0, contentH - viewH);
  const startYOffset = props.scrollRatio * scrollableContent;

  const visibleLinesApprox = Math.max(8, lineCount * props.viewportRatio);
  const rawSliderH =
    contentH <= viewH
      ? Math.min(viewH, Math.max(24, visibleLinesApprox * LINE_PITCH))
      : Math.min(viewH * 0.72, Math.max(26, viewH * props.viewportRatio));
  const sliderH = Math.min(viewH, rawSliderH);
  const maxSliderTop = Math.max(0, viewH - sliderH);
  const sliderTop =
    contentH <= viewH
      ? props.scrollRatio * Math.max(0, Math.min(viewH, contentH) - sliderH)
      : props.scrollRatio * maxSliderTop;

  return { contentH, startYOffset, sliderTop, sliderH };
}

function scheduleDraw() {
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(() => {
    rafId = null;
    drawMinimap();
  });
}

function drawMinimap() {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const width = MINIMAP_WIDTH;
  const height = Math.max(120, canvas.clientHeight || 500);

  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const styles = getComputedStyle(document.documentElement);
  const isDark = document.documentElement.dataset.themeMode === "dark";
  const palette = {
    heading: styles.getPropertyValue("--md-heading").trim() || "#1e3a5f",
    bold: styles.getPropertyValue("--md-bold").trim() || "#0f172a",
    code: styles.getPropertyValue("--md-code").trim() || "#0d9488",
    link: styles.getPropertyValue("--md-link").trim() || "#2563eb",
    quote: styles.getPropertyValue("--md-quote-bar").trim() || "#64748b",
    accent: styles.getPropertyValue("--accent").trim() || "#2563eb",
    text: styles.getPropertyValue("--text-primary").trim() || "#334155",
    muted: styles.getPropertyValue("--text-muted").trim() || "#94a3b8",
  };

  const lines = props.content.split("\n");
  const { startYOffset, sliderTop, sliderH } = getLayoutMetrics(lines.length, height);

  // Track fenced code blocks accurately up to visible range
  const firstVisibleIdx = Math.max(0, Math.floor((startYOffset - PAD_TOP) / LINE_PITCH));
  const lastVisibleIdx = Math.min(
    lines.length - 1,
    Math.ceil((startYOffset + height) / LINE_PITCH) + 1
  );

  let inCodeBlock = false;
  for (let i = 0; i < firstVisibleIdx; i++) {
    if (/^\s*```/.test(lines[i])) inCodeBlock = !inCodeBlock;
  }

  // 1) Draw active line subtle highlight behind micro-text
  if (props.activeLine && props.activeLine >= 1 && props.activeLine <= lines.length) {
    const activeY = Math.round(PAD_TOP + (props.activeLine - 1) * LINE_PITCH - startYOffset);
    if (activeY >= -LINE_PITCH && activeY <= height) {
      ctx.fillStyle = palette.accent;
      ctx.globalAlpha = isDark ? 0.16 : 0.1;
      ctx.fillRect(0, activeY - 0.5, width, LINE_PITCH + 1);
      ctx.globalAlpha = 0.85;
      ctx.fillRect(width - 2.5, activeY - 0.5, 2.5, LINE_PITCH + 1);
      ctx.globalAlpha = 1;
    }
  }

  // 2) Draw crisp VS Code-style micro-glyph tokens line by line
  for (let i = firstVisibleIdx; i <= lastVisibleIdx; i++) {
    const raw = lines[i];
    const isFence = /^\s*```/.test(raw);
    const lineInCode = inCodeBlock || isFence;
    if (isFence) inCodeBlock = !inCodeBlock;

    const y = Math.round(PAD_TOP + i * LINE_PITCH - startYOffset);
    if (y < -LINE_PITCH || y > height) continue;

    // Subtle code-block backdrop band
    if (lineInCode) {
      ctx.fillStyle = isDark ? "rgba(255,255,255,0.035)" : "rgba(15,23,42,0.035)";
      ctx.fillRect(PAD_X - 2, y - 0.5, width - PAD_X * 2 + 4, LINE_PITCH);
    }

    const parsed = tokenizeMarkdownLine(raw, lineInCode && !isFence, palette);

    if (parsed.kind === "hr") {
      ctx.fillStyle = palette.muted;
      ctx.globalAlpha = 0.3;
      ctx.fillRect(PAD_X, y + 1, width - PAD_X * 2, 1);
      ctx.globalAlpha = 1;
      continue;
    }

    if (parsed.kind === "quote") {
      ctx.fillStyle = palette.quote;
      ctx.globalAlpha = 0.7;
      ctx.fillRect(PAD_X, y, 1.5, 2.2);
    }

    let col = 0;
    const glyphH = parsed.kind === "heading" && parsed.headingLevel <= 2 ? 2.4 : 1.75;

    for (const run of parsed.runs) {
      ctx.fillStyle = run.color;
      ctx.globalAlpha = run.alpha;

      // Merge contiguous non-whitespace characters into crisp micro-word segments
      // with subtle character modulation so it reads like real miniature typography
      let segStartCol = -1;
      let segWidth = 0;

      const flushSegment = () => {
        if (segStartCol >= 0 && segWidth > 0) {
          const x = PAD_X + segStartCol * CHAR_STEP;
          const maxW = width - PAD_X - x;
          if (maxW > 0.5) {
            const drawW = Math.min(segWidth * CHAR_STEP - 0.35, maxW);
            ctx.fillRect(x, y, Math.max(1, drawW), glyphH);
          }
        }
        segStartCol = -1;
        segWidth = 0;
      };

      for (let cIdx = 0; cIdx < run.text.length && col < MAX_COLS; cIdx++) {
        const ch = run.text[cIdx];
        if (ch === " " || ch === "\t") {
          flushSegment();
          col += ch === "\t" ? 2 : 1;
          continue;
        }
        const cw = isWideChar(ch.charCodeAt(0)) ? 1.55 : 1;
        // Break very long CJK/word runs every ~5-6 cols with a 0.35px micro-notch for natural texture
        if (segStartCol < 0) {
          segStartCol = col;
          segWidth = cw;
        } else if (segWidth >= 5.5 && isWideChar(ch.charCodeAt(0))) {
          flushSegment();
          segStartCol = col;
          segWidth = cw;
        } else {
          segWidth += cw;
        }
        col += cw;
      }
      flushSegment();
      if (col >= MAX_COLS) break;
    }
  }

  ctx.globalAlpha = 1;

  // 3) Draw VS Code-style translucent viewport slider on top
  const sliderAlpha = dragging.value
    ? isDark
      ? 0.24
      : 0.19
    : hovering.value
      ? isDark
        ? 0.16
        : 0.12
      : isDark
        ? 0.1
        : 0.075;

  ctx.fillStyle = isDark
    ? `rgba(226, 232, 240, ${sliderAlpha})`
    : `rgba(15, 23, 42, ${sliderAlpha})`;
  ctx.fillRect(0, sliderTop, width, sliderH);

  // Subtle top & bottom crisp hairlines on slider when hovered/dragging
  if (hovering.value || dragging.value) {
    ctx.fillStyle = isDark ? "rgba(255,255,255,0.14)" : "rgba(15,23,42,0.12)";
    ctx.fillRect(0, Math.round(sliderTop), width, 1);
    ctx.fillRect(0, Math.round(sliderTop + sliderH - 1), width, 1);
  }
}

function seekToClientY(clientY: number, useGrabOffset: boolean) {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const y = clientY - rect.top;
  const lines = props.content.split("\n");
  const { sliderH } = getLayoutMetrics(lines.length, rect.height);
  const maxSliderTop = Math.max(1, rect.height - sliderH);

  const desiredTop = useGrabOffset
    ? y - sliderH * dragGrabOffsetRatio
    : y - sliderH * 0.5;
  const ratio = Math.max(0, Math.min(1, desiredTop / maxSliderTop));
  emit("seek", ratio);
}

function onMouseDown(e: MouseEvent) {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const y = e.clientY - rect.top;
  const lines = props.content.split("\n");
  const { sliderTop, sliderH } = getLayoutMetrics(lines.length, rect.height);

  dragging.value = true;
  if (y >= sliderTop && y <= sliderTop + sliderH) {
    dragGrabOffsetRatio = (y - sliderTop) / Math.max(1, sliderH);
  } else {
    dragGrabOffsetRatio = 0.5;
    seekToClientY(e.clientY, false);
  }

  scheduleDraw();
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
}

function onMouseMove(e: MouseEvent) {
  if (dragging.value) seekToClientY(e.clientY, true);
}

function onMouseUp() {
  dragging.value = false;
  scheduleDraw();
  window.removeEventListener("mousemove", onMouseMove);
  window.removeEventListener("mouseup", onMouseUp);
}

watch(
  () => [
    props.content,
    props.scrollRatio,
    props.viewportRatio,
    props.activeLine,
    settings.state.appearance,
    settings.state.lightThemeId,
    settings.state.darkThemeId,
    settings.state.renderColorMode,
    settings.state.customColors,
  ],
  () => scheduleDraw(),
  { deep: true }
);

onMounted(() => {
  scheduleDraw();
  if (containerRef.value && typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => scheduleDraw());
    resizeObserver.observe(containerRef.value);
  }
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  if (rafId !== null) cancelAnimationFrame(rafId);
  window.removeEventListener("mousemove", onMouseMove);
  window.removeEventListener("mouseup", onMouseUp);
});
</script>

<template>
  <div
    ref="containerRef"
    class="minimap-container"
    @mousedown="onMouseDown"
    @mouseenter="hovering = true; scheduleDraw()"
    @mouseleave="hovering = false; scheduleDraw()"
  >
    <canvas ref="canvasRef" class="minimap-canvas" />
  </div>
</template>

<style scoped>
.minimap-container {
  width: 94px;
  flex-shrink: 0;
  height: 100%;
  background: var(--bg-surface);
  border-left: 1px solid color-mix(in srgb, var(--border-color) 45%, transparent);
  box-shadow: inset 4px 0 8px -6px rgba(15, 23, 42, 0.18);
  cursor: default;
  user-select: none;
  position: relative;
}
.minimap-canvas {
  width: 100%;
  height: 100%;
  display: block;
}
</style>
