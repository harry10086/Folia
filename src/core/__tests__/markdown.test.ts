import { describe, it, expect } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { Decoration } from "@codemirror/view";
import { EditorState, EditorSelection } from "@codemirror/state";
import { extractOutline, slugifyHeading, findAnchorLine } from "@/core/markdown/outline";
import { buildAutoSurroundTransaction } from "@/core/markdown/formatCommands";
import {
  assembleSafeDecorationSet,
  decorateInlinePatterns,
  resolveImageSrc,
  parseAbbreviationDef,
} from "@/core/markdown/livePreview";
import {
  highlightCodeBlock,
  loadCodeLanguage,
  renderHighlightedLines,
  resolveCodeLanguageDescription,
} from "@/core/markdown/codeHighlighter";
import { compareSemver } from "@/core/update/updater";
import { LIGHT_THEMES, DARK_THEMES, findThemeById } from "@/core/theme/themes";
import { parseThemeYaml, serializeThemeToYaml } from "@/core/theme/themeYaml";
import { useTabsStore } from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";
import {
  isWikilinkTargetValid,
  parseWikilinkTarget,
  rewriteLinksInMarkdown,
} from "@/core/markdown/wikilinks";

const SAMPLE_MARKDOWN = `---
category: 欢迎使用
---
# Folia 笔记示例
### 表格支持
| 功能 | 快捷键 |
| --- | --- |
| \`Ctrl+B\` | 加粗 |
\`\`\`rust
// # not a heading
fn main() {}
\`\`\`
### LaTeX 数学公式
使用 \`$\` 与 $E = mc^2$。
### Mermaid 图表示例
## 提示块语法
> [!TIP] 提示
## 链接语法
## 行内扩展语法
- 示例 \` :rocket: \` 与 :rocket:
`;

describe("Markdown Outline Extraction", () => {
  it("extracts headings from Markdown while ignoring frontmatter and fenced code", () => {
    const headings = extractOutline(SAMPLE_MARKDOWN);

    expect(headings.length).toBeGreaterThanOrEqual(7);
    expect(headings[0].level).toBe(1);
    expect(headings[0].text).toBe("Folia 笔记示例");
    expect(headings.some((h) => h.text === "表格支持")).toBe(true);
    expect(headings.some((h) => h.text === "LaTeX 数学公式")).toBe(true);
    expect(headings.some((h) => h.text === "Mermaid 图表示例")).toBe(true);
    expect(headings.some((h) => h.text === "提示块语法")).toBe(true);
    expect(headings.some((h) => h.text === "链接语法")).toBe(true);
  });

  it("slugifies Chinese and English headings consistently", () => {
    expect(slugifyHeading("表格支持")).toBe("表格支持");
    expect(slugifyHeading("LaTeX 数学公式")).toBe("latex-数学公式");
  });
});

describe("Relative Image Path Resolution", () => {
  it("resolves nested ../ relative Chinese image paths to folia-asset protocol", () => {
    const resolved = resolveImageSrc("../图片/esp32.png", "D:\\MyNotes\\私人文档\\项目A.md");
    expect(resolved).toContain("folia-asset");
    expect(resolved).toContain(encodeURIComponent("图片"));
    expect(resolved).toContain("esp32.png");
    expect(resolved).not.toContain("..");
  });

  it("keeps external https URLs unchanged", () => {
    const url = "https://example.com/images/sample.png";
    expect(resolveImageSrc(url, "D:\\MyNotes\\a.md")).toBe(url);
  });
});

describe("Folia Theme System", () => {
  it("includes Studio Daylight and Obsidian Night presets with 5 swatches each", () => {
    expect(LIGHT_THEMES.length).toBeGreaterThanOrEqual(8);
    expect(DARK_THEMES.length).toBeGreaterThanOrEqual(5);
    const studio = findThemeById("studio-daylight", "light");
    expect(studio.name).toBe("Studio Daylight");
    expect(studio.swatches).toHaveLength(5);
  });
});

