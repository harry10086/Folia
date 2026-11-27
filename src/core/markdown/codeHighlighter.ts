import {
  Language,
  LanguageDescription,
  LanguageSupport,
  StreamLanguage,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightCode, tagHighlighter, tags } from "@lezer/highlight";

export function escapeCodeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Lightweight Makefile / Kbuild StreamLanguage parser so `makefile`, `make`, `mk`
 * fences get accurate highlighting alongside @codemirror/language-data.
 */
const makefileStreamParser = StreamLanguage.define<{ inString: string | null }>({
  startState: () => ({ inString: null }),
  token(stream, state) {
    if (state.inString) {
      while (!stream.eol()) {
        const ch = stream.next();
        if (ch === "\\") {
          stream.next();
        } else if (ch === state.inString) {
          state.inString = null;
          break;
        }
      }
      return "string";
    }

    if (stream.sol()) {
      // Tab-indented recipe line: highlight variables, strings, comments, commands
      if (stream.eat("\t")) return null;

      // Comments
      if (stream.match(/^\s*#.*/)) return "comment";

      // Conditional / include / export directives
      if (
        stream.match(
          /^\s*(?:ifeq|ifneq|ifdef|ifndef|else|endif|include|-include|sinclude|define|endef|export|unexport|override|private|undefine|vpath)\b/
        )
      ) {
        return "keyword";
      }

      // Special targets like .PHONY, .DEFAULT_GOAL
      if (stream.match(/^\.[A-Z_]+(?=\s*:)/)) return "meta";

      // Variable assignment at start of line: VAR := ...
      if (stream.match(/^[A-Za-z_][A-Za-z0-9_.-]*(?=\s*(?:::=|:=|\?=|\+=|!=|=))/)) {
        return "variableName.definition";
      }

      // Target rule: target: deps
      if (stream.match(/^[A-Za-z0-9_./%$-]+(?=\s*:(?!=))/)) {
        return "labelName";
      }
    }

    if (stream.eatSpace()) return null;

    if (stream.peek() === "#") {
      stream.skipToEnd();
      return "comment";
    }

    // Make variables $(VAR), ${VAR}, $@, $<, $^, $*, $?
    if (stream.match(/\$(?:\([^)]+\)|\{[^}]+\}|[@<^*?+%$])/)) {
      return "variableName.special";
    }

    // Quoted strings
    const ch = stream.peek();
    if (ch === '"' || ch === "'") {
      stream.next();
      state.inString = ch;
      while (!stream.eol()) {
        const c = stream.next();
        if (c === "\\") {
          stream.next();
        } else if (c === ch) {
          state.inString = null;
          break;
        }
      }
      return "string";
    }

    // Assignment and rule operators
    if (stream.match(/::=|:=|\?=|\+=|!=|[=:;|]/)) {
      return "operator";
    }

    // Common shell/make control keywords inside recipes
    if (
      stream.match(
        /\b(?:if|then|else|elif|fi|for|in|do|done|while|case|esac|export|echo|cd|rm|cp|mv|mkdir|make|sudo|exit|true|false)\b/
      )
    ) {
      return "keyword";
    }

    // Flags like -j8, --jobs=4
    if (stream.match(/--?[A-Za-z][A-Za-z0-9_-]*/)) {
      return "attributeName";
    }

    // Numbers
    if (stream.match(/\b(?:0x[0-9a-fA-F]+|\d+)\b/)) {
      return "number";
    }

    stream.next();
    return null;
  },
});

const makefileLangDesc = LanguageDescription.of({
  name: "Makefile",
  alias: ["make", "makefile", "mk", "gnumake", "kbuild"],
  extensions: ["mk", "mak"],
  support: new LanguageSupport(makefileStreamParser),
});

const ALL_CODE_LANGUAGES: readonly LanguageDescription[] = [makefileLangDesc, ...languages];

const PLAIN_TEXT_LANGS = new Set([
  "",
  "text",
  "txt",
  "plain",
  "plaintext",
  "none",
  "nohighlight",
  "raw",
  "ascii",
  "output",
  "log",
]);

