import MarkdownIt from "markdown-it";
import footnotePlugin from "markdown-it-footnote";
import markPlugin from "markdown-it-mark";
import insPlugin from "markdown-it-ins";
import subPlugin from "markdown-it-sub";
import supPlugin from "markdown-it-sup";
import taskListsPlugin from "markdown-it-task-lists";
import { ipc } from "@/core/ipc/client";
import { resolveImageSrc } from "@/core/markdown/livePreview";

const EMOJI_MAP: Record<string, string> = {
  rocket: "🚀",
  sparkles: "✨",
  fire: "🔥",
  check: "✅",
  warning: "⚠️",
  bulb: "💡",
  memo: "📝",
  book: "📖",
  star: "⭐",
  heart: "❤️",
  tada: "🎉",
};

function stripFrontmatter(md: string): string {
  if (!md.startsWith("---\n") && !md.startsWith("---\r\n")) return md;
  const endIdx = md.indexOf("\n---", 3);
  if (endIdx === -1) return md;
  return md.slice(endIdx + 4).replace(/^\r?\n/, "");
}

function preprocessExtendedSyntax(md: string): string {
  let out = md.replace(/!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_m, target, alt) => {
    const cleanTarget = String(target).trim();
    const label = alt ? String(alt).trim() : cleanTarget;
    return `![${label}](${cleanTarget})`;
  });
  out = out.replace(/:([a-z0-9_+-]+):/g, (full, name) => EMOJI_MAP[name] ?? full);
  out = out.replace(
    /^> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(.*)\n((?:>.*\n?)*)/gim,
    (_all, kind: string, title: string, body: string) => {
      const cleanBody = body.replace(/^>[ \t]?/gm, "").trim();
      const heading = title.trim() || kind.toUpperCase();
      return `<div class="folia-export-callout is-${kind.toLowerCase()}"><div class="callout-title">${heading}</div><div class="callout-body">\n\n${cleanBody}\n\n</div></div>\n\n`;
    }
  );
  return out;
}

export async function renderMarkdownToHtmlFragment(
  rawMarkdown: string,
  notePath: string | null,
  embedLocalImagesAsBase64 = false
): Promise<string> {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: true })
    .use(footnotePlugin)
    .use(markPlugin)
    .use(insPlugin)
    .use(subPlugin)
    .use(supPlugin)
    .use(taskListsPlugin, { enabled: false, label: true });

  let source = preprocessExtendedSyntax(stripFrontmatter(rawMarkdown));

  if (source.includes("$")) {
    const katex = (await import("katex")).default;
    source = source.replace(/\$\$\s*\n([\s\S]+?)\n\s*\$\$/g, (_m, tex: string) => {
      return `<div class="katex-block">${katex.renderToString(tex.trim(), {
        displayMode: true,
        throwOnError: false,
      })}</div>`;
    });
    source = source.replace(/(?<!\$)\$([^$\n]+)\$(?!\$)/g, (_m, tex: string) => {
      return katex.renderToString(tex.trim(), { displayMode: false, throwOnError: false });
    });
  }

  let html = md.render(source);

  if (html.includes('class="language-mermaid"')) {
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" });
    const regex = /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g;
    const matches = [...html.matchAll(regex)];
    for (let i = 0; i < matches.length; i++) {
      const rawCode = matches[i][1]
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"');
      try {
        const { svg } = await mermaid.render(`export-mmd-${Date.now()}-${i}`, rawCode);
        html = html.replace(matches[i][0], `<div class="folia-export-mermaid">${svg}</div>`);
      } catch {
        // fallback
      }
    }
  }

  if (notePath) {
    const imgRe = /<img\s+([^>]*?)src="([^"]+)"([^>]*?)>/gi;
    const imgMatches = [...html.matchAll(imgRe)];
    for (const m of imgMatches) {
      const rawSrc = m[2];
      if (/^(https?:|data:|blob:)/i.test(rawSrc)) continue;
      if (embedLocalImagesAsBase64) {
        try {
          const abs = await ipc.resolveRelativePath(notePath, decodeURIComponent(rawSrc));
          const dataUri = await ipc.readBinaryBase64(abs);
          html = html.replace(m[0], `<img ${m[1]}src="${dataUri}"${m[3]}>`);
        } catch {
          // keep original
        }
      } else {
        const assetUrl = resolveImageSrc(rawSrc, notePath);
        html = html.replace(m[0], `<img ${m[1]}src="${assetUrl}"${m[3]}>`);
      }
    }
  }

  return html;
}

