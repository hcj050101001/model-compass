"use client";

import { useMemo, useState } from "react";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronRight } from "lucide-react";
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

interface LeaderboardTableProps {
  rows: MeasurementRow[];
  globalFrontierIds: Set<string>;
  onClearFilters?: () => void;
}

const columnHelper = createColumnHelper<MeasurementRow>();

export function LeaderboardTable({
  rows,
  globalFrontierIds,
  onClearFilters,
}: LeaderboardTableProps) {
  const { locale, t } = useLocale();
  const store = useDashboardStore();
  const [sorting, setSorting] = useState<SortingState>([
    { id: "score", desc: true },
  ]);

  const costColumnLabel = t("simpleColCost");

  const columns = useMemo(
    () => [
      columnHelper.display({
        id: "rank",
        header: "#",
        cell: (info) => {
          const idx = info.table
            .getSortedRowModel()
            .flatRows.findIndex((r) => r.id === info.row.id);
          return (
            <span className="text-text-muted tabular-nums">
              {idx >= 0 ? idx + 1 : info.row.index + 1}
            </span>
          );
        },
      }),
      columnHelper.accessor("releaseName", {
        id: "model",
        header: t("colModel"),
        cell: (info) => {
          const r = info.row.original;
          const isBestValue = globalFrontierIds.has(r.id);
          const showEffort =
            r.effortNormalized && r.effortNormalized !== "Standard";
          return (
            <div className="flex flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium text-text-primary">
                  {r.releaseName}
                </span>
                {showEffort && (
                  <span className="rounded bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-secondary">
                    {r.effortNormalized}
                  </span>
                )}
                {isBestValue && (
                  <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-sky-400">
                    {t("simpleBestValueBadge")}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: r.creatorColor }}
                />
                <span>
                  {getCreatorDisplayName(r.creatorSlug, r.creatorName, locale)}
                </span>
              </div>
            </div>
          );
        },
      }),
      columnHelper.accessor((r) => r.intelligenceScore, {
        id: "score",
        header: t("simpleColScore"),
        cell: (info) => (
          <span className="font-semibold text-text-primary tabular-nums">
            {formatScore(info.getValue())}
          </span>
        ),
      }),
      columnHelper.accessor(
        (r) => getDeveloperAgentCost(r, store.taskProfile)?.totalUsd ?? null,
        {
          id: "activeCost",
          header: costColumnLabel,
          cell: (info) => (
            <span className="tabular-nums text-text-secondary">
              {formatUsd(info.getValue())}
            </span>
          ),
        }
      ),
      columnHelper.accessor("outputTokensPerSecond", {
        header: t("simpleColSpeed"),
        cell: (info) => (
          <span className="tabular-nums text-text-muted">
            {formatSpeed(info.getValue())}
          </span>
        ),
      }),
    ],
    [globalFrontierIds, locale, t, store.taskProfile, costColumnLabel]
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: {
      pagination: { pageSize: 15 },
    },
  });

  const pageCount = table.getPageCount();
  const sortedRows = table.getSortedRowModel().flatRows;
  const mobileSortOptions = [
    { id: "score", label: t("simpleColScore") },
    { id: "activeCost", label: costColumnLabel },
    { id: "outputTokensPerSecond", label: t("simpleColSpeed") },
  ] as const;

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-bg-secondary">
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5 sm:px-4 sm:py-3">
        <h2 className="text-sm font-semibold text-text-primary">
          {t("simpleRankingTitle")} ({rows.length})
        </h2>
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-12 text-xs text-text-muted">
          <span>{t("simpleNoResults")}</span>
          {onClearFilters && (
            <button
              type="button"
              onClick={onClearFilters}
              className="rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-text-primary hover:border-accent"
            >
              {t("simpleResetFilter")}
            </button>
          )}
        </div>
      ) : (
        <>
          {/* Mobile Sort Bar + Card List */}
          <div className="block md:hidden">
            <div className="flex items-center justify-between gap-2 border-b border-border bg-bg-tertiary/40 px-3 py-2 text-xs">
              <span className="shrink-0 text-[11px] font-medium text-text-muted">
                {t("mobileSortBy")}
              </span>
              <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
                {mobileSortOptions.map((opt) => {
                  const col = table.getColumn(opt.id);
                  const dir = col?.getIsSorted();
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => col?.toggleSorting(dir === "asc")}
                      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition active:scale-95 ${
                        dir
                          ? "border-accent bg-accent/15 text-accent"
                          : "border-border bg-bg-secondary text-text-secondary"
                      }`}
                    >
                      <span>{opt.label}</span>
                      {dir === "asc" ? (
                        <ArrowUp className="h-3 w-3" />
                      ) : dir === "desc" ? (
                        <ArrowDown className="h-3 w-3" />
                      ) : (
                        <ArrowUpDown className="h-3 w-3 opacity-50" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="divide-y divide-border">
              {table.getRowModel().rows.map((row) => {
                const r = row.original;
                const rankIndex = sortedRows.findIndex((sr) => sr.id === row.id);
                const rank = rankIndex >= 0 ? rankIndex + 1 : row.index + 1;
                const isBestValue = globalFrontierIds.has(r.id);
                const showEffort =
                  r.effortNormalized && r.effortNormalized !== "Standard";
                const costVal =
                  getDeveloperAgentCost(r, store.taskProfile)?.totalUsd ?? null;

                return (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => store.setActiveDetailVariantId(r.variantId)}
                    className="flex w-full flex-col gap-2 px-3 py-3 text-left transition active:bg-bg-tertiary/60"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span
                            className={`inline-flex h-5 min-w-[22px] items-center justify-center rounded px-1 text-[11px] font-semibold tabular-nums ${
                              rank <= 3
                                ? "bg-accent/15 text-accent"
                                : "bg-bg-tertiary text-text-muted"
                            }`}
                          >
                            #{rank}
                          </span>
                          <span className="truncate text-sm font-semibold text-text-primary">
                            {r.releaseName}
                          </span>
                          {showEffort && (
                            <span className="rounded bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
                              {r.effortNormalized}
                            </span>
                          )}
                          {isBestValue && (
                            <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-sky-400">
                              {t("simpleBestValueBadge")}
                            </span>
                          )}
                        </div>

                        <div className="mt-1 flex items-center gap-1.5 pl-0.5 text-[11px] text-text-muted">
                          <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ backgroundColor: r.creatorColor }}
                          />
                          <span>
                            {getCreatorDisplayName(
                              r.creatorSlug,
                              r.creatorName,
                              locale
                            )}
                          </span>
                        </div>
                      </div>

                      <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
                    </div>

                    <div className="grid grid-cols-3 gap-2 rounded-lg bg-bg-primary/55 px-2.5 py-2 text-xs">
                      <div>
                        <div className="text-[10px] text-text-muted">
                          {t("simpleColScore")}
                        </div>
                        <div className="mt-0.5 font-bold tabular-nums text-text-primary">
                          {formatScore(r.intelligenceScore)}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-text-muted">
                          {costColumnLabel}
                        </div>
                        <div className="mt-0.5 font-medium tabular-nums text-text-secondary">
                          {formatUsd(costVal)}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-text-muted">
                          {t("simpleColSpeed")}
                        </div>
                        <div className="mt-0.5 font-medium tabular-nums text-text-muted">
                          {formatSpeed(r.outputTokensPerSecond)}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Desktop Table View */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-border bg-bg-tertiary/60 text-text-muted">
                {table.getHeaderGroups().map((hg) => (
                  <tr key={hg.id}>
                    {hg.headers.map((header) => {
                      const canSort = header.column.getCanSort();
                      const sortedDir = header.column.getIsSorted();
                      const isNumeric =
                        header.id === "score" ||
                        header.id === "activeCost" ||
                        header.id === "outputTokensPerSecond";
                      return (
                        <th
                          key={header.id}
                          onClick={
                            canSort
                              ? header.column.getToggleSortingHandler()
                              : undefined
                          }
                          className={`whitespace-nowrap px-4 py-2.5 font-semibold ${
                            isNumeric ? "text-right" : ""
                          } ${
                            canSort
                              ? "cursor-pointer select-none hover:text-text-primary"
                              : ""
                          }`}
                        >
                          <span className="inline-flex items-center gap-1">
                            {flexRender(
                              header.column.columnDef.header,
                              header.getContext()
                            )}
                            {canSort &&
                              (sortedDir === "asc" ? (
                                <ArrowUp className="h-3 w-3 text-accent" />
                              ) : sortedDir === "desc" ? (
                                <ArrowDown className="h-3 w-3 text-accent" />
                              ) : (
                                <ArrowUpDown className="h-3 w-3 opacity-60" />
                              ))}
                          </span>
                        </th>
                      );
                    })}
                  </tr>
                ))}
              </thead>
              <tbody className="divide-y divide-border">
                {table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    onMouseEnter={() =>
                      store.setHoveredReleaseId(row.original.releaseId)
                    }
                    onMouseLeave={() => store.setHoveredReleaseId(null)}
                    onClick={() =>
                      store.setActiveDetailVariantId(row.original.variantId)
                    }
                    className="cursor-pointer transition hover:bg-bg-tertiary/50"
                  >
                    {row.getVisibleCells().map((cell) => {
                      const isNumeric =
                        cell.column.id === "score" ||
                        cell.column.id === "activeCost" ||
                        cell.column.id === "outputTokensPerSecond";
                      return (
                        <td
                          key={cell.id}
                          className={`whitespace-nowrap px-4 py-3 ${
                            isNumeric ? "text-right" : ""
                          }`}
                        >
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext()
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {pageCount > 1 && (
            <div className="flex items-center justify-between border-t border-border px-3 py-2.5 text-xs text-text-muted sm:px-4">
              <span>
                {t("pageOf", {
                  page: table.getState().pagination.pageIndex + 1,
                  total: pageCount,
                })}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => table.previousPage()}
                  disabled={!table.getCanPreviousPage()}
                  className="min-h-[36px] rounded-lg border border-border px-3 py-1.5 transition hover:border-accent disabled:opacity-40 sm:min-h-0 sm:rounded-md sm:px-2.5 sm:py-1"
                >
                  {t("prevPage")}
                </button>
                <button
                  type="button"
                  onClick={() => table.nextPage()}
                  disabled={!table.getCanNextPage()}
                  className="min-h-[36px] rounded-lg border border-border px-3 py-1.5 transition hover:border-accent disabled:opacity-40 sm:min-h-0 sm:rounded-md sm:px-2.5 sm:py-1"
                >
                  {t("nextPage")}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
