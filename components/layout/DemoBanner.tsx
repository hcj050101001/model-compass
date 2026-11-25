"use client";

import { AlertTriangle } from "lucide-react";
import { useLocale } from "@/components/i18n/LocaleProvider";

export function DemoBanner({
  isDemo,
  isStale,
  fetchedAt,
}: {
  isDemo: boolean;
  isStale?: boolean;
  fetchedAt?: string | null;
}) {
  const { t } = useLocale();
  if (!isDemo && !isStale) return null;

  return (
    <div className="space-y-1">
      {isDemo && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-3 py-1.5 text-[11px] sm:px-4 sm:py-2 sm:text-xs">
            <div className="flex items-start gap-2 font-medium sm:items-center">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500 dark:text-amber-400 sm:mt-0 sm:h-4 sm:w-4" />
              <span>
                <strong>{t("demoBannerTitle")}</strong> {t("demoBannerBody")}
              </span>
            </div>
          </div>
        </div>
      )}
      {isStale && (
        <div className="border-b border-rose-500/30 bg-rose-500/10 text-rose-800 dark:text-rose-200">
          <div className="mx-auto flex max-w-5xl items-start gap-2 px-3 py-1.5 text-[11px] sm:items-center sm:px-4 sm:py-2 sm:text-xs">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-500 dark:text-rose-400 sm:mt-0 sm:h-4 sm:w-4" />
            <span>
              {t("staleBanner")}
              {fetchedAt ? new Date(fetchedAt).toLocaleString() : "—"}）。
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
