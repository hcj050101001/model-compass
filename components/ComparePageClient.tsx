"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { compareVariants, toTargetPoints } from "@/lib/analytics/targets";
import type { MeasurementRow } from "@/lib/analytics/types";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { useDashboardStore } from "@/lib/store/dashboard";
import {
  formatLatency,
  formatScore,
  formatSpeed,
  formatUsd,
  getCreatorDisplayName,
  getDeveloperAgentCost,
} from "@/lib/utils/format";
import { DemoBanner } from "./layout/DemoBanner";
import { Footer } from "./layout/Footer";
import { Header } from "./layout/Header";

const MAX_COMPARE_VARIANTS = 8;

export function ComparePageClient({
  rows,
  snapshot,
  privateMode,
}: {
  rows: MeasurementRow[];
  snapshot: {
    id: string;
    source: string;
    benchmarkVersion: string;
    fetchedAt: string;
    isDemo: boolean;
  } | null;
  privateMode: boolean;
}) {
  const router = useRouter();
  const { locale, t } = useLocale();
  const store = useDashboardStore();

  const rowByVariantId = useMemo(
    () => new Map(rows.map((r) => [r.variantId, r])),
    [rows]
  );

  // Preserve selection order and show every selected row even if score or cost is missing.
  const selectedRows = useMemo(
    () =>
      store.compareIds
        .map((id) => rowByVariantId.get(id))
        .filter((r): r is MeasurementRow => r !== undefined),
    [rowByVariantId, store.compareIds]
  );

  const targetPoints = useMemo(() => toTargetPoints(rows), [rows]);
  const targetPointByVariantId = useMemo(
    () => new Map(targetPoints.map((p) => [p.row.variantId, p])),
    [targetPoints]
  );

  const selectedTargetPoints = useMemo(
    () =>
      selectedRows
        .map((r) => targetPointByVariantId.get(r.variantId))
        .filter((p): p is NonNullable<typeof p> => p !== undefined),
    [selectedRows, targetPointByVariantId]
  );

  const comparison = useMemo(
    () =>
      compareVariants(selectedTargetPoints, {
        costTolerancePct: store.costTolerancePct,
        minScoreGain: store.minScoreGain,
      }),
    [selectedTargetPoints, store.costTolerancePct, store.minScoreGain]
  );

  const availableOptions = useMemo(() => {
    const selectedSet = new Set(store.compareIds);
    return rows
      .filter((r) => !selectedSet.has(r.variantId))
      .sort((a, b) => {
        const aReady = targetPointByVariantId.has(a.variantId) ? 1 : 0;
        const bReady = targetPointByVariantId.has(b.variantId) ? 1 : 0;
        if (aReady !== bReady) return bReady - aReady;
        return (b.intelligenceScore ?? -1) - (a.intelligenceScore ?? -1);
      });
  }, [rows, store.compareIds, targetPointByVariantId]);

  const isMaxReached = selectedRows.length >= MAX_COMPARE_VARIANTS;

  return (
    <div className="min-h-screen flex flex-col bg-bg-primary text-text-primary">
      <DemoBanner isDemo={snapshot?.isDemo ?? true} fetchedAt={snapshot?.fetchedAt} />
      <Header
        fetchedAt={snapshot?.fetchedAt}
        isDemo={snapshot?.isDemo}
        indexVersion={snapshot?.benchmarkVersion}
        privateMode={privateMode}
        onSyncComplete={() => router.refresh()}
      />

      <main className="mx-auto w-full max-w-[1440px] flex-1 space-y-4 px-3 py-4 sm:space-y-6 sm:px-4 sm:py-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold text-text-primary">
              {t("comparePageTitle")}
            </h1>
            <p className="text-xs text-text-muted">{t("comparePageDesc")}</p>
          </div>
          {selectedRows.length > 0 && (
            <button
              type="button"
              onClick={store.clearCompare}
              className="rounded-md border border-border bg-bg-secondary px-3 py-1.5 text-xs text-text-secondary hover:border-rose-400 hover:text-rose-400"
            >
              {t("compareClearAll", { count: selectedRows.length })}
            </button>
          )}
        </div>

        {/* Add Variant Picker + Selected List */}
        <div className="space-y-4 rounded-xl border border-border bg-bg-secondary p-4 text-xs">
          <div>
            <label className="mb-1.5 block font-medium text-text-secondary">
              {t("addVariantPicker")}
            </label>
            <select
              value=""
              disabled={isMaxReached}
              onChange={(e) => {
                if (e.target.value && !isMaxReached) {
                  store.toggleCompare(e.target.value);
                }
              }}
              className="h-10 w-full max-w-md rounded-lg border border-border bg-bg-primary px-3 text-base text-text-primary disabled:cursor-not-allowed disabled:opacity-50 sm:h-9 sm:rounded-md sm:text-xs"
            >
              <option value="">{t("selectVariantPlaceholder")}</option>
              {availableOptions.map((r) => (
                <option key={r.variantId} value={r.variantId}>
                  {getCreatorDisplayName(r.creatorSlug, r.creatorName, locale)} · {r.displayName}
                </option>
              ))}
            </select>
            {isMaxReached && (
              <p className="mt-1.5 text-[11px] text-amber-500">
                {t("compareMaxReached")}
              </p>
            )}
          </div>

          {selectedRows.length > 0 && (
            <div className="border-t border-border/70 pt-3">
              <div className="mb-2 text-[11px] font-medium text-text-muted">
                {t("compareSelectedList", { count: selectedRows.length })}
              </div>
              <div className="flex flex-wrap gap-2">
                {selectedRows.map((row) => (
                  <span
                    key={row.variantId}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-primary px-2.5 py-1 text-xs text-text-primary"
                  >
                    <span className="text-text-muted">
                      {getCreatorDisplayName(row.creatorSlug, row.creatorName, locale)} ·
                    </span>
                    <span className="font-medium">{row.displayName}</span>
                    <button
                      type="button"
                      onClick={() => store.toggleCompare(row.variantId)}
                      title={t("compareRemoveVariant")}
                      aria-label={`${t("compareRemoveVariant")} ${row.displayName}`}
                      className="ml-0.5 rounded-full p-0.5 text-text-muted transition hover:bg-rose-500/15 hover:text-rose-400"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {selectedRows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-bg-secondary p-10 text-center text-sm text-text-muted">
            {t("noCompareSelected")}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto rounded-xl border border-border bg-bg-secondary">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-border bg-bg-tertiary text-text-muted">
                  <tr>
                    <th className="sticky left-0 z-10 whitespace-nowrap bg-bg-tertiary px-3 py-3 sm:px-4">
                      {t("compareMetric")}
                    </th>
                    {selectedRows.map((row) => (
                      <th key={row.variantId} className="whitespace-nowrap px-3 py-3 sm:px-4">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="font-bold text-text-primary">
                              {row.displayName}
                            </div>
                            <div className="font-normal text-text-muted">
                              {getCreatorDisplayName(row.creatorSlug, row.creatorName, locale)}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => store.toggleCompare(row.variantId)}
                            title={t("compareRemoveVariant")}
                            aria-label={`${t("compareRemoveVariant")} ${row.displayName}`}
                            className="rounded p-0.5 text-text-muted transition hover:bg-rose-500/15 hover:text-rose-400"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {[
                    {
                      label: t("compareIntelIndex", {
                        version: snapshot?.benchmarkVersion ?? "5.0",
                      }),
                      fn: (r: MeasurementRow) => formatScore(r.intelligenceScore),
                    },
                    {
                      label: t("compareCodingIndex"),
                      fn: (r: MeasurementRow) => formatScore(r.codingScore),
                    },
                    {
                      label: t("compareAgenticIndex"),
                      fn: (r: MeasurementRow) => formatScore(r.agenticScore),
                    },
                    {
                      label: t("compareCostMetric"),
                      fn: (r: MeasurementRow) => {
                        const devCost = getDeveloperAgentCost(r, "standard");
                        const eac = devCost
                          ? devCost.totalUsd
                          : r.agentCost.estimated_cost;
                        return `${formatUsd(r.agentCost.rasc)} / ${formatUsd(eac)}`;
                      },
                    },
                    {
                      label: t("compareDataQuality"),
                      fn: (r: MeasurementRow) =>
                        t("compareQualityValue", {
                          level: r.dataQuality.level,
                          count: r.agentUsage.sample_count,
                        }),
                    },
                    {
                      label: t("compareTokenPrices"),
                      fn: (r: MeasurementRow) =>
                        `${formatUsd(r.inputPricePerMillion)} / ${formatUsd(r.outputPricePerMillion)}`,
                    },
                    {
                      label: t("compareOutputSpeed"),
                      fn: (r: MeasurementRow) => formatSpeed(r.outputTokensPerSecond),
                    },
                    {
                      label: t("compareTtft"),
                      fn: (r: MeasurementRow) => formatLatency(r.timeToFirstToken),
                    },
                    {
                      label: t("compareReleaseDate"),
                      fn: (r: MeasurementRow) => r.releaseDate ?? "—",
                    },
                  ].map((metric) => (
                    <tr key={metric.label}>
                      <td className="sticky left-0 z-10 whitespace-nowrap bg-bg-secondary px-3 py-2.5 font-medium text-text-muted sm:px-4">
                        {metric.label}
                      </td>
                      {selectedRows.map((row) => (
                        <td
                          key={row.variantId}
                          className="whitespace-nowrap px-3 py-2.5 tabular-nums text-text-primary sm:px-4"
                        >
                          {metric.fn(row)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {comparison.pairwise.length > 0 && (
              <div className="rounded-xl border border-border bg-bg-secondary p-4 text-xs">
                <h2 className="mb-3 font-semibold text-text-primary">
                  {t("pairwiseTitle")}
                </h2>
                <div className="grid gap-2.5 md:grid-cols-2">
                  {comparison.pairwise.map((pw) => {
                    const a = comparison.items.find((x) => x.id === pw.aId)!;
                    const b = comparison.items.find((x) => x.id === pw.bId)!;
                    return (
                      <div
                        key={`${pw.aId}-${pw.bId}`}
                        className="rounded-lg border border-border bg-bg-primary/50 p-3"
                      >
                        <div className="font-medium text-text-primary">
                          {a.row.displayName} vs {b.row.displayName}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-3 text-text-muted">
                          <span>
                            {t("compareScoreGap")}: {pw.scoreGap >= 0 ? "+" : ""}
                            {pw.scoreGap.toFixed(1)} pts
                          </span>
                          <span>
                            {t("compareCostGap")}: {pw.costGapUsd >= 0 ? "+" : ""}
                            {formatUsd(pw.costGapUsd)}
                          </span>
                          <span className="font-semibold text-accent">
                            {pw.relation === "a_dominates_b"
                              ? t("compareDominates", { name: a.row.displayName })
                              : pw.relation === "b_dominates_a"
                                ? t("compareDominates", { name: b.row.displayName })
                                : pw.relation === "equivalent"
                                  ? t("compareExactTie")
                                  : t("compareTradeoff")}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </main>

      <Footer
        indexVersion={snapshot?.benchmarkVersion}
        source={snapshot?.source}
        isDemo={snapshot?.isDemo}
      />
    </div>
  );
}
