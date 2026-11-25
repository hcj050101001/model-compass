"use client";

import { useLocale } from "@/components/i18n/LocaleProvider";

export function Footer({
  indexVersion,
  source,
  isDemo,
}: {
  indexVersion?: string | null;
  source?: string | null;
  isDemo?: boolean;
}) {
  const { t } = useLocale();
  return (
    <footer className="mt-8 border-t border-border bg-bg-secondary pt-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] text-xs text-text-muted">
      <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-2 px-3 text-center sm:flex-row sm:px-4 sm:text-left">
        <div>
          <span>{t("footerSourceDesc")} </span>
          <a
            href="https://artificialanalysis.ai/"
            target="_blank"
            rel="noreferrer"
            className="text-accent underline hover:text-accent-hover"
          >
            Artificial Analysis
          </a>
        </div>
        <div className="flex items-center gap-3">
          {source && <span>{source}</span>}
          {indexVersion && <span>v{indexVersion}</span>}
          {isDemo && <span>Demo</span>}
        </div>
      </div>
    </footer>
  );
}
