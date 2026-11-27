import { EditorView, type KeyBinding } from "@codemirror/view";
import { EditorSelection, type EditorState, type Extension, type TransactionSpec } from "@codemirror/state";
import { selectNextOccurrence } from "@codemirror/search";

export const MARKDOWN_SURROUND_PAIRS: Record<string, string> = {
  "*": "*",
  "_": "_",
  "~": "~",
  "`": "`",
  "=": "=",
  "+": "+",
  "^": "^",
  "$": "$",
  "(": ")",
  "[": "]",
  "{": "}",
  "<": ">",
  '"': '"',
  "'": "'",
  "（": "）",
  "【": "】",
  "《": "》",
  "“": "”",
  "‘": "’",
};

export function buildAutoSurroundTransaction(
  state: EditorState,
  inputText: string
): TransactionSpec | null {
  const close = MARKDOWN_SURROUND_PAIRS[inputText];
  if (!close) return null;
  if (!state.selection.ranges.some((r) => !r.empty)) return null;

  const open = inputText;
  const spec = state.changeByRange((range) => {
    if (range.empty) return { range };
    const selected = state.sliceDoc(range.from, range.to);
    return {
      changes: { from: range.from, to: range.to, insert: `${open}${selected}${close}` },
      range: EditorSelection.range(range.from + open.length, range.to + open.length),
    };
  });
  return { ...spec, userEvent: "input.type" };
}

export const markdownAutoSurroundExtension: Extension = EditorView.inputHandler.of(
  (view, from, to, text) => {
    if (view.composing || from === to) return false;
    const tr = buildAutoSurroundTransaction(view.state, text);
    if (!tr) return false;
    view.dispatch(tr);
    return true;
  }
);

function toggleInlineWrap(view: EditorView, marker: string): boolean {
  const { state } = view;
  const len = marker.length;

  const spec = state.changeByRange((range) => {
    if (range.empty) {
      return {
        changes: { from: range.from, to: range.to, insert: `${marker}${marker}` },
        range: EditorSelection.cursor(range.from + len),
      };
    }

    const selected = state.sliceDoc(range.from, range.to);
    const before = state.sliceDoc(Math.max(0, range.from - len), range.from);
    const after = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + len));

    if (before === marker && after === marker) {
      return {
        changes: [
          { from: range.from - len, to: range.from, insert: "" },
          { from: range.to, to: range.to + len, insert: "" },
        ],
        range: EditorSelection.range(range.from - len, range.to - len),
      };
    }
    if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length >= len * 2) {
      return {
        changes: { from: range.from, to: range.to, insert: selected.slice(len, -len) },
        range: EditorSelection.range(range.from, range.to - len * 2),
      };
    }
    return {
      changes: { from: range.from, to: range.to, insert: `${marker}${selected}${marker}` },
      range: EditorSelection.range(range.from + len, range.to + len),
    };
  });

  view.dispatch({ ...spec, userEvent: "input.format" });
  return true;
}

/**
 * VS Code-style vertical multi-cursor (Ctrl+Alt+Up / Ctrl+Alt+Down):
 * adds a new cursor on the line directly above or below the topmost/bottommost cursor at the same column.
 */
export function addCursorVertical(view: EditorView, direction: -1 | 1): boolean {
  const { state } = view;
  const doc = state.doc;
  const ranges = state.selection.ranges;
  const anchorRange = direction < 0 ? ranges[0] : ranges[ranges.length - 1];
  const curLine = doc.lineAt(anchorRange.head);
  const targetLineNo = curLine.number + direction;
  if (targetLineNo < 1 || targetLineNo > doc.lines) return false;

  const col = anchorRange.head - curLine.from;
  const targetLine = doc.line(targetLineNo);
  const targetPos = targetLine.from + Math.min(col, targetLine.length);

  if (ranges.some((r) => r.head === targetPos && r.empty)) return false;

  const nextRanges = [...ranges, EditorSelection.cursor(targetPos)];
  view.dispatch({
    selection: EditorSelection.create(nextRanges, nextRanges.length - 1),
    effects: EditorView.scrollIntoView(targetPos),
  });
  return true;
}

function collapseToSingleCursor(view: EditorView): boolean {
  if (view.state.selection.ranges.length <= 1) return false;
  const main = view.state.selection.main;
  view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(main.head)]) });
  return true;
}

export const columnEditingKeymap: KeyBinding[] = [
  { key: "Ctrl-Alt-ArrowUp", mac: "Cmd-Alt-ArrowUp", run: (v) => addCursorVertical(v, -1) },
  { key: "Ctrl-Alt-ArrowDown", mac: "Cmd-Alt-ArrowDown", run: (v) => addCursorVertical(v, 1) },
  { key: "Mod-d", run: selectNextOccurrence, preventDefault: true },
  { key: "Escape", run: collapseToSingleCursor },
];

export const markdownFormatKeymap: KeyBinding[] = [
  { key: "Mod-b", run: (v) => toggleInlineWrap(v, "**") },
  { key: "Mod-i", run: (v) => toggleInlineWrap(v, "*") },
  { key: "Mod-u", run: (v) => toggleInlineWrap(v, "++") },
  { key: "Mod-Shift-x", run: (v) => toggleInlineWrap(v, "~~") },
  { key: "Mod-e", run: (v) => toggleInlineWrap(v, "`") },
  { key: "Mod-Shift-h", run: (v) => toggleInlineWrap(v, "==") },
];
