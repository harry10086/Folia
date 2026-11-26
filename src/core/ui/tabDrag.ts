import { reactive } from "vue";

export interface TabDragState {
  active: boolean;
  sourcePaneId: string | null;
  tabId: string | null;
  sourceIndex: number;
  title: string;
  clientX: number;
  clientY: number;
  // Target when hovering a tab strip
  hoverPaneId: string | null;
  hoverTabIndex: number | null;
  hoverSide: "before" | "after" | null;
  // Target when hovering a pane body for edge split or cross-pane move
  bodyPaneId: string | null;
  bodyZone: "left" | "right" | "center" | null;
}

export const tabDragState = reactive<TabDragState>({
  active: false,
  sourcePaneId: null,
  tabId: null,
  sourceIndex: -1,
  title: "",
  clientX: 0,
  clientY: 0,
  hoverPaneId: null,
  hoverTabIndex: null,
  hoverSide: null,
  bodyPaneId: null,
  bodyZone: null,
});

export function resetTabDragState() {
  tabDragState.active = false;
  tabDragState.sourcePaneId = null;
  tabDragState.tabId = null;
  tabDragState.sourceIndex = -1;
  tabDragState.title = "";
  tabDragState.hoverPaneId = null;
  tabDragState.hoverTabIndex = null;
  tabDragState.hoverSide = null;
  tabDragState.bodyPaneId = null;
  tabDragState.bodyZone = null;
}
