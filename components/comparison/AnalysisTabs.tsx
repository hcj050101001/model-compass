"use client";

import { useMemo, useState } from "react";
import { findSuperiorAlternatives } from "@/lib/analytics/alternatives";
import {
  buildAgentRoutingTiers,
  compareVariants,
  findBestWithinBudget,
  findCheapestForIntelligence,
  toTargetPoints,
  type TargetPoint,
} from "@/lib/analytics/targets";
import type { MeasurementRow } from "@/lib/analytics/types";
import { calculateCustomWorkloadCost } from "@/lib/analytics/workload";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { useDashboardStore } from "@/lib/store/dashboard";
import { formatScore, formatSpeed, formatUsd } from "@/lib/utils/format";

type TabKey = "pareto" | "targets" | "compare" | "workload";

export function AnalysisTabs({
  allRows,
  filteredRows,
  globalFrontierPoints,
  localFrontierPoints,
}: {
  allRows: MeasurementRow[];
  filteredRows: MeasurementRow[];
  globalFrontierPoints: TargetPoint[];
  localFrontierPoints: TargetPoint[];
}) {
  const { t } = useLocale();
  const store = useDashboardStore();
  const [activeTab, setActiveTab] = useState<TabKey>("pareto");
  const [maxBudget, setMaxBudget] = useState<number>(1.0);
  const [minIntel, setMinIntel] = useState<number>(55);
  const [targetVariantId, setTargetVariantId] = useState<string>("");

  const allTargetPoints = useMemo(() => toTargetPoints(allRows), [allRows]);
  const filteredTargetPoints = useMemo(
    () => toTargetPoints(filteredRows),
    [filteredRows]
  );

  const selectedTarget = useMemo(() => {
    if (targetVariantId) {
      return (
        allTargetPoints.find((p) => p.row.variantId === targetVariantId) ??
        allTargetPoints[0] ??
        null
      );
    }
    return allTargetPoints[0] ?? null;
  }, [allTargetPoints, targetVariantId]);

  const superiorResult = useMemo(() => {
    if (!selectedTarget) return null;
    return findSuperiorAlternatives(selectedTarget, allTargetPoints, {
      costTolerancePct: store.costTolerancePct,
      minScoreGain: store.minScoreGain,
    });
  }, [
    selectedTarget,
    allTargetPoints,
    store.costTolerancePct,
    store.minScoreGain,
  ]);

  const budgetResults = useMemo(
    () => findBestWithinBudget(filteredTargetPoints, maxBudget).slice(0, 8),
    [filteredTargetPoints, maxBudget]
  );

  const intelResults = useMemo(
    () => findCheapestForIntelligence(filteredTargetPoints, minIntel).slice(0, 8),
    [filteredTargetPoints, minIntel]
  );

  const routingTiers = useMemo(
    () => buildAgentRoutingTiers(globalFrontierPoints),
    [globalFrontierPoints]
  );

  const compareResult = useMemo(() => {
    const selected = allTargetPoints.filter((p) =>
      store.compareIds.includes(p.row.variantId)
    );
    return compareVariants(selected, {
      costTolerancePct: store.costTolerancePct,
      minScoreGain: store.minScoreGain,
    });
  }, [
    allTargetPoints,
    store.compareIds,
    store.costTolerancePct,
    store.minScoreGain,
  ]);

  const workloadEstimates = useMemo(() => {
    return filteredRows
      .map((r) => {
        const est = calculateCustomWorkloadCost(
          {
            inputPricePerMillion: r.inputPricePerMillion,
            outputPricePerMillion: r.outputPricePerMillion,
            cacheReadPricePerMillion: r.cacheReadPricePerMillion,
          },
          {
            inputTokensPerTask: store.agentParams.inputTokens,
            cacheHitTokensPerTask: Math.round(
              store.agentParams.inputTokens * store.agentParams.cacheHitRate
            ),
            outputTokensPerTask: store.agentParams.outputTokens,
            reasoningTokensPerTask: store.agentParams.reasoningTokens,
            reasoningIncludedInOutput:
              store.agentParams.reasoningIncludedInOutput,
            tasksPerDay: 50,
            workingDaysPerMonth: 22,
          }
        );
        if (!est) return null;
        return { row: r, est };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.est.perTaskUsd - b.est.perTaskUsd)
      .slice(0, 12);
  }, [filteredRows, store.agentParams]);

  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: "pareto", label: t("tabPareto") },
    { key: "targets", label: t("tabTargets") },
    {
      key: "compare",
      label: `${t("tabCompare")} (${store.compareIds.length})`,
    },
    { key: "workload", label: t("tabWorkload") },
  ];

  return (
    <section className="rounded-xl border border-border bg-bg-secondary">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 pt-2">
        <div className="flex flex-wrap gap-1">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setActiveTab(t.key)}
              className={`border-b-2 px-3 py-2.5 text-xs font-medium transition ${
                activeTab === t.key
                  ? "border-accent text-accent"
                  : "border-transparent text-text-muted hover:text-text-primary"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="pb-2 text-[11px] text-text-muted">
          {t("globalFrontierCount")}: {globalFrontierPoints.length} ·{" "}
          {t("localFrontierCount")}: {localFrontierPoints.length}
        </div>
      </div>

      <div className="p-4 text-xs">
        {activeTab === "pareto" && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-bg-primary/50 p-3">
              <div className="min-w-[220px] flex-1">
                <label className="mb-1 block text-[11px] text-text-muted">
                  {t("inspectVariant")}
                </label>
                <select
                  value={selectedTarget?.row.variantId ?? ""}
                  onChange={(e) => setTargetVariantId(e.target.value)}
                  className="w-full rounded-md border border-border bg-bg-secondary px-2.5 py-1.5 text-text-primary"
                >
                  {allTargetPoints.map((p) => (
                    <option key={p.row.variantId} value={p.row.variantId}>
                      {p.row.creatorName} · {p.row.displayName} (
                      {formatScore(p.score)} pts / {formatUsd(p.cost)})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-text-muted">
                  {t("costTolerance")}
                </label>
                <div className="flex gap-1">
                  {[0, 2, 5, 10].map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => store.setCostTolerancePct(v)}
                      className={`rounded border px-2 py-1 ${
                        store.costTolerancePct === v
                          ? "border-accent bg-accent/15 text-accent"
                          : "border-border bg-bg-secondary text-text-muted"
                      }`}
                    >
                      {v}%
                    </button>
                  ))}
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={store.costTolerancePct}
                    onChange={(e) =>
                      store.setCostTolerancePct(Number(e.target.value) || 0)
                    }
                    className="w-16 rounded border border-border bg-bg-secondary px-2 py-1 text-text-primary"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-text-muted">
                  {t("minScoreGain")}
                </label>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={store.minScoreGain}
                  onChange={(e) =>
                    store.setMinScoreGain(Number(e.target.value) || 0)
                  }
                  className="w-20 rounded border border-border bg-bg-secondary px-2 py-1 text-text-primary"
                />
              </div>
            </div>

            {superiorResult && (
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-lg border border-border bg-bg-primary/40 p-3">
                  <div className="font-semibold text-sky-400">
                    {t("strictDominators")} (
                    {superiorResult.strictDominators.length})
                  </div>
                  <p className="mt-0.5 text-[11px] text-text-muted">
                    {t("strictDominatorsDesc")}
                  </p>
                  <div className="mt-2 space-y-1.5">
                    {superiorResult.strictDominators.length === 0 ? (
                      <div className="text-text-muted">
                        {t("noStrictDominators")}
                      </div>
                    ) : (
                      superiorResult.strictDominators.slice(0, 6).map((m) => (
                        <button
                          key={m.candidate.id}
                          type="button"
                          onClick={() =>
                            store.setActiveDetailVariantId(
                              m.candidate.row.variantId
                            )
                          }
                          className="flex w-full items-center justify-between rounded border border-border bg-bg-secondary px-2.5 py-1.5 hover:border-accent"
                        >
                          <span className="font-medium text-text-primary">
                            {m.candidate.row.displayName}
                          </span>
                          <span className="text-emerald-400">
                            +{m.scoreDiff.toFixed(1)} pts ·{" "}
                            {formatUsd(m.candidate.cost)}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                </div>

                <div className="rounded-lg border border-border bg-bg-primary/40 p-3">
                  <div className="font-semibold text-amber-400">
                    {t("approxAlternatives")} (
                    {superiorResult.approximateAlternatives.length})
                  </div>
                  <p className="mt-0.5 text-[11px] text-text-muted">
                    {t("approxAlternativesDesc", {
                      tol: store.costTolerancePct,
                      gain: store.minScoreGain,
                    })}
                  </p>
                  <div className="mt-2 space-y-1.5">
                    {superiorResult.approximateAlternatives.length === 0 ? (
                      <div className="text-text-muted">
                        {t("noApproxAlternatives")}
                      </div>
                    ) : (
                      superiorResult.approximateAlternatives
                        .slice(0, 6)
                        .map((m) => (
                          <button
                            key={m.candidate.id}
                            type="button"
                            onClick={() =>
                              store.setActiveDetailVariantId(
                                m.candidate.row.variantId
                              )
                            }
                            className="flex w-full items-center justify-between rounded border border-border bg-bg-secondary px-2.5 py-1.5 hover:border-accent"
                          >
                            <span className="font-medium text-text-primary">
                              {m.candidate.row.displayName}
                            </span>
                            <span className="text-amber-300">
                              +{m.scoreDiff.toFixed(1)} pts ·{" "}
                              {m.costDiffPct !== null
                                ? `+${m.costDiffPct.toFixed(1)}% cost`
                                : formatUsd(m.candidate.cost)}
                            </span>
                          </button>
                        ))
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === "targets" && (
          <div className="space-y-5">
            <div className="grid gap-4 md:grid-cols-2">
              {/* Mode A */}
              <div className="rounded-lg border border-border bg-bg-primary/40 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="font-semibold text-text-primary">
                      {t("modeATitle")}
                    </div>
                    <div className="text-[11px] text-text-muted">
                      {t("modeADesc")}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-text-muted">$</span>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      value={maxBudget}
                      onChange={(e) =>
                        setMaxBudget(Math.max(0, Number(e.target.value) || 0))
                      }
                      className="w-20 rounded border border-border bg-bg-secondary px-2 py-1 text-text-primary"
                    />
                  </div>
                </div>
                <div className="mt-3 space-y-1.5">
                  {budgetResults.map((p, idx) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() =>
                        store.setActiveDetailVariantId(p.row.variantId)
                      }
                      className="flex w-full items-center justify-between rounded border border-border bg-bg-secondary px-2.5 py-1.5 hover:border-accent"
                    >
                      <span className="truncate">
                        <strong className="text-text-muted mr-1.5">
                          #{idx + 1}
                        </strong>
                        <span className="font-medium text-text-primary">
                          {p.row.displayName}
                        </span>
                      </span>
                      <span className="shrink-0 text-sky-400">
                        {formatScore(p.score)} pts · {formatUsd(p.cost)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Mode B */}
              <div className="rounded-lg border border-border bg-bg-primary/40 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="font-semibold text-text-primary">
                      {t("modeBTitle")}
                    </div>
                    <div className="text-[11px] text-text-muted">
                      {t("modeBDesc")}
                    </div>
                  </div>
                  <input
                    type="number"
                    step="1"
                    min="0"
                    value={minIntel}
                    onChange={(e) =>
                      setMinIntel(Math.max(0, Number(e.target.value) || 0))
                    }
                    className="w-20 rounded border border-border bg-bg-secondary px-2 py-1 text-text-primary"
                  />
                </div>
                <div className="mt-3 space-y-1.5">
                  {intelResults.map((p, idx) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() =>
                        store.setActiveDetailVariantId(p.row.variantId)
                      }
                      className="flex w-full items-center justify-between rounded border border-border bg-bg-secondary px-2.5 py-1.5 hover:border-accent"
                    >
                      <span className="truncate">
                        <strong className="text-text-muted mr-1.5">
                          #{idx + 1}
                        </strong>
                        <span className="font-medium text-text-primary">
                          {p.row.displayName}
                        </span>
                      </span>
                      <span className="shrink-0 text-emerald-400">
                        {formatUsd(p.cost)} · {formatScore(p.score)} pts
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Mode D: Routing Tiers */}
            <div>
              <div className="mb-2 font-semibold text-text-primary">
                {t("modeDTitle")}
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {routingTiers.map((tier) => (
                  <div
                    key={tier.tierName}
                    className="rounded-lg border border-border bg-bg-primary/40 p-3"
                  >
                    <div className="font-semibold text-text-primary">
                      {tier.tierName}
                    </div>
                    <div className="text-[11px] text-accent">
                      {tier.budgetRangeLabel}
                    </div>
                    <div className="mt-2 space-y-1">
                      {tier.candidates.length === 0 ? (
                        <div className="text-text-muted">{t("noFrontierInBand")}</div>
                      ) : (
                        tier.candidates.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() =>
                              store.setActiveDetailVariantId(c.row.variantId)
                            }
                            className="flex w-full items-center justify-between rounded bg-bg-secondary px-2 py-1 text-left hover:text-accent"
                          >
                            <span className="truncate pr-1">{c.row.displayName}</span>
                            <span className="shrink-0 font-semibold">
                              {formatScore(c.score)}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                    <p className="mt-2 text-[10px] leading-relaxed text-text-muted">
                      {tier.caveat}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === "compare" && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-text-muted">{t("compareHint")}</div>
              <div className="flex items-center gap-3">
                <label className="flex cursor-pointer items-center gap-1.5 text-text-secondary">
                  <input
                    type="checkbox"
                    checked={store.highlightCompareOnChart}
                    onChange={(e) =>
                      store.setHighlightCompareOnChart(e.target.checked)
                    }
                    className="h-3.5 w-3.5 rounded accent-accent"
                  />
                  <span>{t("highlightOnChart")}</span>
                </label>
                {store.compareIds.length > 0 && (
                  <button
                    type="button"
                    onClick={store.clearCompare}
                    className="rounded border border-border px-2 py-1 text-text-muted hover:text-rose-400"
                  >
                    {t("clearSelection")}
                  </button>
                )}
              </div>
            </div>

            {compareResult.items.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-6 text-center text-text-muted">
                {t("noCompareSelected")}
              </div>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-left">
                  <thead className="bg-bg-tertiary text-text-muted">
                    <tr>
                      <th className="px-3 py-2">Model Variant</th>
                      <th className="px-3 py-2">Creator</th>
                      <th className="px-3 py-2">Effort</th>
                      <th className="px-3 py-2">Intelligence</th>
                      <th className="px-3 py-2">Cost / Task</th>
                      <th className="px-3 py-2">Speed</th>
                      <th className="px-3 py-2">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {compareResult.items.map((item) => (
                      <tr key={item.id}>
                        <td className="px-3 py-2 font-medium text-text-primary">
                          {item.row.displayName}
                        </td>
                        <td className="px-3 py-2">{item.row.creatorName}</td>
                        <td className="px-3 py-2">
                          {item.row.effortNormalized ?? "Standard"}
                        </td>
                        <td className="px-3 py-2 font-semibold">
                          {formatScore(item.score)}
                        </td>
                        <td className="px-3 py-2">{formatUsd(item.cost)}</td>
                        <td className="px-3 py-2">
                          {formatSpeed(item.row.outputTokensPerSecond)}
                        </td>
                        <td className="px-3 py-2">
                          <button
                            type="button"
                            onClick={() => store.toggleCompare(item.row.variantId)}
                            className="text-rose-400 hover:underline"
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {activeTab === "workload" && (
          <div className="space-y-4">
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
              {t("workloadNotice")}
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                {
                  label: t("inputTokens"),
                  key: "inputTokens" as const,
                  val: store.agentParams.inputTokens,
                },
                {
                  label: t("outputTokens"),
                  key: "outputTokens" as const,
                  val: store.agentParams.outputTokens,
                },
                {
                  label: t("reasoningTokens"),
                  key: "reasoningTokens" as const,
                  val: store.agentParams.reasoningTokens,
                },
                {
                  label: t("cacheHitTokens"),
                  key: "cacheWriteTokens" as const,
                  val: store.agentParams.cacheWriteTokens,
                },
              ].map((field) => (
                <div key={field.key}>
                  <label className="mb-1 block text-[11px] text-text-muted">
                    {field.label}
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={field.val}
                    onChange={(e) =>
                      store.setAgentParams({
                        [field.key]: Math.max(0, Number(e.target.value) || 0),
                      })
                    }
                    className="w-full rounded border border-border bg-bg-primary px-2 py-1.5 text-text-primary"
                  />
                </div>
              ))}
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-text-secondary">
              <input
                type="checkbox"
                checked={store.agentParams.reasoningIncludedInOutput}
                onChange={(e) =>
                  store.setAgentParams({
                    reasoningIncludedInOutput: e.target.checked,
                  })
                }
                className="h-3.5 w-3.5 rounded accent-accent"
              />
              <span>{t("reasoningIncludedLabel")}</span>
            </label>

            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-left">
                <thead className="bg-bg-tertiary text-text-muted">
                  <tr>
                    <th className="px-3 py-2">{t("colModel")}</th>
                    <th className="px-3 py-2">{t("colIntel")}</th>
                    <th className="px-3 py-2">{t("estPerTask")}</th>
                    <th className="px-3 py-2">{t("estDaily")}</th>
                    <th className="px-3 py-2">{t("estMonthly")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {workloadEstimates.map(({ row, est }) => (
                    <tr
                      key={row.id}
                      onClick={() => store.setActiveDetailVariantId(row.variantId)}
                      className="cursor-pointer hover:bg-bg-tertiary/50"
                    >
                      <td className="px-3 py-2 font-medium text-text-primary">
                        {row.displayName}
                      </td>
                      <td className="px-3 py-2">
                        {formatScore(row.intelligenceScore)}
                      </td>
                      <td className="px-3 py-2 font-semibold text-accent">
                        {formatUsd(est.perTaskUsd, 4)}
                      </td>
                      <td className="px-3 py-2">{formatUsd(est.dailyUsd)}</td>
                      <td className="px-3 py-2">{formatUsd(est.monthlyUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