const LANG_ALIAS_MAP: Record<string, string> = {
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ksh: "shell",
  shell: "shell",
  shellscript: "shell",
  console: "shell",
  terminal: "shell",
  py: "python",
  py3: "python",
  python3: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  rs: "rust",
  "c++": "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  hh: "cpp",
  "h++": "cpp",
  h: "c",
  cs: "csharp",
  "c#": "csharp",
  yml: "yaml",
  jsonc: "json",
  json5: "json",
  jsonl: "json",
  htm: "html",
  svg: "xml",
  plist: "xml",
  xaml: "xml",
  csproj: "xml",
  md: "markdown",
  mkd: "markdown",
  rb: "ruby",
  ps1: "powershell",
  pwsh: "powershell",
  posh: "powershell",
  conf: "ini",
  cfg: "ini",
  config: "ini",
  env: "ini",
  dotenv: "ini",
  ini: "ini",
  properties: "ini",
  docker: "dockerfile",
  dockerfile: "dockerfile",
  make: "makefile",
  makefile: "makefile",
  mk: "makefile",
  gnumake: "makefile",
  kbuild: "makefile",
  patch: "diff",
  asm: "gas",
  s: "gas",
  kt: "kotlin",
  kts: "kotlin",
  golang: "go",
  objc: "objective-c",
  objectivec: "objective-c",
  tex: "latex",
  postgres: "postgresql",
  pgsql: "postgresql",
  tsql: "ms sql",
  mssql: "ms sql",
  mariadb: "mariadb sql",
};

/**
 * Extract and normalize the language identifier from a fenced code info string
 * (e.g. `bash title="build.sh"` -> `shell`, `C++` -> `cpp`).
 */
export function normalizeFenceLang(rawLang: string): string {
  const firstToken = rawLang.trim().split(/[\s{,]/)[0]?.toLowerCase() ?? "";
  if (PLAIN_TEXT_LANGS.has(firstToken)) return "";
  return LANG_ALIAS_MAP[firstToken] ?? firstToken;
}

/**
 * Resolve a fenced code language name to a CodeMirror LanguageDescription.
 */
export function resolveCodeLanguageDescription(rawLang: string): LanguageDescription | null {
  const norm = normalizeFenceLang(rawLang);
  if (!norm) return null;

  const exact = LanguageDescription.matchLanguageName(ALL_CODE_LANGUAGES, norm, false);
  if (exact) return exact;

  const byExt = ALL_CODE_LANGUAGES.find((l) =>
    l.extensions.some((ext) => ext.toLowerCase() === norm)
  );
  if (byExt) return byExt;

  return LanguageDescription.matchLanguageName(ALL_CODE_LANGUAGES, norm, true);
}

/**
 * Callback compatible with `@codemirror/lang-markdown`'s `codeLanguages` option
 * so active-edit & source-mode fences share the exact same alias resolution.
 */
export function resolveCodeLanguageForMarkdown(info: string): Language | LanguageDescription | null {
  const desc = resolveCodeLanguageDescription(info);
  if (!desc) return null;
  if (desc.support) return desc.support.language;
  return desc;
}

export const foliaCodeHighlighter = tagHighlighter([
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
    class: "tok-comment",
  },
  {
    tag: [
      tags.keyword,
      tags.controlKeyword,
      tags.definitionKeyword,
      tags.moduleKeyword,
      tags.modifier,
      tags.operatorKeyword,
      tags.self,
    ],
    class: "tok-keyword",
  },
  {
    tag: [tags.bool, tags.null, tags.atom],
    class: "tok-bool",
  },
  {
    tag: [tags.number, tags.integer, tags.float, tags.unit],
    class: "tok-number",
  },
  {
    tag: [
      tags.string,
      tags.docString,
      tags.character,
      tags.attributeValue,
      tags.special(tags.string),
    ],
    class: "tok-string",
  },
  {
    tag: [tags.regexp, tags.escape],
    class: "tok-regexp",
  },
  {
    tag: [
      tags.function(tags.variableName),
      tags.function(tags.propertyName),
      tags.definition(tags.function(tags.variableName)),
      tags.labelName,
    ],
    class: "tok-func",
  },
  {
    tag: [
      tags.macroName,
      tags.meta,
      tags.processingInstruction,
      tags.annotation,
      tags.documentMeta,
    ],
    class: "tok-macro",
  },
  {
    tag: [tags.typeName, tags.className, tags.namespace, tags.standard(tags.typeName)],
    class: "tok-type",
  },
  {
    tag: [tags.tagName],
    class: "tok-tag",
  },
  {
    tag: [tags.attributeName, tags.propertyName, tags.definition(tags.propertyName)],
    class: "tok-attr",
  },
  {
    tag: [
      tags.special(tags.variableName),
      tags.constant(tags.variableName),
      tags.definition(tags.variableName),
    ],
    class: "tok-var",
  },
  {
    tag: [
      tags.operator,
      tags.compareOperator,
      tags.arithmeticOperator,
      tags.logicOperator,
      tags.bitwiseOperator,
      tags.updateOperator,
      tags.definitionOperator,
    ],
    class: "tok-operator",
  },
  {
    tag: [
      tags.punctuation,
      tags.bracket,
      tags.angleBracket,
      tags.squareBracket,
      tags.paren,
      tags.brace,
      tags.separator,
    ],
    class: "tok-punct",
  },
  {
    tag: [tags.inserted],
    class: "tok-inserted",
  },
  {
    tag: [tags.deleted],
    class: "tok-deleted",
  },
  {
    tag: [tags.heading],
    class: "tok-keyword",
  },
  {
    tag: [tags.link, tags.url],
    class: "tok-string",
  },
]);

