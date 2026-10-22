import { en } from "./strings/en";
import { lg } from "./strings/lg";
import { sw } from "./strings/sw";
import { nyn } from "./strings/nyn";

export const LANGS = ["en", "lg", "sw", "nyn"] as const;
export type Lang = (typeof LANGS)[number];

export type StringTable = Record<Lang, Record<string, string>>;
export const STRINGS: StringTable = { en, lg, sw, nyn };

/** Look up a key in `table`: chosen language, then English, then the key itself. */
export function lookup(table: StringTable, lang: Lang, key: string, vars?: Record<string, string | number>): string {
  const raw = table[lang]?.[key] ?? table.en?.[key] ?? key;
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) => (vars && name in vars ? String(vars[name]) : whole));
}

export function t(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  return lookup(STRINGS, lang, key, vars);
}

const isLang = (s: string | undefined): s is Lang => !!s && (LANGS as readonly string[]).includes(s);

/** A valid cookie wins; else the first Accept-Language entry whose primary tag is supported; else English. */
export function pickLang(acceptLanguage: string | null, cookie: string | undefined): Lang {
  if (isLang(cookie)) return cookie;
  for (const part of (acceptLanguage ?? "").split(",")) {
    const primary = part.split(";")[0].trim().toLowerCase().split("-")[0];
    if (isLang(primary)) return primary;
  }
  return "en";
}
