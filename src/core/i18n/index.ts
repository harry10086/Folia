import { computed, ref } from "vue";
import { zhCN, type Messages } from "./zh-CN";
import { zhTW } from "./zh-TW";
import { enUS } from "./en-US";
import { jaJP } from "./ja-JP";

export type ResolvedLocale = "zh-CN" | "zh-TW" | "en-US" | "ja-JP";
export type LocalePreference = "auto" | ResolvedLocale;

export const LOCALE_OPTIONS: Array<{ value: LocalePreference; nativeLabel: string }> = [
  { value: "auto", nativeLabel: "Auto" },
  { value: "zh-CN", nativeLabel: "简体中文" },
  { value: "zh-TW", nativeLabel: "繁體中文" },
  { value: "en-US", nativeLabel: "English" },
  { value: "ja-JP", nativeLabel: "日本語" },
];

const MESSAGES: Record<ResolvedLocale, Messages> = {
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  "en-US": enUS,
  "ja-JP": jaJP,
};

export function isValidLocalePreference(v: unknown): v is LocalePreference {
  return (
    v === "auto" || v === "zh-CN" || v === "zh-TW" || v === "en-US" || v === "ja-JP"
  );
}

export function detectSystemLocale(): ResolvedLocale {
  if (typeof navigator === "undefined") return "zh-CN";
  const raw = (navigator.language || (navigator.languages && navigator.languages[0]) || "zh-CN").toLowerCase();
  if (raw.startsWith("zh")) {
    if (
      raw.includes("tw") ||
      raw.includes("hk") ||
      raw.includes("mo") ||
      raw.includes("hant")
    ) {
      return "zh-TW";
    }
    return "zh-CN";
  }
  if (raw.startsWith("ja")) return "ja-JP";
  return "en-US";
}

export function resolveLocale(pref: LocalePreference): ResolvedLocale {
  return pref === "auto" ? detectSystemLocale() : pref;
}

const localePreference = ref<LocalePreference>("auto");
export const effectiveLocale = computed<ResolvedLocale>(() => resolveLocale(localePreference.value));

export function setLocalePreference(pref: LocalePreference) {
  const safe: LocalePreference = isValidLocalePreference(pref) ? pref : "auto";
  localePreference.value = safe;
  if (typeof document !== "undefined") {
    const resolved = resolveLocale(safe);
    document.documentElement.lang = resolved;
    document.title = MESSAGES[resolved].app.windowTitle;
  }
}

type DotPaths<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${K}`
    : DotPaths<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type MessageKey = DotPaths<Messages>;

function lookup(obj: Record<string, unknown>, path: string): string {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return path;
    }
  }
  return typeof cur === "string" ? cur : path;
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const dict = MESSAGES[effectiveLocale.value] ?? zhCN;
  let text = lookup(dict as unknown as Record<string, unknown>, key);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return text;
}

export function useI18n() {
  return {
    t,
    locale: effectiveLocale,
    preference: localePreference,
    setLocale: setLocalePreference,
  };
}
