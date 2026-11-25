"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";
import { Maximize2, Minimize2, RotateCcw, RotateCw, ZoomIn, ZoomOut } from "lucide-react";
import type { MeasurementRow } from "@/lib/analytics/types";
import { hasEffortGap } from "@/lib/normalization/effort";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { useDashboardStore } from "@/lib/store/dashboard";
import {
  formatScore,
  formatSpeed,
  formatUsd,
  getCreatorDisplayName,
  getDeveloperAgentCost,
  getEffortShape,
} from "@/lib/utils/format";

interface FrontierChartProps {
  filteredRows: MeasurementRow[];
  globalFrontierIds: Set<string>;
  globalFrontierPoints: Array<{
    id: string;
    cost: number;
    score: number;
    row: MeasurementRow;
  }>;
}

interface Viewport {
  uMin: number; // log10(cost) min
  uMax: number; // log10(cost) max
  yMin: number;
  yMax: number;
}

const MIN_U = -4; // $0.0001
const MAX_U = 3; // $1000
const MIN_U_SPAN = 0.2;
const MAX_U_SPAN = 5.0;
const MIN_Y = 0;
const MAX_Y = 110;
const MIN_Y_SPAN = 4;
const MAX_Y_SPAN = 110;

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

// Tooltip colors come from upstream data (creator color); only constrained
// hex values may reach a style, anything else falls back to a fixed color.
const SAFE_HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function safeTooltipColor(value: unknown, fallback: string): string {
  return typeof value === "string" && SAFE_HEX_COLOR.test(value)
    ? value
    : fallback;
}

function clampViewport(v: Viewport): Viewport {
  const uSpan = clamp(v.uMax - v.uMin, MIN_U_SPAN, MAX_U_SPAN);
  let uMin = v.uMin;
  let uMax = uMin + uSpan;
  if (uMin < MIN_U) {
    uMin = MIN_U;
    uMax = Math.min(MAX_U, uMin + uSpan);
  } else if (uMax > MAX_U) {
    uMax = MAX_U;
    uMin = Math.max(MIN_U, uMax - uSpan);
  }

  const ySpan = clamp(v.yMax - v.yMin, MIN_Y_SPAN, MAX_Y_SPAN);
  let yMin = v.yMin;
  let yMax = yMin + ySpan;
  if (yMin < MIN_Y) {
    yMin = MIN_Y;
    yMax = Math.min(MAX_Y, yMin + ySpan);
  } else if (yMax > MAX_Y) {
    yMax = MAX_Y;
    yMin = Math.max(MIN_Y, yMax - ySpan);
  }

  return { uMin, uMax, yMin, yMax };
}

