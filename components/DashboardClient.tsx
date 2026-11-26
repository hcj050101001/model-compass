"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Info, Sparkles, X } from "lucide-react";
import {
  DEVELOPER_TASK_PROFILES,
  type DeveloperTaskProfile,
} from "@/lib/agent-cost/developer-cost";
import { calculateParetoFrontier } from "@/lib/analytics/pareto";
import type { MeasurementRow } from "@/lib/analytics/types";
import { useDashboardStore } from "@/lib/store/dashboard";
import { useLocale } from "@/components/i18n/LocaleProvider";
import {
  formatScore,
  getCreatorDisplayName,
  getDeveloperAgentCost,
} from "@/lib/utils/format";
import { DemoBanner } from "./layout/DemoBanner";
import { Footer } from "./layout/Footer";
import { Header } from "./layout/Header";
import { FrontierChart } from "./charts/FrontierChart";
import { LeaderboardTable } from "./leaderboard/LeaderboardTable";
import { ModelDetailDrawer } from "./model-detail/ModelDetailDrawer";
import { LatexFormula } from "./ui/LatexFormula";

import {
  MAINSTREAM_PROVIDER_ORDER,
  MAINSTREAM_PROVIDER_SET,
} from "@/lib/analytics/homepage-providers";

interface DashboardClientProps {
  rows: MeasurementRow[];
  snapshot: {
    id: string;
    source: string;
    benchmarkVersion: string;
    fetchedAt: string;
    isDemo: boolean;
  } | null;
  isStale: boolean;
  privateMode: boolean;
}

