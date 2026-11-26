import type { KeyBinding } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";

function toggleInlineWrap(view: EditorView, marker: string): boolean {
  const { state } = view;
  const sel = state.selection.main;
  const len = marker.length;

  if (sel.empty) {
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: `${marker}${marker}` },
      selection: { anchor: sel.from + len },
    });
    return true;
  }

  const selected = state.sliceDoc(sel.from, sel.to);
  const before = state.sliceDoc(Math.max(0, sel.from - len), sel.from);
  const after = state.sliceDoc(sel.to, Math.min(state.doc.length, sel.to + len));

  if (before === marker && after === marker) {
    view.dispatch({
      changes: [
        { from: sel.from - len, to: sel.from, insert: "" },
        { from: sel.to, to: sel.to + len, insert: "" },
      ],
      selection: { anchor: sel.from - len, head: sel.to - len },
    });
  } else if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length >= len * 2) {
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: selected.slice(len, -len) },
      selection: { anchor: sel.from, head: sel.to - len * 2 },
    });
  } else {
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: `${marker}${selected}${marker}` },
      selection: { anchor: sel.from + len, head: sel.to + len },
    });
  }
  return true;
}

export const markdownFormatKeymap: KeyBinding[] = [
  { key: "Mod-b", run: (v) => toggleInlineWrap(v, "**") },
  { key: "Mod-i", run: (v) => toggleInlineWrap(v, "*") },
  { key: "Mod-u", run: (v) => toggleInlineWrap(v, "++") },
  { key: "Mod-Shift-x", run: (v) => toggleInlineWrap(v, "~~") },
  { key: "Mod-e", run: (v) => toggleInlineWrap(v, "`") },
  { key: "Mod-Shift-h", run: (v) => toggleInlineWrap(v, "==") },
];
