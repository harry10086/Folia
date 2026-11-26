import { describe, it, expect } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { Decoration } from "@codemirror/view";
import { extractOutline, slugifyHeading } from "@/core/markdown/outline";
import { assembleSafeDecorationSet, resolveImageSrc } from "@/core/markdown/livePreview";
import { compareSemver } from "@/core/update/updater";
import { LIGHT_THEMES, DARK_THEMES, findThemeById } from "@/core/theme/themes";
import { parseThemeYaml, serializeThemeToYaml } from "@/core/theme/themeYaml";
import { useTabsStore } from "@/stores/tabs";

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
});
