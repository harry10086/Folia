<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive } from "vue";

const tip = reactive({
  visible: false,
  text: "",
  x: 0,
  y: 0,
  placement: "bottom" as "bottom" | "top",
});

let currentEl: HTMLElement | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let hideCooldownUntil = 0;

function clearTimer() {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
}

function hideTooltip() {
  clearTimer();
  if (tip.visible) {
    hideCooldownUntil = Date.now() + 250;
  }
  tip.visible = false;
  currentEl = null;
}

function positionFor(el: HTMLElement) {
  const text = el.getAttribute("data-tip")?.trim();
  if (!text) {
    hideTooltip();
    return;
  }
  const rect = el.getBoundingClientRect();
  const estWidth = Math.min(280, Math.max(60, text.length * 10 + 18));
  const half = estWidth / 2;
  const centerX = rect.left + rect.width / 2;
  const clampedX = Math.max(half + 8, Math.min(window.innerWidth - half - 8, centerX));

  const spaceBelow = window.innerHeight - rect.bottom;
  const placement = spaceBelow < 42 && rect.top > 42 ? "top" : "bottom";

  tip.text = text;
  tip.x = clampedX;
  tip.y = placement === "bottom" ? rect.bottom + 7 : rect.top - 7;
  tip.placement = placement;
  tip.visible = true;
}

function onPointerOver(e: MouseEvent) {
  const target = (e.target as HTMLElement | null)?.closest("[data-tip]") as HTMLElement | null;
  if (!target) {
    if (currentEl) hideTooltip();
    return;
  }
  if (target === currentEl && tip.visible) {
    // Refresh dynamic text (e.g. toggle state changed)
    const nextText = target.getAttribute("data-tip")?.trim() ?? "";
    if (nextText) tip.text = nextText;
    return;
  }

  currentEl = target;
  clearTimer();

  // Instant switch when moving directly from one toolbar icon to another
  const delay = tip.visible || Date.now() < hideCooldownUntil ? 40 : 180;
  showTimer = setTimeout(() => {
    if (currentEl && currentEl.isConnected) {
      positionFor(currentEl);
    }
  }, delay);
}

function onPointerOut(e: MouseEvent) {
  if (!currentEl) return;
  const related = (e.relatedTarget as HTMLElement | null)?.closest("[data-tip]") as HTMLElement | null;
  if (related === currentEl) return;
  if (!related) {
    hideTooltip();
  }
}

function onMouseDown() {
  hideTooltip();
}

function onScrollOrBlur() {
  hideTooltip();
}

onMounted(() => {
  document.addEventListener("mouseover", onPointerOver, true);
  document.addEventListener("mouseout", onPointerOut, true);
  document.addEventListener("mousedown", onMouseDown, true);
  window.addEventListener("scroll", onScrollOrBlur, true);
  window.addEventListener("blur", onScrollOrBlur);
});

onBeforeUnmount(() => {
  clearTimer();
  document.removeEventListener("mouseover", onPointerOver, true);
  document.removeEventListener("mouseout", onPointerOut, true);
  document.removeEventListener("mousedown", onMouseDown, true);
  window.removeEventListener("scroll", onScrollOrBlur, true);
  window.removeEventListener("blur", onScrollOrBlur);
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="tip.visible"
      class="folia-global-tooltip"
      :class="`is-${tip.placement}`"
      :style="{ left: `${tip.x}px`, top: `${tip.y}px` }"
    >
      {{ tip.text }}
    </div>
  </Teleport>
</template>

<style scoped>
.folia-global-tooltip {
  position: fixed;
  z-index: 9999;
  pointer-events: none;
  transform: translateX(-50%);
  padding: 5px 10px;
  border-radius: 6px;
  background: rgba(15, 23, 42, 0.92);
  color: #f8fafc;
  font-size: 12px;
  line-height: 1.35;
  white-space: pre-line;
  max-width: 280px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.22);
  border: 1px solid rgba(255, 255, 255, 0.08);
  animation: tip-fade 0.1s ease-out;
}
.folia-global-tooltip.is-top {
  transform: translate(-50%, -100%);
}
@keyframes tip-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>
