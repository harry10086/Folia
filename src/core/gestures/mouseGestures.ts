export type GestureActionId =
  | "prevTab"
  | "nextTab"
  | "closeTab"
  | "scrollTop"
  | "scrollBottom"
  | "toggleMode"
  | "toggleSidebar"
  | "newNote"
  | "quickOpen";

export interface GestureDefinition {
  sequence: string; // e.g. "L", "R", "DR", "U", "D", "UD"
  action: GestureActionId;
}

export const GESTURE_ACTION_LABELS: Record<GestureActionId, string> = {
  prevTab: "切换到上一个标签页",
  nextTab: "切换到下一个标签页",
  closeTab: "关闭当前标签页",
  scrollTop: "滚动到文档顶部",
  scrollBottom: "滚动到文档底部",
  toggleMode: "切换源码 / 实时预览",
  toggleSidebar: "显示 / 隐藏左侧文件栏",
  newNote: "新建笔记",
  quickOpen: "快速打开文件",
};

export const GESTURE_ACTION_OPTIONS: Array<{ value: GestureActionId; label: string }> = (
  Object.keys(GESTURE_ACTION_LABELS) as GestureActionId[]
).map((key) => ({ value: key, label: GESTURE_ACTION_LABELS[key] }));

export const DEFAULT_GESTURES: GestureDefinition[] = [
  { sequence: "L", action: "prevTab" },
  { sequence: "R", action: "nextTab" },
  { sequence: "DR", action: "closeTab" },
  { sequence: "U", action: "scrollTop" },
  { sequence: "D", action: "scrollBottom" },
  { sequence: "UD", action: "toggleMode" },
];

export function formatGestureSequence(seq: string): string {
  const arrowMap: Record<string, string> = { L: "←", R: "→", U: "↑", D: "↓" };
  return seq
    .toUpperCase()
    .split("")
    .map((ch) => arrowMap[ch] ?? ch)
    .join("");
}

export function formatGestureLabel(g: GestureDefinition): string {
  return `${formatGestureSequence(g.sequence)} ${GESTURE_ACTION_LABELS[g.action] ?? g.action}`;
}

export interface MouseGestureControllerOptions {
  isEnabled: () => boolean;
  getGestures: () => GestureDefinition[];
  onAction: (action: GestureActionId) => void;
}

export class MouseGestureController {
  private active = false;
  private triggered = false;
  private suppressContextMenuOnce = false;
  private startX = 0;
  private startY = 0;
  private lastX = 0;
  private lastY = 0;
  private sequence = "";
  private points: Array<{ x: number; y: number }> = [];
  private canvas: HTMLCanvasElement | null = null;
  private labelEl: HTMLDivElement | null = null;
  private readonly options: MouseGestureControllerOptions;

  constructor(options: MouseGestureControllerOptions) {
    this.options = options;
  }

  mount(): void {
    window.addEventListener("mousedown", this.handleMouseDown, true);
    window.addEventListener("mousemove", this.handleMouseMove, true);
    window.addEventListener("mouseup", this.handleMouseUp, true);
    window.addEventListener("contextmenu", this.handleContextMenu, true);
  }

  unmount(): void {
    window.removeEventListener("mousedown", this.handleMouseDown, true);
    window.removeEventListener("mousemove", this.handleMouseMove, true);
    window.removeEventListener("mouseup", this.handleMouseUp, true);
    window.removeEventListener("contextmenu", this.handleContextMenu, true);
    this.cleanupOverlay();
  }

  private handleMouseDown = (e: MouseEvent) => {
    // Do not intercept while user is recording a gesture inside settings modal
    if ((e.target as HTMLElement | null)?.closest("[data-gesture-recorder]")) return;
    if (!this.options.isEnabled() || e.button !== 2) return;
    this.active = true;
    this.triggered = false;
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.sequence = "";
    this.points = [{ x: e.clientX, y: e.clientY }];
  };

  private handleMouseMove = (e: MouseEvent) => {
    if (!this.active) return;
    const dxTotal = e.clientX - this.startX;
    const dyTotal = e.clientY - this.startY;

    if (!this.triggered && Math.hypot(dxTotal, dyTotal) > 18) {
      this.triggered = true;
      this.ensureOverlay();
    }

    if (!this.triggered) return;

    this.points.push({ x: e.clientX, y: e.clientY });
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    if (Math.hypot(dx, dy) >= 28) {
      const dir = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "R" : "L") : dy > 0 ? "D" : "U";
      if (!this.sequence.endsWith(dir) && this.sequence.length < 4) {
        this.sequence += dir;
      }
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    }

    this.renderOverlay();
  };

  private handleMouseUp = (e: MouseEvent) => {
    if (!this.active || e.button !== 2) return;
    this.active = false;

    if (this.triggered) {
      this.suppressContextMenuOnce = true;
      setTimeout(() => {
        this.suppressContextMenuOnce = false;
      }, 80);

      const matched = this.options
        .getGestures()
        .find((g) => g.sequence.toUpperCase() === this.sequence);
      if (matched) {
        this.options.onAction(matched.action);
      }
    }

    this.triggered = false;
    this.cleanupOverlay();
  };

  private handleContextMenu = (e: MouseEvent) => {
    if (this.suppressContextMenuOnce) {
      e.preventDefault();
      e.stopPropagation();
      this.suppressContextMenuOnce = false;
    }
  };

  private ensureOverlay(): void {
    if (!this.canvas) {
      const c = document.createElement("canvas");
      c.width = window.innerWidth;
      c.height = window.innerHeight;
      Object.assign(c.style, {
        position: "fixed",
        inset: "0",
        pointerEvents: "none",
        zIndex: "9999",
      });
      document.body.appendChild(c);
      this.canvas = c;
    }
    if (!this.labelEl) {
      const el = document.createElement("div");
      Object.assign(el.style, {
        position: "fixed",
        left: "50%",
        top: "50%",
        transform: "translate(-50%, -50%)",
        padding: "8px 16px",
        borderRadius: "999px",
        background: "rgba(15, 23, 42, 0.82)",
        color: "#ffffff",
        fontSize: "13px",
        fontWeight: "500",
        letterSpacing: "0.02em",
        pointerEvents: "none",
        zIndex: "10000",
        boxShadow: "0 8px 24px rgba(0,0,0,0.22)",
      });
      document.body.appendChild(el);
      this.labelEl = el;
    }
  }

  private renderOverlay(): void {
    if (this.canvas) {
      const ctx = this.canvas.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        if (this.points.length > 1) {
          ctx.beginPath();
          ctx.moveTo(this.points[0].x, this.points[0].y);
          for (let i = 1; i < this.points.length; i++) {
            ctx.lineTo(this.points[i].x, this.points[i].y);
          }
          ctx.strokeStyle =
            getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() ||
            "#2563eb";
          ctx.lineWidth = 3;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.stroke();
        }
      }
    }

    if (this.labelEl) {
      const matched = this.options
        .getGestures()
        .find((g) => g.sequence.toUpperCase() === this.sequence);
      this.labelEl.textContent = matched
        ? formatGestureLabel(matched)
        : this.sequence
          ? `未绑定手势: ${formatGestureSequence(this.sequence)}`
          : "拖动执行手势";
    }
  }

  private cleanupOverlay(): void {
    if (this.canvas) {
      this.canvas.remove();
      this.canvas = null;
    }
    if (this.labelEl) {
      this.labelEl.remove();
      this.labelEl = null;
    }
  }
}