const loadedLangCache = new Map<string, LanguageSupport | null>();
const inflightLangLoads = new Map<string, Promise<LanguageSupport | null>>();

export function getCachedCodeLanguage(rawLang: string): LanguageSupport | null | undefined {
  const desc = resolveCodeLanguageDescription(rawLang);
  if (!desc) return null;
  if (desc.support) {
    loadedLangCache.set(desc.name, desc.support);
    return desc.support;
  }
  return loadedLangCache.get(desc.name);
}

export async function loadCodeLanguage(rawLang: string): Promise<LanguageSupport | null> {
  const desc = resolveCodeLanguageDescription(rawLang);
  if (!desc) return null;
  if (desc.support) {
    loadedLangCache.set(desc.name, desc.support);
    return desc.support;
  }
  if (loadedLangCache.has(desc.name)) {
    return loadedLangCache.get(desc.name) ?? null;
  }
  let inflight = inflightLangLoads.get(desc.name);
  if (!inflight) {
    inflight = desc
      .load()
      .then((support) => {
        loadedLangCache.set(desc.name, support);
        inflightLangLoads.delete(desc.name);
        return support;
      })
      .catch(() => {
        loadedLangCache.set(desc.name, null);
        inflightLangLoads.delete(desc.name);
        return null;
      });
    inflightLangLoads.set(desc.name, inflight);
  }
  return inflight;
}

function renderPlainLines(normalizedCode: string): string[] {
  return normalizedCode.split("\n").map((line) => (line ? escapeCodeHtml(line) : " "));
}

export function renderHighlightedLines(code: string, support: LanguageSupport): string[] {
  const normalized = code.replace(/\r\n?/g, "\n");
  const tree = support.language.parser.parse(normalized);
  const lines: string[] = [];
  let current = "";

  highlightCode(
    normalized,
    tree,
    foliaCodeHighlighter,
    (text, classes) => {
      if (!text) return;
      const esc = escapeCodeHtml(text);
      current += classes ? `<span class="${classes}">${esc}</span>` : esc;
    },
    () => {
      lines.push(current || " ");
      current = "";
    }
  );
  lines.push(current || " ");
  return lines;
}

export interface HighlightCodeResult {
  lines: string[];
  pending?: Promise<string[]>;
}

/**
 * Highlights a fenced code block using real CodeMirror/Lezer language parsers.
 * Returns highlighted HTML lines synchronously when the parser is already cached;
 * otherwise returns clean escaped plain lines immediately plus a `pending` promise
 * that resolves once the language grammar chunk finishes loading.
 */
export function highlightCodeBlock(code: string, rawLang: string): HighlightCodeResult {
  const normalized = code.replace(/\r\n?/g, "\n");
  const cached = getCachedCodeLanguage(rawLang);
  if (cached) {
    return { lines: renderHighlightedLines(normalized, cached) };
  }
  const plain = renderPlainLines(normalized);
  if (cached === null) {
    return { lines: plain };
  }
  const pending = loadCodeLanguage(rawLang).then((support) =>
    support ? renderHighlightedLines(normalized, support) : plain
  );
  return { lines: plain, pending };
}
