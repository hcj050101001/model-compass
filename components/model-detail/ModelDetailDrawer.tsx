"use client";

import { useEffect, useMemo } from "react";
import { ExternalLink, X } from "lucide-react";
import type { MeasurementRow } from "@/lib/analytics/types";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { useDashboardStore } from "@/lib/store/dashboard";
import {
  formatScore,
  formatSpeed,
  formatUsd,
  getCreatorDisplayName,
  getDeveloperAgentCost,
} from "@/lib/utils/format";

export function ModelDetailDrawer({
  allRows,
  globalFrontierIds,
}: {
  allRows: MeasurementRow[];
  globalFrontierIds: Set<string>;
}) {
  const { locale, t } = useLocale();
  const store = useDashboardStore();

  const activeRow = useMemo(
    () =>
      allRows.find((r) => r.variantId === store.activeDetailVariantId) ?? null,
    [allRows, store.activeDetailVariantId]
  );

  const nearbyRows = useMemo(() => {
    if (store.activeDetailVariantIds.length <= 1) return [];
    const byId = new Map(allRows.map((r) => [r.variantId, r]));
    return store.activeDetailVariantIds
      .map((id) => byId.get(id))
      .filter((r): r is MeasurementRow => Boolean(r));
  }, [allRows, store.activeDetailVariantIds]);

  const releaseVariants = useMemo(() => {
    if (!activeRow) return [];
    return allRows
      .filter((r) => r.releaseId === activeRow.releaseId)
      .sort((a, b) => (a.effortOrder ?? 999) - (b.effortOrder ?? 999));
  }, [allRows, activeRow]);

  useEffect(() => {
    if (!activeRow) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        store.setActiveDetailVariantId(null);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [activeRow, store]);

  if (!activeRow) return null;

  const isBestValue = globalFrontierIds.has(activeRow.id);
  const activeScore = activeRow.intelligenceScore;
  const devCost = getDeveloperAgentCost(activeRow, store.taskProfile);
  const activeCost = devCost?.totalUsd ?? null;
  const creatorDisplay = getCreatorDisplayName(
    activeRow.creatorSlug,
    activeRow.creatorName,
    locale
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-stretch sm:justify-end">
      <div
        className="animate-fade-in fixed inset-0 bg-black/55 backdrop-blur-sm"
        onClick={() => store.setActiveDetailVariantId(null)}
      />
      <aside className="animate-sheet-up sm:animate-drawer-in relative z-10 flex max-h-[88dvh] w-full flex-col rounded-t-2xl border-t border-border bg-bg-secondary shadow-2xl sm:h-full sm:max-h-full sm:max-w-md sm:rounded-none sm:border-l sm:border-t-0">
        <div className="mx-auto mt-2.5 mb-1 h-1 w-10 shrink-0 rounded-full bg-border sm:hidden" />

        {/* Header */}
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 pb-3.5 pt-2 sm:px-5 sm:py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: activeRow.creatorColor }}
              />
              <span className="text-xs font-medium text-text-muted">
                {creatorDisplay}
              </span>
              <span className="rounded bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
                {t("simpleEffortLabel")}: {activeRow.effortNormalized ?? "Standard"}
              </span>
              {isBestValue && (
                <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-sky-400">
                  {t("simpleBestValueBadge")}
                </span>
              )}
            </div>
            <h2 className="mt-1.5 text-lg font-bold leading-snug text-text-primary">
              {activeRow.displayName}
            </h2>
            <p className="mt-0.5 text-xs text-text-muted">
              {activeRow.releaseDate ?? ""}
            </p>
          </div>
          <button
            type="button"
            onClick={() => store.setActiveDetailVariantId(null)}
            aria-label="Close"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-muted transition hover:bg-bg-tertiary hover:text-text-primary active:scale-95"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto px-4 py-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:px-5 sm:py-5">
          {nearbyRows.length > 1 && (
            <div className="mb-4 rounded-xl border border-border bg-bg-primary/50 p-3">
              <div className="mb-2 flex items-center justify-between text-xs font-semibold text-text-primary">
                <span>
                  {t("drawerNearbyPoints")} ({nearbyRows.length})
                </span>
              </div>
              <div className="mt-2 overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-left text-[11px]">
                  <thead className="bg-bg-tertiary text-text-muted">
                    <tr>
                      <th className="px-2.5 py-1.5">{t("colModel")}</th>
                      <th className="px-2 py-1.5 text-right">
                        {t("simpleColScore")}
                      </th>
                      <th className="px-2 py-1.5 text-right">
                        {t("simpleColCost")}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {nearbyRows.map((nr) => {
                      const isActive = nr.variantId === activeRow.variantId;
                      return (
                        <tr
                          key={nr.variantId}
                          onClick={() =>
                            store.setActiveDetailVariantId(nr.variantId)
                          }
                          className={`cursor-pointer transition hover:bg-bg-tertiary/60 ${
                            isActive ? "bg-accent/10 font-semibold" : ""
                          }`}
                        >
                          <td className="px-2.5 py-1.5 text-text-primary">
                            <div>{nr.releaseName}</div>
                            <div className="text-[10px] text-text-muted">
                              {nr.effortNormalized ?? "Standard"}
                            </div>
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">
                            {formatScore(nr.intelligenceScore)}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">
                            {formatUsd(
                              getDeveloperAgentCost(nr, store.taskProfile)
                                ?.totalUsd ?? null
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 2x2 Key Metrics */}
          <div className="grid grid-cols-2 gap-2.5 text-xs sm:gap-3">
            <div className="rounded-xl border border-accent/25 bg-accent/5 p-3">
              <div className="text-[11px] text-text-muted">
                {t("simpleColScore")}
              </div>
              <div className="mt-1 text-base font-bold tabular-nums text-accent">
                {formatScore(activeScore)}
              </div>
            </div>
            <div className="rounded-xl border border-border bg-bg-primary/60 p-3">
              <div className="text-[11px] text-text-muted">
                {t("simpleColCost")}
              </div>
              <div className="mt-1 text-base font-bold tabular-nums text-text-primary">
                {formatUsd(activeCost)}
              </div>
            </div>
            <div className="rounded-xl border border-border bg-bg-primary/60 p-3">
              <div className="text-[11px] text-text-muted">
                {t("simpleColSpeed")}
              </div>
              <div className="mt-1 text-base font-bold tabular-nums text-text-primary">
                {formatSpeed(activeRow.outputTokensPerSecond)}
              </div>
            </div>
            <div className="rounded-xl border border-border bg-bg-primary/60 p-3">
              <div className="text-[11px] text-text-muted">
                {t("simpleColContext")}
              </div>
              <div className="mt-1 text-base font-bold tabular-nums text-text-primary">
                {activeRow.contextWindow
                  ? `${Math.round(activeRow.contextWindow / 1000)}K`
                  : "—"}
              </div>
            </div>
          </div>

          {/* Official Token Pricing */}
          <div className="mt-3 space-y-1.5 rounded-xl border border-border bg-bg-primary/40 p-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-text-muted">{t("simpleTokenPrice")}</span>
              <span className="font-medium tabular-nums text-text-primary">
                {formatUsd(activeRow.inputPricePerMillion)} /{" "}
                {formatUsd(activeRow.outputPricePerMillion)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-text-muted">
                {locale === "zh"
                  ? "缓存读取 / 写入 (每百万)"
                  : "Cache Read / Write (per 1M)"}
              </span>
              <span className="font-medium tabular-nums text-text-primary">
                {formatUsd(activeRow.cacheReadPricePerMillion)} /{" "}
                {formatUsd(activeRow.cacheWritePricePerMillion)}
              </span>
            </div>
          </div>

          {/* Multi-Turn Developer Agent Cost Breakdown */}
          {devCost && (
            <div className="mt-3 space-y-1.5 rounded-xl border border-border bg-bg-primary/40 p-3 text-xs">
              <div className="font-semibold text-text-primary">
                {locale === "zh"
                  ? `花费拆解（平均上下文 ~${Math.round(devCost.avgContextTokens / 1000)}K · ${devCost.turns} 步）`
                  : `Cost Breakdown (~${Math.round(devCost.avgContextTokens / 1000)}K Avg Ctx · ${devCost.turns} steps)`}
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                <span className="text-text-muted">
                  {locale === "zh" ? "未缓存输入费用" : "Uncached Input Cost"}
                </span>
                <span className="text-right tabular-nums">
                  {formatUsd(devCost.inputCostUsd)}
                </span>
                <span className="text-text-muted">
                  {locale === "zh" ? "缓存读取费用" : "Cache Read Cost"}
                </span>
                <span className="text-right tabular-nums">
                  {formatUsd(devCost.cacheReadCostUsd)}
                </span>
                <span className="text-text-muted">
                  {locale === "zh" ? "缓存写入费用" : "Cache Write Cost"}
                </span>
                <span className="text-right tabular-nums">
                  {formatUsd(devCost.cacheWriteCostUsd)}
                </span>
                <span className="text-text-muted">
                  {locale === "zh"
                    ? "输出与推理费用"
                    : "Output & Thinking Cost"}
                </span>
                <span className="text-right tabular-nums">
                  {formatUsd(devCost.outputCostUsd)}
                </span>
                <span className="text-text-muted">
                  {locale === "zh" ? "缓存省下" : "Cache Savings"}
                </span>
                <span className="text-right tabular-nums text-emerald-400">
                  -{formatUsd(devCost.cacheSavingsUsd)}
                </span>
                <span className="text-text-muted">
                  {locale === "zh"
                    ? "上下文压缩次数"
                    : "Context Compactions"}
                </span>
                <span className="text-right tabular-nums">
                  {devCost.compactionCount}
                </span>
              </div>
            </div>
          )}

          {/* Other Tiers for Same Model */}
          {releaseVariants.length > 1 && (
            <div className="mt-5">
              <h3 className="text-xs font-semibold text-text-muted">
                {t("simpleOtherTiers")} ({releaseVariants.length})
              </h3>
              <div className="mt-2 overflow-hidden rounded-xl border border-border">
                <table className="w-full text-left text-xs">
                  <thead className="bg-bg-tertiary text-text-muted">
                    <tr>
                      <th className="px-3 py-2">{t("colEffort")}</th>
                      <th className="px-3 py-2 text-right">
                        {t("simpleColScore")}
                      </th>
                      <th className="px-3 py-2 text-right">
                        {t("simpleColCost")}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {releaseVariants.map((v) => (
                      <tr
                        key={v.variantId}
                        onClick={() => store.setActiveDetailVariantId(v.variantId)}
                        className={`cursor-pointer transition hover:bg-bg-tertiary/60 ${
                          v.variantId === activeRow.variantId
                            ? "bg-accent/10 font-semibold"
                            : ""
                        }`}
                      >
                        <td className="px-3 py-2.5 text-text-primary">
                          {v.effortNormalized ?? "Standard"}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {formatScore(v.intelligenceScore)}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {formatUsd(
                            getDeveloperAgentCost(v, store.taskProfile)
                              ?.totalUsd ?? null
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Source Link */}
          <div className="mt-6">
            <a
              href={activeRow.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-xs font-medium text-text-secondary transition hover:border-accent hover:text-text-primary sm:w-auto sm:justify-start sm:rounded-lg sm:py-2"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              <span>{t("simpleViewSource")}</span>
            </a>
          </div>
        </div>
      </aside>
    </div>
  );
}