export async function buildStandaloneHtmlDocument(
  title: string,
  rawMarkdown: string,
  notePath: string | null,
  embedLocalImages = true
): Promise<string> {
  const bodyHtml = await renderMarkdownToHtmlFragment(rawMarkdown, notePath, embedLocalImages);
  const styles = getComputedStyle(document.documentElement);
  const bg = styles.getPropertyValue("--bg-surface").trim() || "#ffffff";
  const fg = styles.getPropertyValue("--text-primary").trim() || "#1e293b";
  const heading = styles.getPropertyValue("--md-heading").trim() || "#1e3a5f";
  const accent = styles.getPropertyValue("--accent").trim() || "#2563eb";
  const codeBg = styles.getPropertyValue("--md-code-bg").trim() || "#f1f5f9";
  const border = styles.getPropertyValue("--border-color").trim() || "#e2e8f0";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title.replace(/</g, "&lt;")}</title>
<style>
  body { margin: 0; padding: 40px 24px; background: ${bg}; color: ${fg}; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif; line-height: 1.75; }
  main { max-width: 820px; margin: 0 auto; }
  h1, h2, h3, h4 { color: ${heading}; margin-top: 1.6em; margin-bottom: 0.6em; }
  a { color: ${accent}; text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { background: ${codeBg}; padding: 2px 6px; border-radius: 4px; font-family: Consolas, Menlo, monospace; font-size: 0.9em; }
  pre { background: ${codeBg}; padding: 14px 16px; border-radius: 8px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 4px solid ${accent}; margin: 1em 0; padding: 6px 16px; opacity: 0.9; }
  table { border-collapse: collapse; width: 100%; margin: 1.2em 0; }
  th, td { border: 1px solid ${border}; padding: 8px 12px; text-align: left; }
  th { background: ${codeBg}; }
  img { max-width: 100%; height: auto; border-radius: 6px; }
  mark { background: #fef08a; padding: 0 3px; border-radius: 3px; }
  .folia-export-callout { border-left: 4px solid ${accent}; background: ${codeBg}; padding: 10px 14px; border-radius: 6px; margin: 1em 0; }
  .folia-export-callout .callout-title { font-weight: 600; margin-bottom: 4px; }
  .folia-export-mermaid { text-align: center; margin: 1.2em 0; }
</style>
</head>
<body><main>${bodyHtml}</main></body>
</html>`;
}

export async function printMarkdownToPdf(
  title: string,
  rawMarkdown: string,
  notePath: string | null
): Promise<void> {
  const fragment = await renderMarkdownToHtmlFragment(rawMarkdown, notePath, false);
  let printHost = document.getElementById("folia-print-host");
  if (!printHost) {
    printHost = document.createElement("div");
    printHost.id = "folia-print-host";
    document.body.appendChild(printHost);
  }
  printHost.innerHTML = `<article class="folia-print-article"><h1>${title.replace(/</g, "&lt;")}</h1>${fragment}</article>`;

  // Wait for all images inside the print host to finish decoding before triggering print dialog
  const imgs = Array.from(printHost.querySelectorAll("img"));
  if (imgs.length > 0) {
    await Promise.all(
      imgs.map(
        (img) =>
          img.complete
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                const done = () => resolve();
                img.addEventListener("load", done, { once: true });
                img.addEventListener("error", done, { once: true });
                setTimeout(done, 2000);
              })
      )
    );
  }

  await new Promise((r) => setTimeout(r, 80));
  window.print();
}
