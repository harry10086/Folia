<script setup lang="ts">
import type { HeadingItem } from "@/core/markdown/outline";
import { List } from "lucide-vue-next";
import { useI18n } from "@/core/i18n";

const { t } = useI18n();

defineProps<{
  headings: HeadingItem[];
  activeLine: number;
}>();

const emit = defineEmits<{
  (e: "jump", line: number): void;
}>();

function isCurrentHeading(headings: HeadingItem[], idx: number, activeLine: number): boolean {
  const cur = headings[idx];
  const next = headings[idx + 1];
  return activeLine >= cur.line && (!next || activeLine < next.line);
}
</script>

<template>
  <aside class="outline-panel">
    <div class="outline-header">
      <List :size="14" /><span>{{ t("outline.title") }}</span>
    </div>
    <div class="outline-body">
      <div v-if="headings.length === 0" class="outline-empty">{{ t("outline.empty") }}</div>
      <button
        v-for="(h, idx) in headings"
        :key="`${h.line}-${h.text}`"
        class="outline-item"
        :class="{ active: isCurrentHeading(headings, idx, activeLine) }"
        :style="{ paddingLeft: `${(h.level - 1) * 12 + 12}px` }"
        @click="emit('jump', h.line)"
        :title="h.text"
      >
        <span class="outline-text">{{ h.text }}</span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.outline-panel { width: 215px; flex-shrink: 0; height: 100%; display: flex; flex-direction: column; background: var(--bg-base); border-left: 1px solid var(--border-color); user-select: none; }
.outline-header { display: flex; align-items: center; gap: 6px; padding: 10px 12px; font-size: 12px; font-weight: 600; color: var(--text-secondary); border-bottom: 1px solid var(--border-color); }
.outline-body { flex: 1; overflow-y: auto; padding: 6px 4px; }
.outline-empty { padding: 20px 12px; font-size: 12.5px; color: var(--text-muted); text-align: center; }
.outline-item { width: 100%; display: block; text-align: left; border: none; background: transparent; color: var(--text-secondary); font-size: 12.5px; line-height: 1.5; padding: 5px 10px; border-radius: var(--radius-sm); cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.outline-item:hover { background: var(--bg-hover); color: var(--text-primary); }
.outline-item.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
</style>
