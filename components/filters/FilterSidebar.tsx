"use client";

import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  RotateCcw,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import type { MeasurementRow } from "@/lib/analytics/types";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { useDashboardStore } from "@/lib/store/dashboard";

interface FilterSidebarProps {
  rows: MeasurementRow[];
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

export function FilterSidebar({
  rows,
  mobileOpen,
  onCloseMobile,
}: FilterSidebarProps) {
  const { t } = useLocale();
  const store = useDashboardStore();
  const [creatorSearch, setCreatorSearch] = useState("");
  const [expandedCreators, setExpandedCreators] = useState<Record<string, boolean>>({});

  const creators = useMemo(() => {
    const map = new Map<
      string,
      {
        slug: string;
        name: string;
        color: string;
        count: number;
        releases: Map<string, { id: string; name: string; count: number }>;
      }
    >();
    for (const r of rows) {
      let c = map.get(r.creatorSlug);
      if (!c) {
        c = {
          slug: r.creatorSlug,
          name: r.creatorName,
          color: r.creatorColor,
          count: 0,
          releases: new Map(),
        };
        map.set(r.creatorSlug, c);
      }
      c.count += 1;
      const rel = c.releases.get(r.releaseId) ?? {
        id: r.releaseId,
        name: r.releaseName,
        count: 0,
      };
      rel.count += 1;
      c.releases.set(r.releaseId, rel);
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }, [rows]);

  const efforts = useMemo(() => {
    const set = new Map<string, number>();
    for (const r of rows) {
      const key = r.effortNormalized ?? "Standard";
      set.set(key, r.effortOrder ?? 999);
    }
    return Array.from(set.entries())
      .sort((a, b) => a[1] - b[1])
      .map(([name]) => name);
  }, [rows]);

  const filteredCreators = creators.filter((c) =>
    c.name.toLowerCase().includes(creatorSearch.toLowerCase())
  );

  const content = (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-3 text-xs">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 font-semibold text-text-primary">
          <SlidersHorizontal className="h-3.5 w-3.5 text-accent" />
          <span>{t("filters")}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={store.resetFilters}
            className="flex items-center gap-1 text-[11px] text-text-muted hover:text-accent"
          >
            <RotateCcw className="h-3 w-3" />
            {t("reset")}
          </button>
          <button
            type="button"
            onClick={onCloseMobile}
            className="lg:hidden rounded p-1 text-text-muted hover:text-text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Model Search */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-text-muted" />
        <input
          type="text"
          value={store.searchQuery}
          onChange={(e) => store.setSearchQuery(e.target.value)}
          placeholder={t("searchPlaceholder")}
          className="w-full rounded-md border border-border bg-bg-primary py-1.5 pl-8 pr-2.5 text-xs text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
      </div>

      {/* Quick Toggles */}
      <div className="space-y-1.5 rounded-md border border-border bg-bg-primary/50 p-2.5">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          {t("quickFilters")}
        </div>
        {[
          {
            label: t("paretoOnly"),
            checked: store.paretoOnly,
            onChange: store.setParetoOnly,
          },
          {
            label: t("reasoningOnly"),
            checked: store.reasoningOnly,
            onChange: store.setReasoningOnly,
          },
          {
            label: t("openWeightsOnly"),
            checked: store.openWeightsOnly,
            onChange: store.setOpenWeightsOnly,
          },
          {
            label: `${t("favoritesOnly")} (${store.favoriteIds.length})`,
            checked: store.favoritesOnly,
            onChange: store.setFavoritesOnly,
          },
        ].map((item) => (
          <label
            key={item.label}
            className="flex cursor-pointer items-center justify-between py-0.5 text-text-secondary hover:text-text-primary"
          >
            <span>{item.label}</span>
            <input
              type="checkbox"
              checked={item.checked}
              onChange={(e) => item.onChange(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-border accent-accent"
            />
          </label>
        ))}
      </div>

      {/* Numeric Thresholds */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="mb-1 block text-[11px] text-text-muted">
            {t("minScore")}
          </label>
          <input
            type="number"
            step="1"
            value={store.minScore ?? ""}
            onChange={(e) =>
              store.setMinScore(
                e.target.value === "" ? null : Number(e.target.value)
              )
            }
            placeholder="e.g. 50"
            className="w-full rounded-md border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary focus:border-accent focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-[11px] text-text-muted">
            {t("maxCost")}
          </label>
          <input
            type="number"
            step="0.1"
            min="0"
            value={store.maxCost ?? ""}
            onChange={(e) =>
              store.setMaxCost(
                e.target.value === "" ? null : Number(e.target.value)
              )
            }
            placeholder="e.g. 2.0"
            className="w-full rounded-md border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary focus:border-accent focus:outline-none"
          />
        </div>
      </div>

      {/* Release Date */}
      <div>
        <label className="mb-1 block text-[11px] text-text-muted">
          {t("releasedAfter")}
        </label>
        <input
          type="date"
          value={store.releaseDateFrom}
          onChange={(e) => store.setReleaseDateFrom(e.target.value)}
          className="w-full rounded-md border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary focus:border-accent focus:outline-none"
        />
      </div>

      {/* Effort Levels */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            {t("reasoningEffort")}
          </span>
          {store.selectedEfforts.length > 0 && (
            <button
              type="button"
              onClick={() => store.setSelectedEfforts([])}
              className="text-[11px] text-accent hover:underline"
            >
              {t("all")}
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {efforts.map((eff) => {
            const active =
              store.selectedEfforts.length === 0 ||
              store.selectedEfforts.includes(eff);
            return (
              <button
                key={eff}
                type="button"
                onClick={() => store.toggleEffort(eff)}
                className={`rounded px-2 py-0.5 text-[11px] font-medium border transition ${
                  active
                    ? "border-accent/60 bg-accent/15 text-accent"
                    : "border-border bg-bg-primary text-text-muted opacity-60"
                }`}
              >
                {eff}
              </button>
            );
          })}
        </div>
      </div>

      {/* Creators & Model Tree */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            {t("creatorsAndModels")}
          </span>
          <div className="flex gap-2 text-[11px]">
            <button
              type="button"
              onClick={() => store.setSelectedCreators([])}
              className="text-accent hover:underline"
            >
              {t("all")}
            </button>
            <button
              type="button"
              onClick={() => store.setSelectedCreators(["__none__"])}
              className="text-text-muted hover:text-text-primary"
            >
              {t("clear")}
            </button>
          </div>
        </div>

        <input
          type="text"
          value={creatorSearch}
          onChange={(e) => setCreatorSearch(e.target.value)}
          placeholder={t("filterCreators")}
          className="w-full rounded-md border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
        />

        <div className="space-y-1">
          {filteredCreators.map((c) => {
            const isSelected =
              store.selectedCreators.length === 0 ||
              store.selectedCreators.includes(c.slug);
            const isExpanded = Boolean(expandedCreators[c.slug]);

            return (
              <div
                key={c.slug}
                className="rounded-md border border-border/60 bg-bg-primary/40"
              >
                <div className="flex items-center justify-between px-2 py-1.5">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedCreators((prev) => ({
                          ...prev,
                          [c.slug]: !prev[c.slug],
                        }))
                      }
                      className="text-text-muted hover:text-text-primary"
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (store.selectedCreators.length === 0) {
                          store.setSelectedCreators(
                            creators
                              .map((x) => x.slug)
                              .filter((s) => s !== c.slug)
                          );
                        } else {
                          store.toggleCreator(c.slug);
                        }
                      }}
                      className="flex items-center gap-1.5 truncate text-left"
                    >
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{
                          backgroundColor: c.color,
                          opacity: isSelected ? 1 : 0.3,
                        }}
                      />
                      <span
                        className={`truncate font-medium ${
                          isSelected ? "text-text-primary" : "text-text-muted line-through"
                        }`}
                      >
                        {c.name}
                      </span>
                    </button>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => store.setSelectedCreators([c.slug])}
                      className="text-[10px] text-text-muted hover:text-accent"
                      title={t("only")}
                    >
                      {t("only")}
                    </button>
                    <span className="text-[10px] text-text-muted">{c.count}</span>
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t border-border/50 px-3 py-1.5 space-y-1">
                    {Array.from(c.releases.values()).map((rel) => {
                      const relSelected =
                        store.selectedReleaseIds.length === 0 ||
                        store.selectedReleaseIds.includes(rel.id);
                      return (
                        <label
                          key={rel.id}
                          className="flex cursor-pointer items-center justify-between text-[11px] text-text-secondary hover:text-text-primary"
                        >
                          <span className="truncate pr-2">{rel.name}</span>
                          <input
                            type="checkbox"
                            checked={relSelected}
                            onChange={() => {
                              if (store.selectedReleaseIds.length === 0) {
                                const allIds = rows
                                  .map((r) => r.releaseId)
                                  .filter((id, i, arr) => arr.indexOf(id) === i && id !== rel.id);
                                store.setSelectedReleaseIds(allIds);
                              } else {
                                store.toggleReleaseId(rel.id);
                              }
                            }}
                            className="h-3 w-3 rounded accent-accent"
                          />
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop sticky sidebar */}
      <aside className="hidden lg:block w-72 shrink-0 rounded-xl border border-border bg-bg-secondary self-start sticky top-16 max-h-[calc(100vh-5rem)] overflow-hidden">
        {content}
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm"
            onClick={onCloseMobile}
          />
          <aside className="relative z-10 h-full w-80 max-w-[85vw] border-r border-border bg-bg-secondary">
            {content}
          </aside>
        </div>
      )}
    </>
  );
}
