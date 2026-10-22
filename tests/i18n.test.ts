import { test, expect } from "vitest";
import { LANGS, STRINGS, t, lookup } from "@/lib/i18n";
import { formatUGX, formatDate, formatDateTime } from "@/lib/i18n/format";
import { pickLang } from "@/lib/i18n";
import { fitsOneSms } from "@/lib/sms/fit";

const holes = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort().join(",");

test("every language has every English key with the same placeholders", () => {
  for (const lang of LANGS) {
    for (const [key, en] of Object.entries(STRINGS.en)) {
      const v = (STRINGS[lang] as Record<string, string>)[key];
      expect(v, `${lang}.${key}`).toBeTypeOf("string");
      expect(holes(v), `${lang}.${key}`).toBe(holes(en));
    }
    for (const key of Object.keys(STRINGS[lang])) expect(STRINGS.en, `extra ${lang}.${key}`).toHaveProperty(key);
  }
});

test("every sms.* string fits one SMS in every language with sample values", () => {
  const vars = { amount: "99,999,999 UGX", product: "Irish potatoes", order: "AL-000123", date: "25 Oct 14:00", code: "123456" };
  let n = 0;
  for (const lang of LANGS) {
    for (const key of Object.keys(STRINGS[lang]).filter((k) => k.startsWith("sms."))) {
      n++;
      expect(fitsOneSms(t(lang, key, vars)), `${lang}.${key}`).toBe(true);
    }
  }
  expect(n).toBeGreaterThan(0);
});

test("fitsOneSms limits", () => {
  expect(fitsOneSms("a".repeat(160))).toBe(true);
  expect(fitsOneSms("a".repeat(161))).toBe(false);
  expect(fitsOneSms("[".repeat(80))).toBe(true);
  expect(fitsOneSms("[".repeat(81))).toBe(false);
  expect(fitsOneSms("é".repeat(160))).toBe(true);
  expect(fitsOneSms("a".repeat(159) + "\\")).toBe(false);
  expect(fitsOneSms("a".repeat(158) + "\\")).toBe(true);
  expect(fitsOneSms("a".repeat(70) + "’")).toBe(false);
  expect(fitsOneSms("a".repeat(69) + "’")).toBe(true);
  expect(fitsOneSms("ŋ".repeat(70))).toBe(true);
  expect(fitsOneSms("ŋ".repeat(71))).toBe(false);
});

test("formatUGX", () => expect(formatUGX(1200000)).toBe("1,200,000 UGX"));

test("dates use Kampala time and string-file months", () => {
  expect(formatDate("en", new Date("2026-10-29T10:00:00Z"))).toBe("29 Oct");
  expect(formatDate("sw", new Date("2026-03-05T10:00:00Z"))).toBe("5 Mac");
  expect(formatDateTime("en", new Date("2026-10-25T11:00:00Z"))).toBe("25 Oct 14:00");
  expect(formatDateTime("en", new Date("2026-10-31T22:30:00Z"))).toBe("1 Nov 01:30");
});

test("missing key falls back to English, then to the key", () => {
  const table = { en: { a: "Hello {name}", b: "Only English" }, lg: { a: "Gyebale {name}" } } as never;
  expect(lookup(table, "lg", "a", { name: "Ann" })).toBe("Gyebale Ann");
  expect(lookup(table, "lg", "b")).toBe("Only English");
  expect(lookup(table, "lg", "zzz")).toBe("zzz");
  expect(t("lg", "no.such.key")).toBe("no.such.key");
});

test("pickLang", () => {
  expect(pickLang("sw-KE,en;q=0.8", undefined)).toBe("sw");
  expect(pickLang("fr, nyn;q=0.5", undefined)).toBe("nyn");
  expect(pickLang("sw", "lg")).toBe("lg");
  expect(pickLang("sw", "xx")).toBe("sw");
  expect(pickLang(null, undefined)).toBe("en");
  expect(pickLang("fr-FR", undefined)).toBe("en");
});