export function DashboardClient({
  rows,
  snapshot,
  isStale,
  privateMode,
}: DashboardClientProps) {
  const { locale, t } = useLocale();
  const store = useDashboardStore();
  const [openProviderSlug, setOpenProviderSlug] = useState<string | null>(null);
  const [showFormulaInfo, setShowFormulaInfo] = useState(false);
  const pickerContainerRef = useRef<HTMLDivElement | null>(null);

  const indexVersion = snapshot?.benchmarkVersion ?? "5.0";

  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (
        pickerContainerRef.current &&
        !pickerContainerRef.current.contains(e.target as Node)
      ) {
        setOpenProviderSlug(null);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpenProviderSlug(null);
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  // Keep mainstream US & Chinese providers with valid intelligence score & unified Agent cost
  const mainstreamRows = useMemo(
    () =>
      rows.filter((r) => {
        if (!MAINSTREAM_PROVIDER_SET.has(r.creatorSlug)) return false;
        if (r.intelligenceScore === null) return false;
        const dev = getDeveloperAgentCost(r, store.taskProfile);
        return dev !== null && dev.totalUsd > 0;
      }),
    [rows, store.taskProfile]
  );

  // Global Pareto frontier on the single unified Developer Agent Cost metric
  const globalFrontier = useMemo(() => {
    const pts = mainstreamRows
      .map((r) => {
        const dev = getDeveloperAgentCost(r, store.taskProfile);
        const score = r.intelligenceScore;
        if (!dev || score === null || dev.totalUsd <= 0) return null;
        return {
          id: r.id,
          cost: dev.totalUsd,
          score,
          indexVersion: r.indexVersion,
          row: r,
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);

    return calculateParetoFrontier(pts, { indexVersion });
  }, [mainstreamRows, indexVersion, store.taskProfile]);

  const providers = useMemo(() => {
    const map = new Map<
      string,
      {
        slug: string;
        name: string;
        color: string;
        releases: Map<
          string,
          {
            id: string;
            name: string;
            bestScore: number | null;
            isBestValue: boolean;
            variantCount: number;
          }
        >;
      }
    >();

    for (const r of mainstreamRows) {
      let prov = map.get(r.creatorSlug);
      if (!prov) {
        prov = {
          slug: r.creatorSlug,
          name: getCreatorDisplayName(r.creatorSlug, r.creatorName, locale),
          color: r.creatorColor,
          releases: new Map(),
        };
        map.set(r.creatorSlug, prov);
      }
      const score = r.intelligenceScore;
      const isFrontier = globalFrontier.frontierIds.has(r.id);
      const rel = prov.releases.get(r.releaseId);
      if (!rel) {
        prov.releases.set(r.releaseId, {
          id: r.releaseId,
          name: r.releaseName,
          bestScore: score,
          isBestValue: isFrontier,
          variantCount: 1,
        });
      } else {
        rel.variantCount += 1;
        if (
          score !== null &&
          (rel.bestScore === null || score > rel.bestScore)
        ) {
          rel.bestScore = score;
        }
        if (isFrontier) rel.isBestValue = true;
      }
    }

    return MAINSTREAM_PROVIDER_ORDER.map((slug) => map.get(slug))
      .filter((p): p is NonNullable<typeof p> => Boolean(p))
      .map((p) => ({
        slug: p.slug,
        name: p.name,
        color: p.color,
        releases: Array.from(p.releases.values()).sort(
          (a, b) => (b.bestScore ?? -1) - (a.bestScore ?? -1)
        ),
      }));
  }, [mainstreamRows, locale, globalFrontier.frontierIds]);

  const releaseLookup = useMemo(() => {
    const map = new Map<
      string,
      { id: string; name: string; creatorName: string; creatorColor: string }
    >();
    for (const r of mainstreamRows) {
      if (!map.has(r.releaseId)) {
        map.set(r.releaseId, {
          id: r.releaseId,
          name: r.releaseName,
          creatorName: getCreatorDisplayName(
            r.creatorSlug,
            r.creatorName,
            locale
          ),
          creatorColor: r.creatorColor,
        });
      }
    }
    return map;
  }, [mainstreamRows, locale]);

  const selectedReleaseSet = useMemo(
    () => new Set(store.selectedReleaseIds),
    [store.selectedReleaseIds]
  );

  const tableRows = useMemo(() => {
    return mainstreamRows.filter((r) => {
      if (store.paretoOnly && selectedReleaseSet.size > 0) {
        const inPareto = globalFrontier.frontierIds.has(r.id);
        const inSelected = selectedReleaseSet.has(r.releaseId);
        if (!inPareto && !inSelected) return false;
      } else if (store.paretoOnly) {
        if (!globalFrontier.frontierIds.has(r.id)) return false;
      } else if (selectedReleaseSet.size > 0) {
        if (!selectedReleaseSet.has(r.releaseId)) return false;
      }
      return true;
    });
  }, [
    mainstreamRows,
    selectedReleaseSet,
    store.paretoOnly,
    globalFrontier.frontierIds,
  ]);

  const hasChartSelection =
    store.paretoOnly || selectedReleaseSet.size > 0;

  const chartRows = useMemo(() => {
    if (!hasChartSelection) return [];
    return tableRows;
  }, [hasChartSelection, tableRows]);

  const hasActiveFilter = selectedReleaseSet.size > 0;

  function handleClearFilters() {
    store.setSearchQuery("");
    store.setSelectedReleaseIds([]);
    store.setSelectedCreators([]);
    store.setParetoOnly(false);
    setOpenProviderSlug(null);
  }

  const activeProvider = useMemo(
    () => providers.find((p) => p.slug === openProviderSlug) ?? null,
    [providers, openProviderSlug]
  );

  useEffect(() => {
    if (!activeProvider) return;
    if (typeof window === "undefined" || window.innerWidth >= 640) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [activeProvider]);

  return (
    <div className="min-h-screen flex flex-col bg-bg-primary text-text-primary">
      <DemoBanner
        isDemo={snapshot?.isDemo ?? true}
        isStale={isStale}
        fetchedAt={snapshot?.fetchedAt}
      />
      <Header
        fetchedAt={snapshot?.fetchedAt}
        isDemo={snapshot?.isDemo}
        indexVersion={indexVersion}
        privateMode={privateMode}
      />

      <main className="mx-auto w-full max-w-5xl flex-1 space-y-3.5 px-3 py-3.5 sm:space-y-4 sm:px-4 sm:py-5">
        {/* Provider & Quick Filter Bar */}
        <section ref={pickerContainerRef} className="relative space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => store.setParetoOnly(!store.paretoOnly)}
                className={`flex h-9 items-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition active:scale-[0.98] sm:rounded-lg ${
                  store.paretoOnly
                    ? "border-accent bg-accent/15 text-accent"
                    : "border-border bg-bg-secondary text-text-secondary hover:border-accent/60 hover:text-text-primary"
                }`}
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span>{t("simpleBestValueOnly")}</span>
              </button>

              {hasActiveFilter && (
                <button
                  type="button"
                  onClick={handleClearFilters}
                  className="h-9 rounded-xl border border-border bg-bg-secondary px-3 text-xs text-text-muted transition hover:text-text-primary active:scale-[0.98] sm:rounded-lg"
                >
                  {t("simpleResetFilter")}
                </button>
              )}
            </div>
          </div>

          {/* Mainstream Provider Dropdown Triggers */}
          <div className="no-scrollbar -mx-3 flex flex-nowrap items-center gap-1.5 overflow-x-auto px-3 pb-0.5 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
            {providers.map((p) => {
              const isOpen = openProviderSlug === p.slug;
              const selectedCount = p.releases.filter((rel) =>
                selectedReleaseSet.has(rel.id)
              ).length;
              return (
                <button
                  key={p.slug}
                  type="button"
                  onClick={() => {
                    setOpenProviderSlug(isOpen ? null : p.slug);
                  }}
                  className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition active:scale-[0.97] sm:px-2.5 sm:py-1 ${
                    isOpen || selectedCount > 0
                      ? "border-accent bg-accent/15 text-accent"
                      : "border-border bg-bg-secondary text-text-secondary hover:border-accent/50 hover:text-text-primary"
                  }`}
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: p.color }}
                  />
                  <span>{p.name}</span>
                  {selectedCount > 0 && (
                    <span className="rounded-full bg-accent px-1.5 py-0 text-[10px] font-bold text-slate-950">
                      {selectedCount}
                    </span>
                  )}
                  <ChevronDown
                    className={`h-3 w-3 opacity-70 transition-transform ${
                      isOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>
              );
            })}
          </div>

          {/* Provider Model Picker */}
          {activeProvider && (
            <>
              <div
                className="animate-fade-in fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px] sm:hidden"
                onClick={() => setOpenProviderSlug(null)}
              />
              <div className="animate-sheet-up fixed inset-x-0 bottom-0 z-50 flex max-h-[78dvh] flex-col rounded-t-2xl border-t border-border bg-bg-secondary p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl sm:animate-none sm:absolute sm:inset-auto sm:left-0 sm:top-full sm:z-30 sm:mt-1.5 sm:max-h-[420px] sm:w-full sm:max-w-md sm:rounded-xl sm:border sm:p-3 sm:pb-3">
                <div className="mx-auto mb-2.5 h-1 w-10 shrink-0 rounded-full bg-border sm:hidden" />
                <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border pb-2.5 sm:pb-2">
                  <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-text-primary sm:text-xs">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: activeProvider.color }}
                    />
                    <span className="truncate">{activeProvider.name}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-xs sm:text-[11px]">
                    {activeProvider.releases.some((rel) =>
                      selectedReleaseSet.has(rel.id)
                    ) && (
                      <button
                        type="button"
                        onClick={() => {
                          const providerIds = new Set(
                            activeProvider.releases.map((rel) => rel.id)
                          );
                          store.setSelectedReleaseIds(
                            store.selectedReleaseIds.filter(
                              (id) => !providerIds.has(id)
                            )
                          );
                        }}
                        className="px-1.5 py-1 text-text-muted hover:text-rose-400"
                      >
                        {t("simpleClearProvider")}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setOpenProviderSlug(null)}
                      aria-label="Close"
                      className="rounded-md p-1.5 text-text-muted hover:bg-bg-tertiary hover:text-text-primary sm:p-0.5"
                    >
                      <X className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                    </button>
                  </div>
                </div>

                <div className="mt-2 flex-1 space-y-1 overflow-y-auto pr-1 sm:max-h-72">
                  {activeProvider.releases.map((rel) => {
                    const checked = selectedReleaseSet.has(rel.id);
                    return (
                      <button
                        key={rel.id}
                        type="button"
                        onClick={() => store.toggleReleaseId(rel.id)}
                        className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2.5 text-left text-xs transition sm:py-1.5 ${
                          checked
                            ? "bg-accent/15 text-text-primary"
                            : "text-text-secondary hover:bg-bg-tertiary"
                        }`}
                      >
                        <div className="flex min-w-0 items-center gap-2.5 sm:gap-2">
                          <span
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                              checked
                                ? "border-accent bg-accent text-slate-950"
                                : "border-border bg-bg-primary"
                            }`}
                          >
                            {checked && <Check className="h-3 w-3 stroke-[3]" />}
                          </span>
                          <span className="truncate text-sm font-medium sm:text-xs">
                            {rel.name}
                          </span>
                          {rel.isBestValue && (
                            <span className="shrink-0 rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-sky-400">
                              {t("simpleBestValueBadge")}
                            </span>
                          )}
                        </div>
                        <span className="shrink-0 text-xs tabular-nums text-text-muted sm:text-[11px]">
                          {formatScore(rel.bestScore)}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <button
                  type="button"
                  onClick={() => setOpenProviderSlug(null)}
                  className="mt-3 w-full shrink-0 rounded-xl bg-accent py-2.5 text-sm font-semibold text-slate-950 active:scale-[0.99] sm:hidden"
                >
                  {t("mobileDone")}
                </button>
              </div>
            </>
          )}

          {/* Selected Models Chips */}
          {store.selectedReleaseIds.length > 0 && (
            <div className="no-scrollbar -mx-3 flex flex-nowrap items-center gap-1.5 overflow-x-auto px-3 pt-0.5 text-xs sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
              <span className="shrink-0 text-[11px] text-text-muted">
                {t("simpleSelectedModels")}:
              </span>
              {store.selectedReleaseIds.map((id) => {
                const info = releaseLookup.get(id);
                if (!info) return null;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => store.toggleReleaseId(id)}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1 text-[11px] text-text-primary hover:border-rose-400/60 sm:py-0.5"
                  >
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: info.creatorColor }}
                    />
                    <span>{info.name}</span>
                    <X className="h-3 w-3 text-text-muted" />
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* Unified Task Scale & Cost Algorithm Bar */}
        <section className="rounded-xl border border-border bg-bg-secondary px-3 py-2.5 space-y-2">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center">
              <span className="text-[11px] font-medium text-text-muted sm:mr-1">
                {locale === "zh" ? "任务量级：" : "Task Scale:"}
              </span>
              <div className="grid grid-cols-3 gap-1.5 sm:flex sm:flex-wrap sm:items-center">
                {(["light", "standard", "heavy"] as DeveloperTaskProfile[]).map(
                  (profileId) => {
                    const spec = DEVELOPER_TASK_PROFILES[profileId];
                    const active = store.taskProfile === profileId;
                    return (
                      <button
                        key={profileId}
                        type="button"
                        onClick={() => store.setTaskProfile(profileId)}
                        className={`rounded-lg border px-2 py-1.5 text-center text-[11px] font-medium transition sm:px-2.5 sm:py-1 ${
                          active
                            ? "border-accent bg-accent/15 text-accent"
                            : "border-border bg-bg-primary text-text-secondary hover:border-accent/50 hover:text-text-primary"
                        }`}
                      >
                        {locale === "zh" ? spec.labelZh : spec.labelEn}
                      </button>
                    );
                  }
                )}
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 sm:justify-end">
              <div className="inline-flex rounded-lg border border-border bg-bg-primary p-0.5 text-[11px]">
                <button
                  type="button"
                  onClick={() => store.setScaleMode("log")}
                  className={`rounded-md px-2.5 py-1 font-medium transition sm:px-2 sm:py-0.5 ${
                    store.scaleMode === "log"
                      ? "bg-accent text-slate-950"
                      : "text-text-muted hover:text-text-primary"
                  }`}
                >
                  {locale === "zh" ? "对数" : "Log"}
                </button>
                <button
                  type="button"
                  onClick={() => store.setScaleMode("linear")}
                  className={`rounded-md px-2.5 py-1 font-medium transition sm:px-2 sm:py-0.5 ${
                    store.scaleMode === "linear"
                      ? "bg-accent text-slate-950"
                      : "text-text-muted hover:text-text-primary"
                  }`}
                >
                  {locale === "zh" ? "线性" : "Linear"}
                </button>
              </div>

              <button
                type="button"
                onClick={() => setShowFormulaInfo((v) => !v)}
                className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition sm:py-1 ${
                  showFormulaInfo
                    ? "border-accent bg-accent/15 text-accent"
                    : "border-border bg-bg-primary text-text-secondary hover:border-accent/50"
                }`}
              >
                <Info className="h-3 w-3" />
                <span>{locale === "zh" ? "计费算法" : "Cost Algorithm"}</span>
              </button>
            </div>
          </div>

          <p className="text-[11px] leading-relaxed text-text-muted">
            {store.scaleMode === "log"
              ? locale === "zh"
                ? "对数坐标：按倍数缩放（每格 10 倍），避免低价与高价模型挤在一起，适合全局对比。"
                : "Log scale: scales by multiples (10× per step) so low-cost and high-cost models stay clearly separated."
              : locale === "zh"
                ? "线性坐标：按实际金额等距排列，直观感受真实价格差（低价模型会集中在左侧）。"
                : "Linear scale: equal spacing per dollar to show true price gaps (low-cost models cluster on the left)."}
          </p>

          {showFormulaInfo && (
            <div className="space-y-4 rounded-lg border border-border bg-bg-primary/60 p-3.5 text-[11px] leading-relaxed text-text-secondary">
              {locale === "zh" ? (
                <>
                  <div>
                    <div className="font-semibold text-text-primary">
                      1. 为什么用「平均上下文」而不是轮数来判定任务量级？
                    </div>
                    <p className="mt-1">
                      单看对话轮数很容易失真：如果每步只有 2K tokens，跑 20 轮总输入也才 40K；相反，科研文献综述或大型代码库分析哪怕只有 6 步，只要平均上下文达到 140K，总输入就达到 840K（21 倍）。因此，本平台采用
                      <strong className="text-text-primary">
                        上下文加权有效负载（Context-Weighted Effective Load）
                      </strong>
                      来划分任务量级：
                    </p>
                    <div className="mt-2 flex items-center justify-between gap-3 rounded-md border border-border/80 bg-bg-secondary px-3 py-2">
                      <LatexFormula
                        displayMode
                        tex={String.raw`C_{\text{eff}} = \overline{C} + 4 \cdot \overline{O}_{\text{turn}}, \qquad V_{\text{in}} = N \cdot \overline{C}`}
                      />
                      <span className="shrink-0 font-mono text-[10px] text-text-muted">(1)</span>
                    </div>
                    <p className="mt-1.5 text-text-muted">
                      其中输出单价通常约为输入的 4 倍，故输出权重取 4；分档采用双严格小于门槛：轻量需 <LatexFormula tex={String.raw`\overline{C} < 36\text{K}`} /> 且 <LatexFormula tex={String.raw`C_{\text{eff}} < 44\text{K}`} />，标准需 <LatexFormula tex={String.raw`\overline{C} < 110\text{K}`} /> 且 <LatexFormula tex={String.raw`C_{\text{eff}} < 120\text{K}`} />，其余为重度（e.g. 标准档 <LatexFormula tex={String.raw`\overline{C}=64\text{K},\,\overline{O}_{\text{turn}}=900 \Rightarrow C_{\text{eff}}=67.6\text{K}`} />）。
                    </p>
                  </div>

                  <div>
                    <div className="font-semibold text-text-primary">
                      2. 三档通用任务量级参数对照（mt-v2 多轮状态机）
                    </div>
                    <div className="mt-1.5 overflow-x-auto rounded border border-border">
                      <table className="w-full min-w-[500px] text-left text-[10.5px]">
                        <thead className="bg-bg-tertiary text-text-muted">
                          <tr>
                            <th className="px-2 py-1.5">量级</th>
                            <th className="px-2 py-1.5">平均上下文 <LatexFormula tex={String.raw`\overline{C}`} /></th>
                            <th className="px-2 py-1.5">初始 → 峰值</th>
                            <th className="px-2 py-1.5">步数 <LatexFormula tex={String.raw`N`} /></th>
                            <th className="px-2 py-1.5">典型适用场景</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          <tr>
                            <td className="px-2 py-1.5 font-medium text-text-primary">轻量</td>
                            <td className="px-2 py-1.5 tabular-nums">~20K</td>
                            <td className="px-2 py-1.5 tabular-nums">10K → 30K</td>
                            <td className="px-2 py-1.5 tabular-nums">6 步</td>
                            <td className="px-2 py-1.5">日常问答、单文件改动、短文献精读</td>
                          </tr>
                          <tr>
                            <td className="px-2 py-1.5 font-medium text-text-primary">标准</td>
                            <td className="px-2 py-1.5 tabular-nums">~64K</td>
                            <td className="px-2 py-1.5 tabular-nums">24K → 104K</td>
                            <td className="px-2 py-1.5 tabular-nums">11 步</td>
                            <td className="px-2 py-1.5">科研检索综述、多文件开发、中型数据分析</td>
                          </tr>
                          <tr>
                            <td className="px-2 py-1.5 font-medium text-text-primary">重度</td>
                            <td className="px-2 py-1.5 tabular-nums">~160K</td>
                            <td className="px-2 py-1.5 tabular-nums">48K → 272K</td>
                            <td className="px-2 py-1.5 tabular-nums">17 步</td>
                            <td className="px-2 py-1.5">全库架构重构、长篇论文/实验全流程推理</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div>
                    <div className="font-semibold text-text-primary">
                      3. 前缀缓存、窗口压缩与思考深度计费公式
                    </div>
                    <ul className="mt-1 list-disc space-y-1 pl-4">
                      <li>
                        <strong className="text-text-primary">前缀缓存（Prompt Caching）：</strong>
                        主流生产级 Coding Agent 实测前缀缓存命中率通常在 <strong className="text-text-primary">80%–92%</strong>（如 Claude Code 约 92%、Cursor 多轮会话 84%–99%）。本平台对支持缓存折扣的厂商统一按 <strong className="text-text-primary">h = 90%</strong> 前缀命中计算，并区分显式缓存写入（如 Anthropic 按官方写价或 1.25× 输入单价）与自动前缀缓存（OpenAI / DeepSeek / Google 写入免费、仅读取打折）。
                      </li>
                      <li>
                        <strong className="text-text-primary">窗口压缩与缓存失效惩罚：</strong>
                        当累计上下文超过模型可用窗口 <LatexFormula tex={String.raw`W_{\text{use}} = \lfloor 0.8W \rfloor`} /> 时，触发上下文压缩（回落至 <LatexFormula tex={String.raw`\mathrm{round}(0.35 W_{\text{use}})`} /> 并计入 2,000 tokens 摘要输出），同时使先前前缀缓存失效并重新写入。
                      </li>
                      <li>
                        <strong className="text-text-primary">思考深度（推理 Token）：</strong>
                        按档位计入内部推理输出（Non-thinking 0、Minimal 300、Low 900、Medium 2,200、High 4,800、Very High/XHigh 8,000、Max 12,000 tokens/步），与可见回复同按官方输出单价 <LatexFormula tex={String.raw`P_{\text{out}}`} /> 计费。
                      </li>
                    </ul>
                    <div className="mt-2 space-y-2">
                      <div className="flex items-center justify-between gap-3 rounded-md border border-border/80 bg-bg-secondary px-3 py-2">
                        <LatexFormula
                          displayMode
                          tex={String.raw`C_{\text{read},t} = \mathrm{round}(h \cdot C_{t-1}), \quad U_{\text{in},t} = (C_{t-1} - C_{\text{read},t}) + \mathbb{I}_{\text{auto}} \Delta_t, \quad C_{\text{write},t} = \mathbb{I}_{\text{explicit}} \Delta_t`}
                        />
                        <span className="shrink-0 font-mono text-[10px] text-text-muted">(2)</span>
                      </div>
                      <div className="flex items-center justify-between gap-3 rounded-md border border-emerald-500/30 bg-bg-secondary px-3 py-2">
                        <LatexFormula
                          displayMode
                          tex={String.raw`\text{TotalCost} = \frac{U_{\text{in}} \cdot P_{\text{in}} + C_{\text{read}} \cdot P_{\text{cache\_read}} + C_{\text{write}} \cdot P_{\text{cache\_write}} + (O_{\text{vis}} + O_{\text{think}}) \cdot P_{\text{out}}}{10^6}`}
                        />
                        <span className="shrink-0 font-mono text-[10px] text-emerald-400">(3)</span>
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="font-semibold text-text-primary">
                      4. 公式符号表与算例对照（e.g. 标准 11 轮 · High 推理 · 128K 窗口 · $1/$4）
                    </div>
                    <div className="mt-1.5 overflow-x-auto rounded border border-border">
                      <table className="w-full min-w-[540px] text-left text-[10.5px]">
                        <thead className="bg-bg-tertiary text-text-muted">
                          <tr>
                            <th className="px-2 py-1.5">符号</th>
                            <th className="px-2 py-1.5">含义说明</th>
                            <th className="px-2 py-1.5">e.g. 算例数值与单项费用</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          <tr>
                            <td className="px-2 py-1.5"><LatexFormula tex={String.raw`U_{\text{in}},\, P_{\text{in}}`} /></td>
                            <td className="px-2 py-1.5">未命中缓存输入量与官方输入单价</td>
                            <td className="px-2 py-1.5 tabular-nums">e.g. 60,000 tokens × $1.00/1M = $0.0600</td>
                          </tr>
                          <tr>
                            <td className="px-2 py-1.5"><LatexFormula tex={String.raw`C_{\text{read}},\, P_{\text{cache\_read}}`} /></td>
                            <td className="px-2 py-1.5">命中前缀缓存重读量（h=90%）与读缓存单价</td>
                            <td className="px-2 py-1.5 tabular-nums">e.g. 540,000 tokens × $0.20/1M = $0.1080</td>
                          </tr>
                          <tr>
                            <td className="px-2 py-1.5"><LatexFormula tex={String.raw`C_{\text{write}},\, P_{\text{cache\_write}}`} /></td>
                            <td className="px-2 py-1.5">显式写缓存量与写缓存价（自动缓存为 0）</td>
                            <td className="px-2 py-1.5 tabular-nums">e.g. 139,840 tokens × $1.25/1M = $0.1748</td>
                          </tr>
                          <tr>
                            <td className="px-2 py-1.5"><LatexFormula tex={String.raw`O_{\text{vis}} + O_{\text{think}},\, P_{\text{out}}`} /></td>
                            <td className="px-2 py-1.5">可见输出（含 2K 压缩摘要）+ 推理思考量与输出单价</td>
                            <td className="px-2 py-1.5 tabular-nums">e.g. (11,900 + 52,800) × $4.00/1M = $0.2588</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <p className="mt-1.5 rounded border border-border/70 bg-bg-secondary/70 px-2.5 py-1.5 text-[10.5px] text-text-muted">
                      <strong className="text-text-primary">算例合计（e.g.）：</strong>
                      显式缓存 + 128K 窗口单次任务约 <span className="font-mono text-emerald-400">$0.6016</span>（无缓存对照为 $0.9986；若使用 1M 大窗口免除第 11 轮压缩重写则为 $0.5488，单次压缩导致成本增加 +9.6%）。
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <div className="font-semibold text-text-primary">
                      1. Why Average Context Window Instead of Turn Count?
                    </div>
                    <p className="mt-1">
                      Turn count alone is misleading: a 20-turn session with a 2K-token context uses only 40K total input tokens, whereas scientific literature synthesis or large-repo analysis with 140K average context reaches 840K (21×) in just 6 steps. We classify task scale using{" "}
                      <strong className="text-text-primary">
                        Context-Weighted Effective Load
                      </strong>
                      :
                    </p>
                    <div className="mt-2 flex items-center justify-between gap-3 rounded-md border border-border/80 bg-bg-secondary px-3 py-2">
                      <LatexFormula
                        displayMode
                        tex={String.raw`C_{\text{eff}} = \overline{C} + 4 \cdot \overline{O}_{\text{turn}}, \qquad V_{\text{in}} = N \cdot \overline{C}`}
                      />
                      <span className="shrink-0 font-mono text-[10px] text-text-muted">(1)</span>
                    </div>
                    <p className="mt-1.5 text-text-muted">
                      Output tokens are weighted 4× to reflect typical API price ratios. Tiers use dual strictly less-than thresholds: Light requires <LatexFormula tex={String.raw`\overline{C} < 36\text{K}`} /> and <LatexFormula tex={String.raw`C_{\text{eff}} < 44\text{K}`} />, Standard requires <LatexFormula tex={String.raw`\overline{C} < 110\text{K}`} /> and <LatexFormula tex={String.raw`C_{\text{eff}} < 120\text{K}`} />, and everything else is Heavy (e.g. Standard <LatexFormula tex={String.raw`\overline{C}=64\text{K},\,\overline{O}_{\text{turn}}=900 \Rightarrow C_{\text{eff}}=67.6\text{K}`} />).
                    </p>
                  </div>

                  <div>
                    <div className="font-semibold text-text-primary">
                      2. Universal Task Scale Parameters (mt-v2 State Machine)
                    </div>
                    <div className="mt-1.5 overflow-x-auto rounded border border-border">
                      <table className="w-full min-w-[500px] text-left text-[10.5px]">
                        <thead className="bg-bg-tertiary text-text-muted">
                          <tr>
                            <th className="px-2 py-1.5">Scale</th>
                            <th className="px-2 py-1.5">Avg Context <LatexFormula tex={String.raw`\overline{C}`} /></th>
                            <th className="px-2 py-1.5">Start → Peak</th>
                            <th className="px-2 py-1.5">Steps <LatexFormula tex={String.raw`N`} /></th>
                            <th className="px-2 py-1.5">Typical Tasks</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          <tr>
                            <td className="px-2 py-1.5 font-medium text-text-primary">Light</td>
                            <td className="px-2 py-1.5 tabular-nums">~20K</td>
                            <td className="px-2 py-1.5 tabular-nums">10K → 30K</td>
                            <td className="px-2 py-1.5 tabular-nums">6</td>
                            <td className="px-2 py-1.5">Quick Q&amp;A, single-file edits, short paper review</td>
                          </tr>
                          <tr>
                            <td className="px-2 py-1.5 font-medium text-text-primary">Standard</td>
                            <td className="px-2 py-1.5 tabular-nums">~64K</td>
                            <td className="px-2 py-1.5 tabular-nums">24K → 104K</td>
                            <td className="px-2 py-1.5 tabular-nums">11</td>
                            <td className="px-2 py-1.5">Research synthesis, multi-file tasks, data analysis</td>
                          </tr>
                          <tr>
                            <td className="px-2 py-1.5 font-medium text-text-primary">Heavy</td>
                            <td className="px-2 py-1.5 tabular-nums">~160K</td>
                            <td className="px-2 py-1.5 tabular-nums">48K → 272K</td>
                            <td className="px-2 py-1.5 tabular-nums">17</td>
                            <td className="px-2 py-1.5">Full-repo refactors, deep scientific workflows</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div>
                    <div className="font-semibold text-text-primary">
                      3. Prompt Caching, Compaction Penalty &amp; Thinking Depth
                    </div>
                    <ul className="mt-1 list-disc space-y-1 pl-4">
                      <li>
                        <strong className="text-text-primary">Prompt Caching:</strong>{" "}
                        Production coding agents routinely observe <strong className="text-text-primary">80%–92%</strong> prefix cache hit rates (e.g. Claude Code ~92%, Cursor 84%–99%). Where cache discounts are supported, we apply a <strong className="text-text-primary">h = 90%</strong> hit rate, distinguishing explicit cache writes (e.g. Anthropic official write price or 1.25× input) from automatic prefix caching (OpenAI / DeepSeek / Google zero-surcharge writes).
                      </li>
                      <li>
                        <strong className="text-text-primary">Compaction &amp; Cache Invalidation:</strong>{" "}
                        Exceeding <LatexFormula tex={String.raw`W_{\text{use}} = \lfloor 0.8W \rfloor`} /> triggers compaction (shrinking to <LatexFormula tex={String.raw`\mathrm{round}(0.35 W_{\text{use}})`} /> + 2,000 summary output tokens) and invalidates the prefix cache, penalizing small-context models on heavy tasks.
                      </li>
                      <li>
                        <strong className="text-text-primary">Thinking Tokens:</strong>{" "}
                        Reasoning tiers add per-turn thinking tokens (Non-thinking 0, Minimal 300, Low 900, Medium 2,200, High 4,800, Very High/XHigh 8,000, Max 12,000) billed at <LatexFormula tex={String.raw`P_{\text{out}}`} />.
                      </li>
                    </ul>
                    <div className="mt-2 space-y-2">
                      <div className="flex items-center justify-between gap-3 rounded-md border border-border/80 bg-bg-secondary px-3 py-2">
                        <LatexFormula
                          displayMode
                          tex={String.raw`C_{\text{read},t} = \mathrm{round}(h \cdot C_{t-1}), \quad U_{\text{in},t} = (C_{t-1} - C_{\text{read},t}) + \mathbb{I}_{\text{auto}} \Delta_t, \quad C_{\text{write},t} = \mathbb{I}_{\text{explicit}} \Delta_t`}
                        />
                        <span className="shrink-0 font-mono text-[10px] text-text-muted">(2)</span>
                      </div>
                      <div className="flex items-center justify-between gap-3 rounded-md border border-emerald-500/30 bg-bg-secondary px-3 py-2">
                        <LatexFormula
                          displayMode
                          tex={String.raw`\text{TotalCost} = \frac{U_{\text{in}} \cdot P_{\text{in}} + C_{\text{read}} \cdot P_{\text{cache\_read}} + C_{\text{write}} \cdot P_{\text{cache\_write}} + (O_{\text{vis}} + O_{\text{think}}) \cdot P_{\text{out}}}{10^6}`}
                        />
                        <span className="shrink-0 font-mono text-[10px] text-emerald-400">(3)</span>
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="font-semibold text-text-primary">
                      4. Symbol Legend &amp; Worked Example (e.g. Standard 11-turn · High · 128K window · $1/$4)
                    </div>
                    <div className="mt-1.5 overflow-x-auto rounded border border-border">
                      <table className="w-full min-w-[540px] text-left text-[10.5px]">
                        <thead className="bg-bg-tertiary text-text-muted">
                          <tr>
                            <th className="px-2 py-1.5">Symbol</th>
                            <th className="px-2 py-1.5">Meaning</th>
                            <th className="px-2 py-1.5">e.g. Worked Breakdown</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          <tr>
                            <td className="px-2 py-1.5"><LatexFormula tex={String.raw`U_{\text{in}},\, P_{\text{in}}`} /></td>
                            <td className="px-2 py-1.5">Uncached input tokens &amp; base input rate</td>
                            <td className="px-2 py-1.5 tabular-nums">e.g. 60,000 tokens × $1.00/1M = $0.0600</td>
                          </tr>
                          <tr>
                            <td className="px-2 py-1.5"><LatexFormula tex={String.raw`C_{\text{read}},\, P_{\text{cache\_read}}`} /></td>
                            <td className="px-2 py-1.5">Cache-hit prefix reads (h=90%) &amp; read rate</td>
                            <td className="px-2 py-1.5 tabular-nums">e.g. 540,000 tokens × $0.20/1M = $0.1080</td>
                          </tr>
                          <tr>
                            <td className="px-2 py-1.5"><LatexFormula tex={String.raw`C_{\text{write}},\, P_{\text{cache\_write}}`} /></td>
                            <td className="px-2 py-1.5">Explicit cache writes &amp; write rate (0 if auto)</td>
                            <td className="px-2 py-1.5 tabular-nums">e.g. 139,840 tokens × $1.25/1M = $0.1748</td>
                          </tr>
                          <tr>
                            <td className="px-2 py-1.5"><LatexFormula tex={String.raw`O_{\text{vis}} + O_{\text{think}},\, P_{\text{out}}`} /></td>
                            <td className="px-2 py-1.5">Visible output (+2K summary) &amp; thinking at output rate</td>
                            <td className="px-2 py-1.5 tabular-nums">e.g. (11,900 + 52,800) × $4.00/1M = $0.2588</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <p className="mt-1.5 rounded border border-border/70 bg-bg-secondary/70 px-2.5 py-1.5 text-[10.5px] text-text-muted">
                      <strong className="text-text-primary">Worked Total (e.g.):</strong>{" "}
                      Explicit caching + 128K window yields <span className="font-mono text-emerald-400">$0.6016</span> (vs $0.9986 uncached, or $0.5488 on a 1M window with zero compaction — compaction adds +9.6%).
                    </p>
                  </div>
                </>
              )}
            </div>
          )}
        </section>

        <FrontierChart
          filteredRows={chartRows}
          globalFrontierIds={globalFrontier.frontierIds}
          globalFrontierPoints={globalFrontier.frontier}
        />

        <LeaderboardTable
          rows={tableRows}
          globalFrontierIds={globalFrontier.frontierIds}
          onClearFilters={hasActiveFilter ? handleClearFilters : undefined}
        />
      </main>

      <ModelDetailDrawer
        allRows={mainstreamRows}
        globalFrontierIds={globalFrontier.frontierIds}
      />

      <Footer
        indexVersion={indexVersion}
        source={snapshot?.source}
        isDemo={snapshot?.isDemo}
      />
    </div>
  );
}
