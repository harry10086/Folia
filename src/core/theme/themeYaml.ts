import { DARK_THEMES, LIGHT_THEMES, type ThemePalette } from "./themes";

const COLOR_KEYS: Array<keyof Omit<ThemePalette, "id" | "name" | "mode" | "swatches" | "accentSoft">> = [
  "bgBase",
  "bgSurface",
  "bgSidebar",
  "bgElevated",
  "bgHover",
  "bgActive",
  "border",
  "textPrimary",
  "textSecondary",
  "textMuted",
  "accent",
  "heading",
  "bold",
  "code",
  "codeBg",
  "link",
  "quoteBar",
  "markBg",
  "danger",
];

const COLOR_KEY_MAP = new Map<string, (typeof COLOR_KEYS)[number]>(
  COLOR_KEYS.map((k) => [k.toLowerCase(), k])
);

/**
 * Strip inline YAML comments (` # ...`) while preserving hex colors like `#1e293b`
 * and quoted values like `"#1e293b"`.
 */
function stripYamlComment(rawVal: string): string {
  const s = rawVal.trim();
  if (!s) return "";
  const quote = s[0];
  if (quote === '"' || quote === "'") {
    const closeIdx = s.indexOf(quote, 1);
    if (closeIdx > 0) return s.slice(1, closeIdx).trim();
    return s.slice(1).trim();
  }
  // Unquoted: only treat `#` as a comment if preceded by whitespace
  const commentMatch = /\s+#/.exec(s);
  return (commentMatch ? s.slice(0, commentMatch.index) : s).trim();
}

function isValidCssColor(val: string): boolean {
  const v = val.trim();
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v)) return true;
  if (/^(rgba?|hsla?)\([^)]+\)$/i.test(v)) return true;
  if (/^color-mix\([^)]+\)$/i.test(v)) return true;
  return false;
}

export function serializeThemeToYaml(theme: ThemePalette): string {
  const lines: string[] = [
    "# Folia 主题配色配置（可直接复制分享、粘贴编辑或导入导出）",
    `name: "${theme.name.replace(/"/g, '\\"')}"`,
    `mode: ${theme.mode} # light | dark`,
    "colors:",
  ];

  for (const key of COLOR_KEYS) {
    lines.push(`  ${key}: "${theme[key]}"`);
  }

  return `${lines.join("\n")}\n`;
}

export type ParseThemeYamlResult =
  | { ok: true; theme: ThemePalette }
  | { ok: false; error: string };

export function parseThemeYaml(yamlText: string, existingId?: string): ParseThemeYamlResult {
  const lines = yamlText.replace(/\r\n/g, "\n").split("\n");
  let name = "";
  let mode: "light" | "dark" | null = null;
  const parsedColors: Partial<Record<(typeof COLOR_KEYS)[number], string>> = {};
  let accentSoftOverride = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx <= 0) {
      return { ok: false, error: `第 ${i + 1} 行格式无效（需要 key: value）：${trimmed}` };
    }

    const rawKey = trimmed.slice(0, colonIdx).trim();
    const rawVal = trimmed.slice(colonIdx + 1).trim();
    const keyLower = rawKey.toLowerCase();

    if (keyLower === "colors" && rawVal === "") {
      continue;
    }

    const val = stripYamlComment(rawVal);

    if (keyLower === "name") {
      name = val;
      continue;
    }
    if (keyLower === "id") {
      continue;
    }
    if (keyLower === "mode") {
      const m = val.toLowerCase();
      if (m !== "light" && m !== "dark") {
        return { ok: false, error: `第 ${i + 1} 行 mode 必须为 light 或 dark（当前为 "${val}"）` };
      }
      mode = m;
      continue;
    }
    if (keyLower === "accentsoft") {
      if (val && !isValidCssColor(val)) {
        return { ok: false, error: `第 ${i + 1} 行 accentSoft 颜色格式无效："${val}"` };
      }
      accentSoftOverride = val;
      continue;
    }

    const matchedColorKey = COLOR_KEY_MAP.get(keyLower);
    if (matchedColorKey) {
      if (!val || !isValidCssColor(val)) {
        return {
          ok: false,
          error: `第 ${i + 1} 行 ${matchedColorKey} 颜色格式无效："${val}"（请使用 #RRGGBB 或 rgba(...)）`,
        };
      }
      parsedColors[matchedColorKey] = val;
    }
  }

  const resolvedMode: "light" | "dark" = mode ?? "light";
  const base = resolvedMode === "dark" ? DARK_THEMES[0] : LIGHT_THEMES[0];
  const resolvedName = name.trim() || "自定义主题";

  const merged: ThemePalette = {
    ...base,
    id: existingId || `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: resolvedName,
    mode: resolvedMode,
    ...parsedColors,
    accentSoft:
      accentSoftOverride ||
      (parsedColors.accent
        ? `color-mix(in srgb, ${parsedColors.accent} 16%, transparent)`
        : base.accentSoft),
    swatches: [
      parsedColors.bold || base.bold,
      parsedColors.accent || base.accent,
      parsedColors.heading || base.heading,
      parsedColors.textPrimary || base.textPrimary,
      parsedColors.bgSidebar || base.bgSidebar,
    ],
  };

  return { ok: true, theme: merged };
}
