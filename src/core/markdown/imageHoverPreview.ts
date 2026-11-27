import { hoverTooltip, type EditorView, type Tooltip } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { resolveImageSrc } from "./livePreview";

interface DetectedImageLink {
  from: number;
  to: number;
  rawSrc: string;
  alt: string;
}

const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp|ico|avif)(?:[?#][^\s'"<>)]*)?$/i;

function detectImageAtPos(lineFrom: number, text: string, pos: number): DetectedImageLink | null {
  const offset = pos - lineFrom;

  // 1) Markdown image: ![alt](src)
  const mdImgRe = /!\[([^\]]*)\]\(([^)\n]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdImgRe.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (offset >= start && offset <= end) {
      const rawSrc = m[2].trim().replace(/\s+"[^"]*"$/, "").replace(/^<|>$/g, "");
      return { from: lineFrom + start, to: lineFrom + end, rawSrc, alt: m[1].trim() };
    }
  }

  // 2) Obsidian wiki image: ![[file.png|alt]]
  const wikiImgRe = /!\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g;
  while ((m = wikiImgRe.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (offset >= start && offset <= end) {
      const rawSrc = m[1].trim();
      return { from: lineFrom + start, to: lineFrom + end, rawSrc, alt: (m[2] ?? rawSrc).trim() };
    }
  }

  // 3) HTML <img src="..." alt="...">
  const htmlImgRe = /<img\s+[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*\/?>/gi;
  while ((m = htmlImgRe.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (offset >= start && offset <= end) {
      const altM = /\balt\s*=\s*["']([^"']*)["']/i.exec(m[0]);
      return { from: lineFrom + start, to: lineFrom + end, rawSrc: m[1].trim(), alt: altM?.[1] ?? "" };
    }
  }

  // 4) Direct image URLs (e.g. YAML frontmatter `cover: 'https://.../pic.webp'` or plain links)
  const urlRe = /https?:\/\/[^\s'"<>)\]]+/gi;
  while ((m = urlRe.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (offset >= start && offset <= end && IMAGE_EXT_RE.test(m[0])) {
      return { from: lineFrom + start, to: lineFrom + end, rawSrc: m[0], alt: "" };
    }
  }

  return null;
}

export function createImageHoverPreviewExtension(
  getNotePath: () => string | null,
  getEditMode: () => "live" | "source"
): Extension {
  return hoverTooltip(
    (view: EditorView, pos: number): Tooltip | null => {
      const line = view.state.doc.lineAt(pos);
      const found = detectImageAtPos(line.from, line.text, pos);
      if (!found || !found.rawSrc) return null;

      // In Live Preview mode, standard markdown images are already rendered inline as widgets;
      // still allow hover preview on source mode, active editing lines, and frontmatter/URL links!
      const isSource = getEditMode() === "source";
      const isDirectUrl = /^https?:\/\//i.test(found.rawSrc) && !line.text.includes("![");
      if (!isSource && !isDirectUrl) {
        const sel = view.state.selection.main;
        const onActiveLine = sel.from <= line.to && sel.to >= line.from;
        if (!onActiveLine) return null;
      }

      const resolvedSrc = resolveImageSrc(found.rawSrc, getNotePath());
      const label = found.alt || found.rawSrc.split(/[\\/]/).pop() || found.rawSrc;

      return {
        pos: found.from,
        end: found.to,
        above: true,
        create() {
          const dom = document.createElement("div");
          dom.className = "folia-img-hover-card";

          const imgWrap = document.createElement("div");
          imgWrap.className = "folia-img-hover-stage";

          const status = document.createElement("div");
          status.className = "folia-img-hover-status";
          status.textContent = "加载预览中...";
          imgWrap.appendChild(status);

          const img = document.createElement("img");
          img.className = "folia-img-hover-img";
          img.alt = label;
          img.src = resolvedSrc;

          const meta = document.createElement("div");
          meta.className = "folia-img-hover-meta";
          const nameSpan = document.createElement("span");
          nameSpan.className = "folia-img-hover-name";
          nameSpan.textContent = label;
          const dimSpan = document.createElement("span");
          dimSpan.className = "folia-img-hover-dim";
          meta.appendChild(nameSpan);
          meta.appendChild(dimSpan);

          img.addEventListener("load", () => {
            status.remove();
            img.classList.add("is-loaded");
            if (img.naturalWidth > 0) {
              dimSpan.textContent = `${img.naturalWidth} × ${img.naturalHeight}`;
            }
          });

          img.addEventListener("error", () => {
            img.remove();
            status.classList.add("is-error");
            status.textContent = "无法加载图片预览";
          });

          imgWrap.appendChild(img);
          dom.appendChild(imgWrap);
          dom.appendChild(meta);

          return { dom };
        },
      };
    },
    { hoverTime: 260 }
  );
}
