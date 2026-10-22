"use client";

import { useState } from "react";
import { LANGS, t, type Lang } from "@/lib/i18n";

type Step = "phone" | "code" | "profile";

const inputCls =
  "w-full rounded-xl border-2 border-emerald-300 bg-white px-4 py-4 text-xl focus:border-emerald-600 focus:outline-none";
const btnCls =
  "w-full rounded-xl bg-emerald-600 px-4 py-4 text-xl font-semibold text-white active:bg-emerald-800 disabled:opacity-50";

export default function SignInForm({ initialLang }: { initialLang: Lang }) {
  const [lang, setLang] = useState<Lang>(initialLang);
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [role, setRole] = useState<"farmer" | "buyer" | null>(null);
  const [name, setName] = useState("");
  const [district, setDistrict] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function pickLanguage(l: Lang) {
    setLang(l);
    document.cookie = `lang=${l}; Path=/; Max-Age=31536000; SameSite=Lax`;
  }

  async function call(url: string, method: string, body: unknown): Promise<any | null> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" && data.error.startsWith("signin.err.") ? data.error : "signin.err.generic");
        return null;
      }
      return data;
    } catch {
      setError("signin.err.generic");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    if (await call("/api/auth/request", "POST", { phone, lang })) setStep("code");
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    const data = await call("/api/auth/verify", "POST", { phone, code });
    if (!data) return;
    if (data.isNew) setStep("profile");
    else window.location.href = "/";
  }

  async function finish(e: React.FormEvent) {
    e.preventDefault();
    if (!role) return;
    const body: Record<string, string> = { role, language: lang };
    if (name.trim()) body.name = name.trim();
    if (district.trim()) body.district = district.trim();
    if (await call("/api/me", "PATCH", body)) window.location.href = "/";
  }

  return (
    <main className="mx-auto max-w-md space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-emerald-700">{t(lang, "signin.title")}</h1>
        <select
          aria-label="Language"
          value={lang}
          onChange={(e) => pickLanguage(e.target.value as Lang)}
          className="rounded-lg border border-emerald-300 bg-white px-2 py-2 text-base"
        >
          {LANGS.map((l) => (
            <option key={l} value={l}>
              {t(l, `lang.${l}`)}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p role="alert" className="rounded-xl bg-red-100 px-4 py-3 text-lg text-red-800">
          {t(lang, error)}
        </p>
      )}

      {step === "phone" && (
        <form onSubmit={sendCode} className="space-y-4">
          <label className="block text-lg font-medium" htmlFor="phone">
            {t(lang, "signin.phone.label")}
          </label>
          <input
            id="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            required
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder={t(lang, "signin.phone.hint")}
            className={inputCls}
          />
          <button type="submit" disabled={busy} className={btnCls}>
            {busy ? t(lang, "signin.working") : t(lang, "signin.send")}
          </button>
        </form>
      )}

      {step === "code" && (
        <form onSubmit={verify} className="space-y-4">
          <label className="block text-lg font-medium" htmlFor="code">
            {t(lang, "signin.code.label")}
          </label>
          <input
            id="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            required
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder={t(lang, "signin.code.hint")}
            className={`${inputCls} tracking-widest`}
          />
          <button type="submit" disabled={busy || code.length !== 6} className={btnCls}>
            {busy ? t(lang, "signin.working") : t(lang, "signin.verify")}
          </button>
          <button
            type="button"
            onClick={() => {
              setStep("phone");
              setCode("");
              setError(null);
            }}
            className="w-full py-3 text-lg text-emerald-700 underline"
          >
            {t(lang, "signin.change_phone")}
          </button>
        </form>
      )}

      {step === "profile" && (
        <form onSubmit={finish} className="space-y-4">
          <p className="text-lg font-medium">{t(lang, "signin.role.title")}</p>
          <div className="grid grid-cols-2 gap-3">
            {(["farmer", "buyer"] as const).map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={role === r}
                onClick={() => setRole(r)}
                className={`rounded-xl border-2 px-4 py-6 text-xl font-semibold ${
                  role === r ? "border-emerald-700 bg-emerald-600 text-white" : "border-emerald-300 bg-white text-emerald-800"
                }`}
              >
                {t(lang, `signin.role.${r}`)}
              </button>
            ))}
          </div>
          <label className="block text-lg font-medium" htmlFor="name">
            {t(lang, "signin.name.label")}
          </label>
          <input id="name" type="text" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
          <label className="block text-lg font-medium" htmlFor="district">
            {t(lang, "signin.district.label")}
          </label>
          <input id="district" type="text" value={district} onChange={(e) => setDistrict(e.target.value)} className={inputCls} />
          <button type="submit" disabled={busy || !role} className={btnCls}>
            {busy ? t(lang, "signin.working") : t(lang, "signin.finish")}
          </button>
        </form>
      )}
    </main>
  );
}