export function FrontierChart({
  filteredRows,
  globalFrontierIds,
  globalFrontierPoints,
}: FrontierChartProps) {
  const { locale, t } = useLocale();
  const store = useDashboardStore();
  const sectionRef = useRef<HTMLElement | null>(null);
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<echarts.ECharts | null>(null);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPortrait, setIsPortrait] = useState(false);
  const [containerWidth, setContainerWidth] = useState(800);
  const isCompact = containerWidth > 0 && containerWidth < 540;
  const gridMargins = useMemo(
    () =>
      isCompact
        ? { left: 38, right: 16, top: 32, bottom: 40 }
        : { left: 48, right: 104, top: 40, bottom: 48 },
    [isCompact]
  );
  const gridMarginsRef = useRef(gridMargins);
  gridMarginsRef.current = gridMargins;

  const [isDragging, setIsDragging] = useState(false);
  const didDragRef = useRef(false);

  const getCost = useCallback(
    (r: MeasurementRow) =>
      getDeveloperAgentCost(r, store.taskProfile)?.totalUsd ?? null,
    [store.taskProfile]
  );

  const releaseGroups = useMemo(() => {
    const groups = new Map<string, MeasurementRow[]>();
    for (const r of filteredRows) {
      const x = getCost(r);
      const y = r.intelligenceScore;
      if (x === null || y === null || (store.scaleMode === "log" ? x <= 0 : x < 0)) {
        continue;
      }

      const list = groups.get(r.releaseId) ?? [];
      list.push(r);
      groups.set(r.releaseId, list);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => (a.effortOrder ?? 999) - (b.effortOrder ?? 999));
    }
    return groups;
  }, [filteredRows, getCost, store.scaleMode]);

  // Flat deduplicated list of all plotted points for nearby-point tooltip merging
  const plottedPoints = useMemo(() => {
    const map = new Map<
      string,
      { row: MeasurementRow; x: number; y: number; isBestValue: boolean }
    >();
    for (const variants of releaseGroups.values()) {
      for (const r of variants) {
        const x = getCost(r);
        if (x === null || r.intelligenceScore === null) continue;
        map.set(r.variantId, {
          row: r,
          x,
          y: r.intelligenceScore,
          isBestValue: globalFrontierIds.has(r.id),
        });
      }
    }
    if (releaseGroups.size > 0) {
      for (const p of globalFrontierPoints) {
        if (p.cost > 0 && !map.has(p.row.variantId)) {
          map.set(p.row.variantId, {
            row: p.row,
            x: p.cost,
            y: p.score,
            isBestValue: true,
          });
        }
      }
    }
    return Array.from(map.values());
  }, [releaseGroups, globalFrontierPoints, globalFrontierIds, getCost]);

  const defaultViewport = useMemo<Viewport>(() => {
    const costs: number[] = [];
    const scores: number[] = [];

    for (const variants of releaseGroups.values()) {
      for (const r of variants) {
        const x = getCost(r);
        const y = r.intelligenceScore;
        if (x === null || y === null || (store.scaleMode === "log" ? x <= 0 : x < 0)) {
          continue;
        }
        costs.push(x);
        scores.push(y);
      }
    }

    if (costs.length === 0 || scores.length === 0) {
      return store.scaleMode === "linear"
        ? { uMin: 0, uMax: 2, yMin: 0, yMax: 70 }
        : { uMin: -2, uMax: 1, yMin: 0, yMax: 70 };
    }

    costs.sort((a, b) => a - b);
    scores.sort((a, b) => a - b);

    const minCost = costs[0];
    const maxCost = costs[costs.length - 1];
    const minScore = scores[0];
    const maxScore = scores[scores.length - 1];
    const scoreSpan = Math.max(6, maxScore - minScore);

    if (store.scaleMode === "linear") {
      const span = Math.max(0.05, maxCost - minCost);
      return {
        uMin: Math.max(0, minCost - span * 0.08),
        uMax: maxCost + span * 0.14,
        yMin: Math.max(0, Math.floor(minScore - scoreSpan * 0.12)),
        yMax: Math.ceil(maxScore + scoreSpan * 0.12),
      };
    }

    return clampViewport({
      uMin: Math.log10(Math.max(1e-6, minCost * 0.72)),
      uMax: Math.log10(Math.max(1e-5, maxCost * 1.45)),
      yMin: Math.max(0, Math.floor(minScore - scoreSpan * 0.12)),
      yMax: Math.ceil(maxScore + scoreSpan * 0.12),
    });
  }, [releaseGroups, getCost, store.scaleMode]);

  const [viewport, setViewport] = useState<Viewport>(defaultViewport);
  const viewportRef = useRef<Viewport>(viewport);
  viewportRef.current = viewport;

  const boundsKey = `${defaultViewport.uMin.toFixed(4)}:${defaultViewport.uMax.toFixed(4)}:${defaultViewport.yMin}:${defaultViewport.yMax}`;
  const prevBoundsKeyRef = useRef<string>(boundsKey);

  // Only reset camera when the plotted dataset's bounds actually change
  useEffect(() => {
    if (prevBoundsKeyRef.current !== boundsKey) {
      prevBoundsKeyRef.current = boundsKey;
      setViewport(defaultViewport);
    }
  }, [boundsKey, defaultViewport]);

  // Center-anchored zoom: scales symmetrically around current viewport center with zero translation
  const zoomByFactor = useCallback((factor: number) => {
    setViewport((prev) => {
      const uCenter = (prev.uMin + prev.uMax) / 2;
      const yCenter = (prev.yMin + prev.yMax) / 2;
      const newUSpan = clamp((prev.uMax - prev.uMin) * factor, MIN_U_SPAN, MAX_U_SPAN);
      const newYSpan = clamp((prev.yMax - prev.yMin) * factor, MIN_Y_SPAN, MAX_Y_SPAN);
      return clampViewport({
        uMin: uCenter - newUSpan / 2,
        uMax: uCenter + newUSpan / 2,
        yMin: yCenter - newYSpan / 2,
        yMax: yCenter + newYSpan / 2,
      });
    });
  }, []);

  // Pure center-anchored wheel zoom (non-passive so page doesn't scroll)
  useEffect(() => {
    const el = chartContainerRef.current;
    if (!el) return;

    function onWheel(e: WheelEvent) {
      if (releaseGroups.size === 0) return;
      e.preventDefault();
      const delta = clamp(e.deltaY, -120, 120);
      const factor = Math.exp(delta * 0.0018);
      zoomByFactor(factor);
    }

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [releaseGroups.size, zoomByFactor]);

  // Pure pan on drag (translation only, strictly invariant spans)
  const dragStateRef = useRef<{
    startX: number;
    startY: number;
    plotW: number;
    plotH: number;
    startViewport: Viewport;
  } | null>(null);

  function handleMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (e.button !== 0 || releaseGroups.size === 0) return;
    const el = chartContainerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const { left, right, top, bottom } = gridMarginsRef.current;
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    const plotW = Math.max(1, rect.width - left - right);
    const plotH = Math.max(1, rect.height - top - bottom);

    if (
      localX < left ||
      localX > rect.width - right ||
      localY < top ||
      localY > rect.height - bottom
    ) {
      return;
    }

    didDragRef.current = false;
    setIsDragging(true);
    dragStateRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      plotW,
      plotH,
      startViewport: viewportRef.current,
    };
  }

  // Two-finger pinch-to-zoom & pan on mobile (leaves 1-finger page scroll untouched)
  const pinchStateRef = useRef<{
    initialDist: number;
    startMidX: number;
    startMidY: number;
    plotW: number;
    plotH: number;
    startViewport: Viewport;
  } | null>(null);

  useEffect(() => {
    const el = chartContainerRef.current;
    if (!el) return;

    function onTouchStart(e: TouchEvent) {
      if (e.touches.length !== 2 || releaseGroups.size === 0) return;
      e.preventDefault();
      const [t0, t1] = [e.touches[0], e.touches[1]];
      const rect = el!.getBoundingClientRect();
      const { left, right, top, bottom } = gridMarginsRef.current;
      pinchStateRef.current = {
        initialDist: Math.max(10, Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY)),
        startMidX: (t0.clientX + t1.clientX) / 2,
        startMidY: (t0.clientY + t1.clientY) / 2,
        plotW: Math.max(1, rect.width - left - right),
        plotH: Math.max(1, rect.height - top - bottom),
        startViewport: viewportRef.current,
      };
    }

    function onTouchMove(e: TouchEvent) {
      const pinch = pinchStateRef.current;
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const [t0, t1] = [e.touches[0], e.touches[1]];
      const dist = Math.max(10, Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY));
      const midX = (t0.clientX + t1.clientX) / 2;
      const midY = (t0.clientY + t1.clientY) / 2;

      const factor = clamp(pinch.initialDist / dist, 0.25, 4.0);
      const uSpan0 = pinch.startViewport.uMax - pinch.startViewport.uMin;
      const ySpan0 = pinch.startViewport.yMax - pinch.startViewport.yMin;
      const newUSpan = clamp(uSpan0 * factor, MIN_U_SPAN, MAX_U_SPAN);
      const newYSpan = clamp(ySpan0 * factor, MIN_Y_SPAN, MAX_Y_SPAN);

      const uCenter0 = (pinch.startViewport.uMin + pinch.startViewport.uMax) / 2;
      const yCenter0 = (pinch.startViewport.yMin + pinch.startViewport.yMax) / 2;
      const dx = midX - pinch.startMidX;
      const dy = midY - pinch.startMidY;
      const du = -(dx / pinch.plotW) * newUSpan;
      const dyVal = (dy / pinch.plotH) * newYSpan;

      setViewport(
        clampViewport({
          uMin: uCenter0 - newUSpan / 2 + du,
          uMax: uCenter0 + newUSpan / 2 + du,
          yMin: yCenter0 - newYSpan / 2 + dyVal,
          yMax: yCenter0 + newYSpan / 2 + dyVal,
        })
      );
    }

    function onTouchEnd(e: TouchEvent) {
      if (e.touches.length < 2) {
        pinchStateRef.current = null;
      }
    }

    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [releaseGroups.size]);

  useEffect(() => {
    if (!isDragging) return;

    function onMouseMove(e: MouseEvent) {
      const drag = dragStateRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (Math.hypot(dx, dy) > 4) {
        didDragRef.current = true;
      }

      const uSpan = drag.startViewport.uMax - drag.startViewport.uMin;
      const ySpan = drag.startViewport.yMax - drag.startViewport.yMin;
      const du = -(dx / drag.plotW) * uSpan;
      const dyVal = (dy / drag.plotH) * ySpan;

      setViewport(
        clampViewport({
          uMin: drag.startViewport.uMin + du,
          uMax: drag.startViewport.uMax + du,
          yMin: drag.startViewport.yMin + dyVal,
          yMax: drag.startViewport.yMax + dyVal,
        })
      );
    }

    function onMouseUp() {
      dragStateRef.current = null;
      setIsDragging(false);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [isDragging]);

  useEffect(() => {
    function updateOrientation() {
      setIsPortrait(window.innerHeight > window.innerWidth);
    }
    updateOrientation();
    window.addEventListener("resize", updateOrientation);
    window.addEventListener("orientationchange", updateOrientation);
    return () => {
      window.removeEventListener("resize", updateOrientation);
      window.removeEventListener("orientationchange", updateOrientation);
    };
  }, []);

  useEffect(() => {
    if (!isFullscreen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setIsFullscreen(false);
      }
    }
    function onFullscreenChange() {
      if (!document.fullscreenElement) {
        // Keep CSS fullscreen active if user didn't explicitly exit, or sync if native exited
      }
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    const raf = requestAnimationFrame(() => {
      instanceRef.current?.resize();
    });
    return () => {
      cancelAnimationFrame(raf);
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
    };
  }, [isFullscreen]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      instanceRef.current?.resize();
    });
    return () => cancelAnimationFrame(raf);
  }, [isFullscreen]);

  const toggleFullscreen = useCallback(async () => {
    if (!isFullscreen) {
      setIsFullscreen(true);
      try {
        await sectionRef.current?.requestFullscreen?.();
      } catch {
        // Ignore on iOS Safari / browsers without Fullscreen API
      }
      try {
        const orientation = screen.orientation as unknown as {
          lock?: (mode: string) => Promise<void>;
        };
        await orientation?.lock?.("landscape");
      } catch {
        // Ignore if orientation lock is unsupported or rejected
      }
    } else {
      setIsFullscreen(false);
      try {
        screen.orientation?.unlock?.();
      } catch {
        // Ignore
      }
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen?.();
        }
      } catch {
        // Ignore
      }
    }
  }, [isFullscreen]);

  useEffect(() => {
    if (!chartRef.current) return;
    const chart = echarts.init(chartRef.current);
    instanceRef.current = chart;
    setContainerWidth(chartRef.current.clientWidth || 800);

    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width && width > 0) {
        setContainerWidth(width);
      }
      chart.resize();
    });
    ro.observe(chartRef.current);

    return () => {
      ro.disconnect();
      chart.dispose();
      instanceRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = instanceRef.current;
    if (!chart) return;

    const isDark = store.theme === "dark";
    const textColor = isDark ? "#cbd5e1" : "#334155";
    const gridColor = isDark ? "rgba(148,163,184,0.12)" : "rgba(15,23,42,0.1)";
    const bgTooltip = isDark ? "#0f172a" : "#ffffff";
    const borderTooltip = isDark ? "#334155" : "#cbd5e1";

    const series: echarts.SeriesOption[] = [];

    // Interactive Global Pareto Frontier curve
    if (releaseGroups.size > 0 && globalFrontierPoints.length > 0) {
      const pts = globalFrontierPoints
        .filter((p) => p.cost > 0)
        .map((p) => ({
          value: [p.cost, p.score],
          row: p.row,
          isBestValue: true,
          isFrontierLine: true,
        }));
      if (pts.length > 0) {
        series.push({
          name: "Global Pareto Frontier",
          id: "global_pareto_frontier",
          type: "line",
          clip: true,
          data: pts as unknown as echarts.LineSeriesOption["data"],
          showSymbol: true,
          symbol: "diamond",
          symbolSize: 9,
          smooth: false,
          z: 8,
          lineStyle: {
            color: "#38bdf8",
            width: 2.2,
            type: "dashed",
            opacity: 0.75,
          },
          itemStyle: {
            color: "#38bdf8",
            borderColor: isDark ? "#0b0f17" : "#ffffff",
            borderWidth: 2,
          },
          emphasis: {
            scale: 1.45,
          },
        });
      }
    }

    for (const [releaseId, variants] of releaseGroups.entries()) {
      const first = variants[0];
      const isHovered = store.hoveredReleaseId === releaseId;
      const anyHovered = store.hoveredReleaseId !== null;
      const opacity = anyHovered && !isHovered ? 0.16 : 1;

      if (variants.length === 1) {
        const r = first;
        const x = getCost(r)!;
        const y = r.intelligenceScore!;
        const isBestValue = globalFrontierIds.has(r.id);

        series.push({
          name: r.releaseName,
          id: `rel_${releaseId}`,
          type: "scatter",
          clip: true,
          z: isHovered ? 12 : 6,
          labelLayout: { hideOverlap: true, moveOverlap: "shiftY" },
          emphasis: { scale: 1.5 },
          data: [
            {
              value: [x, y],
              row: r,
              isBestValue,
              symbol: "circle",
              symbolSize: isCompact ? 11 : 10,
              itemStyle: {
                color: r.creatorColor,
                borderColor: isDark ? "#0b0f17" : "#ffffff",
                borderWidth: 2,
                opacity,
              },
              label: {
                show: true,
                position: isCompact ? ("top" as const) : ("right" as const),
                distance: isCompact ? 5 : 7,
                formatter: () =>
                  isCompact && r.releaseName.length > 16
                    ? `${r.releaseName.slice(0, 15)}…`
                    : r.releaseName,
                fontSize: isCompact ? 10 : 11,
                color: textColor,
              },
            },
          ] as unknown as echarts.ScatterSeriesOption["data"],
        });
      } else {
        // Pick the rightmost/highest-cost point for the small model name label beside the curve
        let labelVariant = variants[variants.length - 1];
        let maxCost = getCost(labelVariant) ?? -Infinity;
        for (const v of variants) {
          const vc = getCost(v) ?? -Infinity;
          if (vc >= maxCost) {
            maxCost = vc;
            labelVariant = v;
          }
        }

        // Crisp curve segments
        for (let i = 0; i < variants.length - 1; i++) {
          const a = variants[i];
          const b = variants[i + 1];
          const gap = hasEffortGap(
            a.effortOrder,
            b.effortOrder,
            a.effortLadderType
          );
          series.push({
            name: first.releaseName,
            id: `seg_${releaseId}_${i}`,
            type: "line",
            clip: true,
            z: isHovered ? 10 : 4,
            smooth: false,
            showSymbol: false,
            silent: true,
            lineStyle: {
              color: first.creatorColor,
              width: isHovered ? 3.5 : 2.5,
              type: gap ? "dashed" : "solid",
              opacity,
            },
            data: [
              [getCost(a)!, a.intelligenceScore!],
              [getCost(b)!, b.intelligenceScore!],
            ],
          });
        }

        // Bold points on the curve; hover or click shows reasoning effort
        series.push({
          name: first.releaseName,
          id: `pts_${releaseId}`,
          type: "scatter",
          clip: true,
          z: isHovered ? 12 : 7,
          labelLayout: { hideOverlap: true, moveOverlap: "shiftY" },
          emphasis: { scale: 1.5 },
          data: variants.map((r) => {
            const x = getCost(r)!;
            const y = r.intelligenceScore!;
            const isBestValue = globalFrontierIds.has(r.id);
            const isLabelPoint = r.variantId === labelVariant.variantId;
            const isActiveDetail =
              store.activeDetailVariantId === r.variantId;

            return {
              value: [x, y],
              row: r,
              isBestValue,
              symbol: getEffortShape(r.effortNormalized),
              symbolSize: isActiveDetail
                ? isCompact
                  ? 14
                  : 13
                : isCompact
                  ? 11
                  : 10,
              itemStyle: {
                color: r.creatorColor,
                borderColor: isActiveDetail
                  ? "#facc15"
                  : isDark
                    ? "#0b0f17"
                    : "#ffffff",
                borderWidth: isActiveDetail ? 3 : 2,
                opacity,
              },
              label: {
                show: isLabelPoint || isActiveDetail,
                position: isCompact ? ("top" as const) : ("right" as const),
                distance: isCompact ? 5 : 7,
                formatter: () => {
                  const rawLabel = isActiveDetail
                    ? `${r.releaseName} (${r.effortNormalized ?? "Standard"})`
                    : r.releaseName;
                  return isCompact && rawLabel.length > 16
                    ? `${rawLabel.slice(0, 15)}…`
                    : rawLabel;
                },
                fontSize: isCompact ? 10 : 11,
                color: textColor,
              },
            };
          }) as unknown as echarts.ScatterSeriesOption["data"],
        });
      }
    }

    const activeChart = chart;
    const scoreLabel = t("simpleMetricIntel");
    const dividerColor = isDark ? "#334155" : "#e2e8f0";

    function findNearbyPoints(
      value: [number, number] | undefined,
      baseRow: MeasurementRow,
      baseBestValue: boolean
    ): Array<{ row: MeasurementRow; isBestValue: boolean; dist: number }> {
      const fallback = [
        { row: baseRow, isBestValue: baseBestValue, dist: 0 },
      ];
      if (!value) return fallback;
      try {
        const hoveredPx = activeChart.convertToPixel("grid", value);
        if (!Array.isArray(hoveredPx)) return fallback;
        const [hx, hy] = hoveredPx;
        const matched: Array<{
          row: MeasurementRow;
          isBestValue: boolean;
          dist: number;
        }> = [];
        for (const pt of plottedPoints) {
          const ptPx = activeChart.convertToPixel("grid", [pt.x, pt.y]);
          if (!Array.isArray(ptPx)) continue;
          const dist = Math.hypot(ptPx[0] - hx, ptPx[1] - hy);
          if (dist <= 18) {
            matched.push({
              row: pt.row,
              isBestValue: pt.isBestValue,
              dist: pt.row.variantId === baseRow.variantId ? -1 : dist,
            });
          }
        }
        if (matched.length > 0) {
          matched.sort((a, b) => a.dist - b.dist);
          return matched;
        }
      } catch {
        // Fallback to single item if pixel conversion fails
      }
      return fallback;
    }

    const option: echarts.EChartsOption = {
      animation: false,
      backgroundColor: "transparent",
      grid: {
        left: gridMargins.left,
        right: gridMargins.right,
        top: gridMargins.top,
        bottom: gridMargins.bottom,
      },
      tooltip: {
        trigger: "item",
        confine: true,
        backgroundColor: bgTooltip,
        borderColor: borderTooltip,
        borderWidth: 1,
        extraCssText:
          "max-width: calc(100vw - 24px); white-space: normal; border-radius: 10px; box-shadow: 0 12px 28px -6px rgba(0,0,0,0.35);",
        textStyle: {
          color: isDark ? "#f1f5f9" : "#0f172a",
          fontSize: 12,
        },
        formatter: (params: unknown) => {
          if (isDragging) return "";
          const p = params as {
            data?: {
              row?: MeasurementRow;
              isBestValue?: boolean;
              value?: [number, number];
            };
          };
          const hoveredRow = p?.data?.row;
          if (!hoveredRow) return "";

          const nearby = findNearbyPoints(
            p.data?.value,
            hoveredRow,
            Boolean(p.data?.isBestValue)
          );

          const visibleItems = nearby.slice(0, isCompact ? 3 : 6);
          const extraCount = nearby.length - visibleItems.length;

          // Package G (AC-G3): build the tooltip as a DOM tree and write
          // every external field (release name, creator name, effort tier)
          // through textContent, so values containing < > & " render as
          // literal plain text. No external field is concatenated into
          // HTML, CSS, or a URL; the only color taken from data is the
          // creator color, constrained to a hex value by safeTooltipColor.
          const container = document.createElement("div");
          container.style.minWidth = `${isCompact ? 175 : 220}px`;
          container.style.maxWidth = `${isCompact ? 230 : 320}px`;
          container.style.lineHeight = "1.5";

          const mutedColor = "#94a3b8";
          const addRow = (
            grid: HTMLDivElement,
            label: string,
            value: string,
            valueColor?: string,
            bold = false
          ) => {
            const labelEl = document.createElement("span");
            labelEl.style.color = mutedColor;
            labelEl.textContent = `${label}:`;
            const valueEl = document.createElement(bold ? "b" : "span");
            if (valueColor) valueEl.style.color = valueColor;
            valueEl.textContent = value;
            grid.append(labelEl, valueEl);
          };

          visibleItems.forEach((item, idx) => {
            const r = item.row;
            const creatorDisplay = getCreatorDisplayName(
              r.creatorSlug,
              r.creatorName,
              locale
            );
            const dev = getDeveloperAgentCost(r, store.taskProfile);
            const ctxLabel = r.contextWindow
              ? r.contextWindow >= 1_000_000
                ? `${(r.contextWindow / 1_000_000).toFixed(1)}M`
                : `${Math.round(r.contextWindow / 1000)}K`
              : "128K";

            const block = document.createElement("div");
            if (idx > 0) {
              block.style.borderTop = `1px solid ${dividerColor}`;
              block.style.marginTop = "8px";
              block.style.paddingTop = "8px";
            }

            const head = document.createElement("div");
            head.style.display = "flex";
            head.style.alignItems = "center";
            head.style.justifyContent = "space-between";
            head.style.gap = "10px";
            head.style.marginBottom = "3px";

            const title = document.createElement("strong");
            title.style.fontSize = "12.5px";
            title.textContent = r.releaseName;
            if (item.isBestValue) {
              const badge = document.createElement("span");
              badge.style.marginLeft = "6px";
              badge.style.fontSize = "10px";
              badge.style.color = "#38bdf8";
              badge.style.fontWeight = "600";
              badge.textContent = "★";
              title.appendChild(badge);
            }

            const creator = document.createElement("span");
            creator.style.color = safeTooltipColor(r.creatorColor, mutedColor);
            creator.style.fontWeight = "600";
            creator.style.fontSize = "11px";
            creator.textContent = creatorDisplay;

            head.append(title, creator);

            const grid = document.createElement("div");
            grid.style.display = "grid";
            grid.style.gridTemplateColumns = "1fr auto";
            grid.style.gap = "2px 12px";
            grid.style.fontSize = "11px";

            addRow(
              grid,
              t("simpleEffortLabel"),
              r.effortNormalized ?? "Standard",
              "#38bdf8",
              true
            );
            addRow(grid, scoreLabel, formatScore(r.intelligenceScore), undefined, true);
            addRow(
              grid,
              locale === "zh" ? "预估单次花费" : "Est. Task Cost",
              formatUsd(dev?.totalUsd),
              "#34d399",
              true
            );
            addRow(
              grid,
              locale === "zh" ? "输入 / 输出 ($/1M)" : "Input / Output ($/1M)",
              `${formatUsd(r.inputPricePerMillion)} / ${formatUsd(r.outputPricePerMillion)}`
            );
            addRow(
              grid,
              locale === "zh" ? "缓存读 / 写 ($/1M)" : "Cache Read / Write ($/1M)",
              `${formatUsd(r.cacheReadPricePerMillion)} / ${formatUsd(r.cacheWritePricePerMillion)}`
            );
            addRow(
              grid,
              locale === "zh" ? "缓存省下 / 压缩次数" : "Cache Saved / Compacts",
              `${formatUsd(dev?.cacheSavingsUsd)} / ${dev?.compactionCount ?? 0}x`
            );
            addRow(
              grid,
              `${t("simpleColContext")} / ${t("simpleColSpeed")}`,
              `${ctxLabel} · ${formatSpeed(r.outputTokensPerSecond)}`
            );

            block.append(head, grid);
            container.appendChild(block);
          });

          if (extraCount > 0) {
            const footer = document.createElement("div");
            footer.style.marginTop = "6px";
            footer.style.fontSize = "10px";
            footer.style.color = mutedColor;
            footer.textContent = `+${extraCount} ...`;
            container.appendChild(footer);
          }

          return container;
        },
      },
      xAxis: {
        type: store.scaleMode === "linear" ? "value" : "log",
        name:
          locale === "zh"
            ? "预估单次花费 ($)"
            : "Est. Task Cost ($)",
        nameLocation: "middle",
        nameGap: isCompact ? 24 : 30,
        nameTextStyle: {
          color: textColor,
          fontSize: isCompact ? 10 : 11,
          fontWeight: 500,
        },
        splitNumber: isCompact ? 3 : 5,
        min:
          store.scaleMode === "linear"
            ? Math.max(0, viewport.uMin)
            : Math.pow(10, viewport.uMin),
        max:
          store.scaleMode === "linear"
            ? Math.max(0.01, viewport.uMax)
            : Math.pow(10, viewport.uMax),
        axisLabel: {
          color: textColor,
          fontSize: isCompact ? 10 : 11,
          hideOverlap: true,
          formatter: (val: number) => {
            if (val >= 1000) return `$${Number((val / 1000).toFixed(1))}k`;
            if (val >= 10) return `$${Math.round(val)}`;
            if (val >= 1) return `$${Number(val.toFixed(1))}`;
            if (val >= 0.01) return `$${Number(val.toFixed(2))}`;
            return `$${Number(val.toFixed(4))}`;
          },
        },
        splitLine: { lineStyle: { color: gridColor } },
      },
      yAxis: {
        type: "value",
        name: scoreLabel,
        nameLocation: "end",
        nameRotate: 0,
        nameGap: isCompact ? 10 : 14,
        nameTextStyle: {
          color: textColor,
          fontSize: isCompact ? 10 : 12,
          fontWeight: 500,
          align: "center",
        },
        min: viewport.yMin,
        max: viewport.yMax,
        axisLabel: {
          color: textColor,
          fontSize: isCompact ? 10 : 11,
          hideOverlap: true,
          formatter: (val: number) =>
            Math.abs(val - Math.round(val)) < 1e-4
              ? String(Math.round(val))
              : val.toFixed(1),
        },
        splitLine: { lineStyle: { color: gridColor } },
      },
      series,
    };

    chart.setOption(option, { notMerge: true });

    chart.off("click");
    chart.on("click", (params: unknown) => {
      if (didDragRef.current) return;
      const isTouchMobile =
        isCompact ||
        (typeof window !== "undefined" &&
          window.matchMedia("(pointer: coarse)").matches);
      if (isTouchMobile) return;

      const p = params as {
        data?: {
          row?: MeasurementRow;
          isBestValue?: boolean;
          value?: [number, number];
        };
      };
      if (p?.data?.row) {
        const nearby = findNearbyPoints(
          p.data.value,
          p.data.row,
          Boolean(p.data.isBestValue)
        );
        const nearbyIds = Array.from(
          new Set(nearby.map((item) => item.row.variantId))
        );
        store.setActiveDetailVariantIds(nearbyIds);
      }
    });

    chart.off("mouseover");
    chart.on("mouseover", (params: unknown) => {
      if (isDragging) return;
      const p = params as { data?: { row?: MeasurementRow } };
      if (p?.data?.row) {
        store.setHoveredReleaseId(p.data.row.releaseId);
      }
    });

    chart.off("mouseout");
    chart.on("mouseout", () => {
      store.setHoveredReleaseId(null);
    });
  }, [
    releaseGroups,
    plottedPoints,
    globalFrontierIds,
    globalFrontierPoints,
    viewport,
    isDragging,
    isCompact,
    gridMargins,
    locale,
    t,
    store,
  ]);

  function handleResetZoom() {
    setViewport(defaultViewport);
  }

  return (
    <section
      ref={sectionRef}
      className={
        isFullscreen
          ? "fixed inset-0 z-50 flex h-[100dvh] w-[100dvw] flex-col bg-bg-primary pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]"
          : "flex flex-col rounded-xl border border-border bg-bg-secondary"
      }
    >
      {/* Minimal Header */}
      <div className="flex shrink-0 flex-nowrap items-center justify-between gap-2 border-b border-border px-3 py-2.5 sm:gap-3 sm:px-4 sm:py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-text-primary">
              {t("simpleChartTitle")}
            </h2>
            <span className="inline-flex items-center gap-1.5 text-[10px] text-text-muted">
              <span className="inline-block h-0.5 w-3.5 border-t-2 border-dashed border-sky-400" />
              <span>{t("frontierLegend")}</span>
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-text-muted sm:hidden">
            {t("mobileChartHint")}
          </p>
          <p className="mt-0.5 hidden text-[11px] text-text-muted sm:block">
            {t("simpleClickCurveHint")}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => zoomByFactor(0.75)}
            title="+"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-bg-primary text-text-secondary transition hover:border-accent hover:text-text-primary active:scale-95 sm:h-7 sm:w-7"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => zoomByFactor(1.33)}
            title="-"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-bg-primary text-text-secondary transition hover:border-accent hover:text-text-primary active:scale-95 sm:h-7 sm:w-7"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={handleResetZoom}
            title={t("simpleResetZoom")}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-bg-primary text-text-secondary transition hover:border-accent hover:text-text-primary active:scale-95 sm:h-7 sm:w-7"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={toggleFullscreen}
            title={isFullscreen ? t("chartExitFullscreen") : t("chartFullscreen")}
            className={`flex h-8 items-center justify-center gap-1 rounded-lg border px-2 text-xs font-medium transition active:scale-95 sm:h-7 ${
              isFullscreen
                ? "border-accent bg-accent/15 text-accent"
                : "border-border bg-bg-primary text-text-secondary hover:border-accent hover:text-text-primary"
            }`}
          >
            {isFullscreen ? (
              <>
                <Minimize2 className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{t("chartExitFullscreen")}</span>
              </>
            ) : (
              <>
                <Maximize2 className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{t("chartFullscreen")}</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Main Chart Canvas + Empty Overlay */}
      <div
        ref={chartContainerRef}
        onMouseDown={handleMouseDown}
        className={`relative w-full select-none ${
          isFullscreen
            ? "min-h-0 flex-1"
            : "h-[300px] sm:h-[520px] lg:h-[580px]"
        } ${
          releaseGroups.size > 0
            ? isDragging
              ? "cursor-grabbing"
              : "cursor-grab"
            : ""
        }`}
      >
        {isFullscreen && isPortrait && (
          <div className="pointer-events-none absolute top-2 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-accent/30 bg-bg-secondary/90 px-3 py-1 text-[11px] font-medium text-accent shadow-lg backdrop-blur">
            <RotateCw className="h-3.5 w-3.5" />
            <span className="whitespace-nowrap">{t("chartRotateHint")}</span>
          </div>
        )}
        <div ref={chartRef} className="h-full w-full" />
        {releaseGroups.size === 0 && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-6 text-center">
            <p className="text-sm font-medium text-text-secondary">
              {t("simpleEmptyChartTitle")}
            </p>
            <p className="text-xs text-text-muted">
              {t("simpleEmptyChartDesc")}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
