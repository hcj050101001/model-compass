"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { compareVariants, toTargetPoints } from "@/lib/analytics/targets";
import type { MeasurementRow } from "@/lib/analytics/types";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { useDashboardStore } from "@/lib/store/dashboard";
import {
  formatLatency,
  formatScore,
  formatSpeed,
  formatUsd,
} from "@/lib/utils/format";
import { DemoBanner } from "./layout/DemoBanner";
import { Footer } from "./layout/Footer";
import { Header } from "./layout/Header";

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
  const { t } = useLocale();
  const store = useDashboardStore();
  const targetPoints = useMemo(() => toTargetPoints(rows), [rows]);

  const selected = useMemo(
    () => targetPoints.filter((p) => store.compareIds.includes(p.row.variantId)),
    [targetPoints, store.compareIds]
  );

  const comparison = useMemo(
    () =>
      compareVariants(selected, {
        costTolerancePct: store.costTolerancePct,
        minScoreGain: store.minScoreGain,
      }),
    [selected, store.costTolerancePct, store.minScoreGain]
  );

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
          {store.compareIds.length > 0 && (
            <button
              type="button"
              onClick={store.clearCompare}
              className="rounded-md border border-border bg-bg-secondary px-3 py-1.5 text-xs text-text-secondary hover:border-rose-400 hover:text-rose-400"
            >
              Clear All ({store.compareIds.length})
            </button>
          )}
        </div>

        {/* Add Variant Picker */}
        <div className="rounded-xl border border-border bg-bg-secondary p-4 text-xs">
          <label className="mb-1.5 block font-medium text-text-secondary">
            {t("addVariantPicker")}
          </label>
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) store.toggleCompare(e.target.value);
            }}
            className="h-10 w-full max-w-md rounded-lg border border-border bg-bg-primary px-3 text-base text-text-primary sm:h-9 sm:rounded-md sm:text-xs"
          >
            <option value="">{t("selectVariantPlaceholder")}</option>
            {rows.map((r) => (
              <option key={r.variantId} value={r.variantId}>
                {r.creatorName} · {r.displayName} (
                {formatScore(r.intelligenceScore)} pts / {formatUsd(r.agentCost.rasc ?? r.agentCost.estimated_cost)})
              </option>
            ))}
          </select>
        </div>

        {comparison.items.length === 0 ? (
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
                      Metric
                    </th>
                    {comparison.items.map((item) => (
                      <th key={item.id} className="whitespace-nowrap px-3 py-3 sm:px-4">
                        <div className="font-bold text-text-primary">
                          {item.row.displayName}
                        </div>
                        <div className="font-normal text-text-muted">
                          {item.row.creatorName}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {[
                    {
                      label: `AA Intelligence (v${snapshot?.benchmarkVersion ?? "5.0"})`,
                      fn: (i: (typeof comparison.items)[number]) =>
                        formatScore(i.score),
                    },
                    {
                      label: "AA Coding Index",
                      fn: (i: (typeof comparison.items)[number]) =>
                        formatScore(i.row.codingScore),
                    },
                    {
                      label: "AA Agentic Index",
                      fn: (i: (typeof comparison.items)[number]) =>
                        formatScore(i.row.agenticScore),
                    },
                    {
                      label: "RASC (Real) / EAC (Est.)",
                      fn: (i: (typeof comparison.items)[number]) =>
                        `${formatUsd(i.row.agentCost.rasc)} / ${formatUsd(i.row.agentCost.estimated_cost)}`,
                    },
                    {
                      label: "Data Quality",
                      fn: (i: (typeof comparison.items)[number]) =>
                        `Grade ${i.row.dataQuality.level} (${i.row.agentUsage.sample_count} samples)`,
                    },
                    {
                      label: "Input / Output (1M)",
                      fn: (i: (typeof comparison.items)[number]) =>
                        `${formatUsd(i.row.inputPricePerMillion)} / ${formatUsd(i.row.outputPricePerMillion)}`,
                    },
                    {
                      label: "Output Speed",
                      fn: (i: (typeof comparison.items)[number]) =>
                        formatSpeed(i.row.outputTokensPerSecond),
                    },
                    {
                      label: "TTFT",
                      fn: (i: (typeof comparison.items)[number]) =>
                        formatLatency(i.row.timeToFirstToken),
                    },
                    {
                      label: "Release Date",
                      fn: (i: (typeof comparison.items)[number]) =>
                        i.row.releaseDate ?? "—",
                    },
                  ].map((metric) => (
                    <tr key={metric.label}>
                      <td className="sticky left-0 z-10 whitespace-nowrap bg-bg-secondary px-3 py-2.5 font-medium text-text-muted sm:px-4">
                        {metric.label}
                      </td>
                      {comparison.items.map((item) => (
                        <td
                          key={item.id}
                          className="whitespace-nowrap px-3 py-2.5 tabular-nums text-text-primary sm:px-4"
                        >
                          {metric.fn(item)}
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
                  Pairwise Dominance & Trade-off Analysis
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
                            Score Δ: {pw.scoreGap >= 0 ? "+" : ""}
                            {pw.scoreGap.toFixed(1)} pts
                          </span>
                          <span>
                            Cost Δ: {pw.costGapUsd >= 0 ? "+" : ""}
                            {formatUsd(pw.costGapUsd)}
                          </span>
                          <span className="font-semibold text-accent">
                            {pw.relation === "a_dominates_b"
                              ? `${a.row.displayName} strictly dominates`
                              : pw.relation === "b_dominates_a"
                                ? `${b.row.displayName} strictly dominates`
                                : pw.relation === "equivalent"
                                  ? "Exact Pareto tie"
                                  : "Non-dominated trade-off"}
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
