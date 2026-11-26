import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { FileNode } from "@/core/ipc/client";

export interface LinkCompletionContextProvider {
  getCurrentNotePath: () => string | null;
  getWorkspaceFiles: () => FileNode[];
  getLinkFormat: () => "markdown" | "wikilink";
}

const SLASH_SNIPPETS: Completion[] = [
  { label: "/h1", displayLabel: "/h1 一级标题", detail: "# 标题", apply: "# " },
  { label: "/h2", displayLabel: "/h2 二级标题", detail: "## 标题", apply: "## " },
  { label: "/h3", displayLabel: "/h3 三级标题", detail: "### 标题", apply: "### " },
  { label: "/todo", displayLabel: "/todo 待办事项", detail: "- [ ] 任务", apply: "- [ ] " },
  { label: "/list", displayLabel: "/list 无序列表", detail: "- 列表项", apply: "- " },
  { label: "/quote", displayLabel: "/quote 引用块", detail: "> 引用", apply: "> " },
  { label: "/code", displayLabel: "/code 代码块", detail: "```lang", apply: "```ts\n\n```" },
  {
    label: "/table",
    displayLabel: "/table 表格",
    detail: "2x2 表格",
    apply: "| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |\n",
  },
  {
    label: "/tip",
    displayLabel: "/tip 提示块 [!TIP]",
    detail: "GitHub Alert",
    apply: "> [!TIP] 提示\n> 在这里输入提示内容\n",
  },
  {
    label: "/warning",
    displayLabel: "/warning 警告块 [!WARNING]",
    detail: "GitHub Alert",
    apply: "> [!WARNING] 注意\n> 在这里输入警告内容\n",
  },
  {
    label: "/note",
    displayLabel: "/note 说明块 [!NOTE]",
    detail: "GitHub Alert",
    apply: "> [!NOTE] 说明\n> 在这里输入说明内容\n",
  },
  {
    label: "/math",
    displayLabel: "/math LaTeX 公式块",
    detail: "$$ ... $$",
    apply: "$$\nE = mc^2\n$$\n",
  },
  {
    label: "/mermaid",
    displayLabel: "/mermaid Mermaid 图表",
    detail: "flowchart TD",
    apply: "```mermaid\nflowchart TD\n  A[开始] --> B[结束]\n```\n",
  },
  { label: "/hr", displayLabel: "/hr 分割线", detail: "---", apply: "\n---\n" },
  {
    label: "/frontmatter",
    displayLabel: "/frontmatter YAML 元数据",
    detail: "---",
    apply: "---\ntitle: \ndescription: \n---\n",
  },
];

function computeRelativePosixJs(fromFile: string, toFile: string): string {
  const normFrom = fromFile.replace(/\\/g, "/");
  const normTo = toFile.replace(/\\/g, "/");
  const fromParts = normFrom.split("/");
  fromParts.pop();
  const toParts = normTo.split("/");

  if (
    fromParts[0] &&
    toParts[0] &&
    /^[A-Za-z]:$/.test(fromParts[0]) &&
    fromParts[0].toLowerCase() !== toParts[0].toLowerCase()
  ) {
    return normTo;
  }

  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common].toLowerCase() === toParts[common].toLowerCase()
  ) {
    common++;
  }

  const up = Array(Math.max(0, fromParts.length - common)).fill("..");
  const down = toParts.slice(common);
  const rel = [...up, ...down].join("/");
  return rel.includes(" ") ? `<${rel}>` : rel;
}

export function createMarkdownCompletionSource(provider: LinkCompletionContextProvider) {
  return (context: CompletionContext): CompletionResult | null => {
    const slashMatch = context.matchBefore(/(?:^|\s)\/[a-zA-Z0-9]*$/);
    if (slashMatch) {
      const slashIdx = slashMatch.text.lastIndexOf("/");
      const from = slashMatch.from + slashIdx;
      return {
        from,
        options: SLASH_SNIPPETS,
        validFor: /^\/[a-zA-Z0-9]*$/,
      };
    }

    const wikiMatch = context.matchBefore(/\[\[[^\]]*$/);

    if (wikiMatch) {
      const from = wikiMatch.from;
      const query = wikiMatch.text.slice(2).trim().toLowerCase();

      const currentNote = provider.getCurrentNotePath();
      const linkFormat = provider.getLinkFormat();
      const files = provider
        .getWorkspaceFiles()
        .filter((f) => f.kind === "markdown" || f.kind === "image" || f.kind === "pdf");

      const options: Completion[] = files
        .filter(
          (f) =>
            !query ||
            f.name.toLowerCase().includes(query) ||
            f.path.toLowerCase().includes(query)
        )
        .slice(0, 40)
        .map((f) => {
          const stem = f.name.replace(/\.[^.]+$/, "");
          const rel = currentNote ? computeRelativePosixJs(currentNote, f.path) : f.name;
          const isImage = f.kind === "image";

          let insertText: string;
          if (isImage) {
            insertText = `![${stem}](${rel})`;
          } else if (linkFormat === "wikilink") {
            insertText = `[[${f.name}]]`;
          } else {
            insertText = `[${stem}](${rel})`;
          }

          return {
            label: f.name,
            detail: rel,
            type: f.kind === "markdown" ? "text" : "variable",
            apply: insertText,
          };
        });

      return {
        from,
        options,
        filter: false,
      };
    }

    return null;
  };
}