describe("Live Preview Decoration Safety & Updater", () => {
  it("never throws on overlapping replace/mark/line decorations at identical positions", () => {
    const decoSet = assembleSafeDecorationSet([
      { from: 0, to: 0, kind: "line", deco: Decoration.line({ class: "cm-md-h cm-md-h1" }) },
      { from: 0, to: 2, kind: "replace", deco: Decoration.replace({}) },
      // Deliberate collision: mark and replace on identical span (like `:rocket:` inside inline code)
      { from: 8, to: 16, kind: "mark", deco: Decoration.mark({ class: "cm-md-inline-code" }) },
      { from: 8, to: 16, kind: "replace", deco: Decoration.replace({}) },
      // Overlapping partial replace
      { from: 12, to: 20, kind: "replace", deco: Decoration.replace({}) },
    ]);
    expect(decoSet.size).toBeGreaterThan(0);
  });

  it("compares semver versions accurately", () => {
    expect(compareSemver("v0.2.0", "0.1.0")).toBeGreaterThan(0);
    expect(compareSemver("v0.1.0", "0.1.0")).toBe(0);
    expect(compareSemver("0.1.0", "v0.1.1")).toBeLessThan(0);
  });

  it("cycles vertical and horizontal split 1 -> 2 -> 3 -> 1 cleanly", () => {
    setActivePinia(createPinia());
    const tabs = useTabsStore();
    for (const dir of ["vertical", "horizontal"] as const) {
      expect(tabs.panes.length).toBe(1);
      tabs.toggleSplit(dir);
      expect(tabs.panes.length).toBe(2);
      expect(tabs.splitDirection).toBe(dir);
      tabs.toggleSplit(dir);
      expect(tabs.panes.length).toBe(3);
      expect(tabs.splitDirection).toBe(dir);
      tabs.toggleSplit(dir);
      expect(tabs.panes.length).toBe(1);
      expect(tabs.splitDirection).toBe("none");
    }
  });

  it("serializes and parses custom theme YAML including minimal snippets", () => {
    const yaml = serializeThemeToYaml(LIGHT_THEMES[0]);
    const parsed = parseThemeYaml(yaml);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.theme.name).toBe(LIGHT_THEMES[0].name);
      expect(parsed.theme.accent).toBe(LIGHT_THEMES[0].accent);
      expect(parsed.theme.mode).toBe("light");
    }

    const minimal = parseThemeYaml(`
name: Sage Ink Dark
mode: dark # dark theme
colors:
  bgBase: #11261d
  accent: "#63b88c"
`);
    expect(minimal.ok).toBe(true);
    if (minimal.ok) {
      expect(minimal.theme.name).toBe("Sage Ink Dark");
      expect(minimal.theme.mode).toBe("dark");
      expect(minimal.theme.bgBase).toBe("#11261d");
      expect(minimal.theme.accent).toBe("#63b88c");
      expect(minimal.theme.textPrimary).toBe(DARK_THEMES[0].textPrimary);
    }
  });

  it("auto-surrounds selected text on Markdown triggers and supports double-press (** / ~~ / == / [[)", () => {
    let state = EditorState.create({
      doc: "hello 世界",
      selection: EditorSelection.range(6, 8), // "世界"
    });

    // Press * once -> *世界* with "世界" still selected
    const tr1 = buildAutoSurroundTransaction(state, "*");
    expect(tr1).not.toBeNull();
    state = state.update(tr1!).state;
    expect(state.doc.toString()).toBe("hello *世界*");
    expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe("世界");

    // Press * again -> **世界**
    const tr2 = buildAutoSurroundTransaction(state, "*");
    expect(tr2).not.toBeNull();
    state = state.update(tr2!).state;
    expect(state.doc.toString()).toBe("hello **世界**");
    expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe("世界");

    // Press [ twice -> **[[世界]]**
    state = state.update(buildAutoSurroundTransaction(state, "[")!).state;
    state = state.update(buildAutoSurroundTransaction(state, "[")!).state;
    expect(state.doc.toString()).toBe("hello **[[世界]]**");

    // Normal text typing does not trigger surround
    expect(buildAutoSurroundTransaction(state, "a")).toBeNull();
  });

  it("parses standard *[ABBR]: and non-URL [ABBR]: abbreviations without misclassifying link references", () => {
    const std = parseAbbreviationDef("*[HTML]: Hyper Text Markup Language");
    expect(std?.term).toBe("HTML");
    expect(std?.expansion).toBe("Hyper Text Markup Language");
    expect(std?.isStandard).toBe(true);

    const shorthand = parseAbbreviationDef("[HTML]: Hyper Text Markup Language");
    expect(shorthand?.term).toBe("HTML");
    expect(shorthand?.expansion).toBe("Hyper Text Markup Language");
    expect(shorthand?.isStandard).toBe(false);

    // Must NOT treat link reference definitions or footnotes as abbreviations
    expect(parseAbbreviationDef("[google]: https://google.com")).toBeNull();
    expect(parseAbbreviationDef("[guide]: ./README.md")).toBeNull();
    expect(parseAbbreviationDef("[^note]: footnote text")).toBeNull();
  });

  it("resolves {#custom-id}, auto slugs, duplicate heading suffixes, and HTML anchors", () => {
    const doc = [
      "# 一级标题",
      "### 三级标题 {#id33}",
      "## 重复标题",
      "## 重复标题",
      '<a id="legacy-anchor"></a>',
    ].join("\n");

    const outline = extractOutline(doc);
    expect(outline[1].text).toBe("三级标题");
    expect(outline[1].customId).toBe("id33");

    expect(findAnchorLine(doc, "#id33")).toBe(2);
    expect(findAnchorLine(doc, "#三级标题")).toBe(2);
    expect(findAnchorLine(doc, "#重复标题")).toBe(3);
    expect(findAnchorLine(doc, "#重复标题-1")).toBe(4);
    expect(findAnchorLine(doc, "#legacy-anchor")).toBe(5);
  });

  it("hides outer and inner delimiters cleanly for nested inline Markdown without losing styles", () => {
    const inspectHidden = (line: string) => {
      const items: Parameters<typeof decorateInlinePatterns>[3] = [];
      decorateInlinePatterns(0, line, true, items);
      const set = assembleSafeDecorationSet(items);
      const replaces: Array<[number, number]> = [];
      const marks: Array<{ from: number; to: number; cls: string }> = [];
      const iter = set.iter();
      while (iter.value) {
        const spec = iter.value.spec as { class?: string; widget?: unknown };
        if (spec.class) {
          marks.push({ from: iter.from, to: iter.to, cls: spec.class });
        } else {
          replaces.push([iter.from, iter.to]);
        }
        iter.next();
      }
      // Reconstruct visible text after replace({}) hides delimiters
      let visible = "";
      for (let i = 0; i < line.length; i++) {
        if (!replaces.some(([f, t]) => i >= f && i < t)) {
          visible += line[i];
        }
      }
      return { visible, replaces, marks };
    };

    // Exact user-reported case: bold wrapping inline code
    const case1 = inspectHidden("**增量编译，不要 `make dirclean`**");
    expect(case1.visible).toBe("增量编译，不要 make dirclean");
    expect(case1.marks.some((m) => m.cls.includes("cm-md-bold"))).toBe(true);
    expect(case1.marks.some((m) => m.cls.includes("cm-md-inline-code"))).toBe(true);

    // Bold + italic nesting in all forms
    expect(inspectHidden("***粗斜体***").visible).toBe("粗斜体");
    expect(inspectHidden("**加粗 *斜体***").visible).toBe("加粗 斜体");
    expect(inspectHidden("***斜体* 加粗**").visible).toBe("斜体 加粗");
    expect(inspectHidden("**加粗 *斜体* 文字**").visible).toBe("加粗 斜体 文字");

    // Highlight / strike / underline wrapping bold & code
    const case2 = inspectHidden("==高亮 **粗体** 和 `code`==");
    expect(case2.visible).toBe("高亮 粗体 和 code");
    expect(case2.marks.some((m) => m.cls.includes("cm-md-highlight"))).toBe(true);
    expect(case2.marks.some((m) => m.cls.includes("cm-md-bold"))).toBe(true);
    expect(case2.marks.some((m) => m.cls.includes("cm-md-inline-code"))).toBe(true);

    // Links nested inside bold AND bold/code nested inside link label (with `_`/`*` in URL protected)
    expect(inspectHidden("**查看 [文档](https://a.com/x_y*z*) 详情**").visible).toBe("查看 文档 详情");
    expect(inspectHidden("[**粗体链接** 与 `cmd`](https://a.com)").visible).toBe("粗体链接 与 cmd");

    // HTML + Markdown bidirectional nesting
    expect(inspectHidden("**粗体 <u>下划线</u>**").visible).toBe("粗体 下划线");
    expect(inspectHidden("<u>下划线 **粗体**</u>").visible).toBe("下划线 粗体");

    // Negative guards: inline code stays opaque, snake_case & spaced multiplication untouched
    expect(inspectHidden("`**not bold**`").visible).toBe("**not bold**");
    expect(inspectHidden("make_clean_all").visible).toBe("make_clean_all");
    expect(inspectHidden("2 * 3 * 4").visible).toBe("2 * 3 * 4");
  });

  it("highlights fenced code blocks with real language-specific Lezer parsers", async () => {
    expect(resolveCodeLanguageDescription("bash")?.name).toBe("Shell");
    expect(resolveCodeLanguageDescription("py")?.name).toBe("Python");
    expect(resolveCodeLanguageDescription("makefile")?.name).toBe("Makefile");
    expect(resolveCodeLanguageDescription("plaintext")).toBeNull();

    // Plaintext must NOT receive spurious JS/Rust keyword highlighting
    const plain = highlightCodeBlock("select from default where true", "text");
    expect(plain.pending).toBeUndefined();
    expect(plain.lines[0]).not.toContain("tok-keyword");

    // Makefile highlights synchronously (bundled StreamLanguage)
    const mk = highlightCodeBlock("# build rule\nTARGET := app\nall:\n\tmake -j8 $(TARGET)", "makefile");
    expect(mk.lines[0]).toContain("tok-comment");
    expect(mk.lines[1]).toContain("tok-var");
    expect(mk.lines[3]).toContain("tok-var");

    // Async Lezer languages: JSON & Shell
    const jsonLang = await loadCodeLanguage("json");
    expect(jsonLang).not.toBeNull();
    const jsonLines = renderHighlightedLines('{"select": "from", "count": 42, "ok": true}', jsonLang!);
    expect(jsonLines[0]).toContain("tok-attr");
    expect(jsonLines[0]).toContain("tok-number");
    expect(jsonLines[0]).toContain("tok-bool");
    expect(jsonLines[0]).not.toContain("tok-keyword");

    const bashLang = await loadCodeLanguage("bash");
    expect(bashLang).not.toBeNull();
    const bashLines = renderHighlightedLines('# build script\nif [ -f "$FILE" ]; then\n  echo "ok"\nfi', bashLang!);
    expect(bashLines[0]).toContain("tok-comment");
    expect(bashLines[1]).toContain("tok-keyword");
    expect(bashLines[2]).toContain("tok-string");
  });

  it("supports per-workspace, per-folder, and manual sibling sorting with rename migration", () => {
    setActivePinia(createPinia());
    const wsStore = useWorkspaceStore();
    wsStore.sortOrder = "name-asc";
    wsStore.workspaces = [
      {
        id: "ws-a",
        name: "VaultA",
        rootPath: "D:\\VaultA",
        collapsed: false,
        tree: {
          name: "VaultA",
          path: "D:\\VaultA",
          workspaceId: "ws-a",
          kind: "folder",
          extension: "",
          sizeBytes: 0,
          mtimeMs: 0,
          children: [
            {
              name: "Sub",
              path: "D:\\VaultA\\Sub",
              workspaceId: "ws-a",
              kind: "folder",
              extension: "",
              sizeBytes: 0,
              mtimeMs: 100,
              children: [
                { name: "a.md", path: "D:\\VaultA\\Sub\\a.md", workspaceId: "ws-a", kind: "markdown", extension: "md", sizeBytes: 10, mtimeMs: 100 },
                { name: "b.md", path: "D:\\VaultA\\Sub\\b.md", workspaceId: "ws-a", kind: "markdown", extension: "md", sizeBytes: 10, mtimeMs: 300 },
                { name: "c.md", path: "D:\\VaultA\\Sub\\c.md", workspaceId: "ws-a", kind: "markdown", extension: "md", sizeBytes: 10, mtimeMs: 200 },
              ],
            },
            { name: "alpha.md", path: "D:\\VaultA\\alpha.md", workspaceId: "ws-a", kind: "markdown", extension: "md", sizeBytes: 10, mtimeMs: 100 },
            { name: "zeta.md", path: "D:\\VaultA\\zeta.md", workspaceId: "ws-a", kind: "markdown", extension: "md", sizeBytes: 10, mtimeMs: 500 },
          ],
        },
      },
    ];

    // 1) Set workspace-level sort to mtime-desc
    wsStore.setWorkspaceSortOrder("ws-a", "mtime-desc");
    let rootChildren = wsStore.displayWorkspaces[0].tree!.children!;
    expect(rootChildren.map((c) => c.name)).toEqual(["Sub", "zeta.md", "alpha.md"]);
    // Sub inherits workspace mtime-desc -> b(300), c(200), a(100)
    expect(rootChildren[0].children!.map((c) => c.name)).toEqual(["b.md", "c.md", "a.md"]);

    // 2) Override Sub folder sort to name-desc independently
    wsStore.setFolderSortOrder("D:\\VaultA\\Sub", "name-desc", "ws-a");
    rootChildren = wsStore.displayWorkspaces[0].tree!.children!;
    expect(rootChildren[0].children!.map((c) => c.name)).toEqual(["c.md", "b.md", "a.md"]);

    // 3) Drag/reorder a.md before c.md -> automatically switches Sub to manual sort
    expect(wsStore.reorderSiblingNode("D:\\VaultA\\Sub\\a.md", "D:\\VaultA\\Sub\\c.md", "before")).toBe(true);
    expect(wsStore.getFolderExplicitSort("D:\\VaultA\\Sub")).toBe("manual");
    rootChildren = wsStore.displayWorkspaces[0].tree!.children!;
    expect(rootChildren[0].children!.map((c) => c.name)).toEqual(["a.md", "c.md", "b.md"]);

    // 4) Rename folder Sub -> Docs preserves folderSortOrders & manualOrders
    wsStore.handlePathRenamed("D:\\VaultA\\Sub", "D:\\VaultA\\Docs");
    expect(wsStore.getFolderExplicitSort("D:\\VaultA\\Docs")).toBe("manual");
    expect(wsStore.getFolderExplicitSort("D:\\VaultA\\Sub")).toBeUndefined();
  });

  it("validates wikilinks and safely rewrites wikilinks and relative links outside code blocks", () => {
    expect(parseWikilinkTarget("设计文档#接口|别名")).toEqual({
      raw: "设计文档#接口|别名",
      filePart: "设计文档",
      anchor: "接口",
      alias: "别名",
    });

    const files = [
      { name: "设计文档.md", path: "D:\\Vault\\设计文档.md" },
      { name: "子目录笔记.md", path: "D:\\Vault\\docs\\子目录笔记.md" },
    ];
    expect(isWikilinkTargetValid("设计文档", "", files)).toBe(true);
    expect(isWikilinkTargetValid("设计文档#章节|查看", "", files)).toBe(true);
    expect(isWikilinkTargetValid("docs/子目录笔记", "", files)).toBe(true);
    expect(isWikilinkTargetValid("已删除笔记", "", files)).toBe(false);
    expect(isWikilinkTargetValid("#本地标题", "## 本地标题\n正文", files)).toBe(true);
    expect(isWikilinkTargetValid("#不存在标题", "## 本地标题\n正文", files)).toBe(false);

    const sample = [
      "参见 [[旧笔记]] 和 [[旧笔记#安装|安装指南]]。",
      "标准链接：[打开](./旧笔记.md#sec) 与 `[[旧笔记]]`。",
      "```markdown",
      "[[旧笔记]]",
      "[示例](./旧笔记.md)",
      "```",
    ].join("\n");

    const res = rewriteLinksInMarkdown(sample, {
      notePath: "D:\\Vault\\索引.md",
      oldPath: "D:\\Vault\\旧笔记.md",
      newPath: "D:\\Vault\\新笔记.md",
    });

    expect(res.count).toBe(3);
    expect(res.updated).toContain("参见 [[新笔记]] 和 [[新笔记#安装|安装指南]]。");
    expect(res.updated).toContain("标准链接：[打开](./新笔记.md#sec) 与 `[[旧笔记]]`。");
    expect(res.updated).toContain("```markdown\n[[旧笔记]]\n[示例](./旧笔记.md)\n```");
  });
});
