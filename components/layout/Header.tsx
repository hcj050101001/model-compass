"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import {
  Compass,
  GitCompareArrows,
  Languages,
  LayoutDashboard,
  LogOut,
  Moon,
  Sun,
} from "lucide-react";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { useDashboardStore } from "@/lib/store/dashboard";

interface HeaderProps {
  fetchedAt?: string | null;
  isDemo?: boolean;
  indexVersion?: string | null;
  onSyncComplete?: () => void;
  privateMode?: boolean;
}

export function Header({
  isDemo,
  privateMode = true,
}: HeaderProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { locale, toggleLocale, t } = useLocale();
  const { theme, toggleTheme } = useDashboardStore();

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("dark", "light");
    root.classList.add(theme);
  }, [theme]);

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-bg-secondary/85 pt-[env(safe-area-inset-top)] backdrop-blur-md">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2.5 px-3 py-2.5 sm:flex-nowrap sm:gap-3 sm:px-4 sm:py-3">
        <Link href="/" className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-accent/25 to-accent/10 text-accent ring-1 ring-accent/30">
            <Compass className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-sm font-semibold tracking-tight text-text-primary">
              <span className="truncate">{t("brand")}</span>
              {isDemo && (
                <span className="shrink-0 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                  {t("demoBadge")}
                </span>
              )}
            </div>
            <p className="truncate text-[11px] text-text-muted">
              {t("simpleSubtitle")}
            </p>
          </div>
        </Link>

        <nav
          aria-label="Primary"
          className="order-3 flex w-full shrink-0 items-center gap-2.5 text-xs sm:order-none sm:w-auto sm:gap-3.5"
        >
          <Link
            href="/"
            className={`flex h-9 items-center gap-2 rounded-lg border px-3 font-medium transition active:scale-95 sm:h-8 sm:px-3.5 ${
              pathname === "/"
                ? "border-accent/40 bg-accent/10 text-accent shadow-sm"
                : "border-border/80 bg-bg-tertiary/70 text-text-secondary hover:border-accent/40 hover:bg-bg-tertiary hover:text-text-primary"
            }`}
          >
            <LayoutDashboard className="h-3.5 w-3.5 shrink-0" />
            <span>{t("navDashboard")}</span>
          </Link>
          <Link
            href="/compare"
            className={`flex h-9 items-center gap-2 rounded-lg border px-3 font-medium transition active:scale-95 sm:h-8 sm:px-3.5 ${
              pathname.startsWith("/compare")
                ? "border-accent/40 bg-accent/10 text-accent shadow-sm"
                : "border-border/80 bg-bg-tertiary/70 text-text-secondary hover:border-accent/40 hover:bg-bg-tertiary hover:text-text-primary"
            }`}
          >
            <GitCompareArrows className="h-3.5 w-3.5 shrink-0" />
            <span>{t("navCompare")}</span>
          </Link>
        </nav>

        <div className="flex shrink-0 items-center gap-1.5 text-xs sm:gap-2">
          <button
            type="button"
            onClick={toggleLocale}
            title="Switch Language / 切换语言"
            className="flex h-9 min-w-[36px] items-center justify-center gap-1 rounded-lg border border-border bg-bg-tertiary px-2.5 font-medium text-text-secondary transition hover:border-accent hover:text-text-primary active:scale-95 sm:h-8 sm:min-w-[32px] sm:rounded-md"
          >
            <Languages className="h-3.5 w-3.5" />
            <span>{locale === "zh" ? "EN" : "中文"}</span>
          </button>

          <button
            type="button"
            onClick={toggleTheme}
            title="Toggle theme"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-bg-tertiary text-text-secondary transition hover:border-accent hover:text-text-primary active:scale-95 sm:h-8 sm:w-8 sm:rounded-md"
          >
            {theme === "dark" ? (
              <Sun className="h-4 w-4" />
            ) : (
              <Moon className="h-4 w-4" />
            )}
          </button>

          {privateMode && (
            <button
              type="button"
              onClick={handleLogout}
              title="Sign out"
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-bg-tertiary text-text-secondary transition hover:border-rose-400 hover:text-rose-400 active:scale-95 sm:h-8 sm:w-8 sm:rounded-md"
            >
              <LogOut className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
