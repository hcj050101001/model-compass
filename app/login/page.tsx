"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Compass, Languages, Lock } from "lucide-react";
import { useLocale } from "@/components/i18n/LocaleProvider";

export default function LoginPage() {
  const router = useRouter();
  const { locale, toggleLocale, t } = useLocale();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? t("authFailed"));
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError(t("networkError"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-bg-primary px-4 py-8">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-bg-secondary p-5 shadow-xl sm:p-6">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/20 text-accent">
              <Compass className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-base font-bold text-text-primary">
                {t("brand")}
              </h1>
              <p className="text-xs text-text-muted">{t("loginSubtitle")}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={toggleLocale}
            className="flex items-center gap-1 rounded-md border border-border bg-bg-primary px-2 py-1 text-[11px] font-medium text-text-secondary hover:border-accent hover:text-text-primary"
          >
            <Languages className="h-3.5 w-3.5" />
            <span>{locale === "zh" ? "EN" : "中文"}</span>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">
              {t("accessPassword")}
            </label>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoFocus
                placeholder={t("passwordPlaceholder")}
                className="w-full rounded-xl border border-border bg-bg-primary py-2.5 pl-9 pr-3 text-base text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none sm:rounded-lg sm:py-2 sm:text-sm"
              />
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-rose-500/40 bg-rose-500/15 px-3 py-2 text-xs text-rose-300">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-xl bg-accent py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-accent-hover active:scale-[0.99] disabled:opacity-50 sm:rounded-lg"
          >
            {loading ? t("signingIn") : t("signIn")}
          </button>
        </form>
      </div>
    </div>
  );
}
