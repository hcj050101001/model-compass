"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DeveloperTaskProfile } from "@/lib/agent-cost/developer-cost";
import { DEFAULT_AGENT_PARAMS, getPresetAgentParams } from "@/lib/agent-cost/eac";
import type { CustomAgentParams, TaskComplexity } from "@/lib/agent-cost/types";
import type { XAxisMode, YAxisMetric } from "@/lib/analytics/types";

export type ScaleMode = "log" | "linear";
export type FrontierOverlayMode = "global" | "local" | "both" | "none";
export type LabelMode = "auto" | "frontier" | "selected" | "all" | "none";

interface DashboardState {
  theme: "dark" | "light";
  setTheme: (theme: "dark" | "light") => void;
  toggleTheme: () => void;

  // Axis & Chart controls
  taskProfile: DeveloperTaskProfile;
  setTaskProfile: (profile: DeveloperTaskProfile) => void;
  xMode: XAxisMode;
  setXMode: (mode: XAxisMode) => void;
  yMetric: YAxisMetric;
  setYMetric: (metric: YAxisMetric) => void;
  scaleMode: ScaleMode;
  setScaleMode: (mode: ScaleMode) => void;
  autoScaleOnFilter: boolean;
  setAutoScaleOnFilter: (v: boolean) => void;
  frontierMode: FrontierOverlayMode;
  setFrontierMode: (mode: FrontierOverlayMode) => void;
  labelMode: LabelMode;
  setLabelMode: (mode: LabelMode) => void;

  // Filters
  selectedCreators: string[];
  setSelectedCreators: (slugs: string[]) => void;
  toggleCreator: (slug: string) => void;
  selectedEfforts: string[];
  setSelectedEfforts: (efforts: string[]) => void;
  toggleEffort: (effort: string) => void;
  selectedReleaseIds: string[];
  setSelectedReleaseIds: (ids: string[]) => void;
  toggleReleaseId: (id: string) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  minScore: number | null;
  setMinScore: (v: number | null) => void;
  maxCost: number | null;
  setMaxCost: (v: number | null) => void;
  releaseDateFrom: string;
  setReleaseDateFrom: (d: string) => void;
  reasoningOnly: boolean;
  setReasoningOnly: (v: boolean) => void;
  openWeightsOnly: boolean;
  setOpenWeightsOnly: (v: boolean) => void;
  paretoOnly: boolean;
  setParetoOnly: (v: boolean) => void;
  favoritesOnly: boolean;
  setFavoritesOnly: (v: boolean) => void;
  resetFilters: () => void;

  // Interactive selections
  favoriteIds: string[];
  toggleFavorite: (variantId: string) => void;
  compareIds: string[];
  toggleCompare: (variantId: string) => void;
  clearCompare: () => void;
  highlightCompareOnChart: boolean;
  setHighlightCompareOnChart: (v: boolean) => void;
  activeDetailVariantId: string | null;
  setActiveDetailVariantId: (id: string | null) => void;
  activeDetailVariantIds: string[];
  setActiveDetailVariantIds: (ids: string[]) => void;
  hoveredReleaseId: string | null;
  setHoveredReleaseId: (id: string | null) => void;

  // Agent cost parameters (EAC / Custom / Scenario weights)
  agentParams: CustomAgentParams;
  setAgentParams: (patch: Partial<CustomAgentParams>) => void;
  applyAgentPreset: (preset: TaskComplexity) => void;

  // Superior alternative tolerances
  costTolerancePct: number;
  setCostTolerancePct: (v: number) => void;
  minScoreGain: number;
  setMinScoreGain: (v: number) => void;
}

export const useDashboardStore = create<DashboardState>()(
  persist(
    (set) => ({
      theme: "dark",
      setTheme: (theme) => set({ theme }),
      toggleTheme: () =>
        set((s) => ({ theme: s.theme === "dark" ? "light" : "dark" })),

      taskProfile: "standard",
      setTaskProfile: (taskProfile) => set({ taskProfile }),
      xMode: "eac",
      setXMode: (xMode) => set({ xMode }),
      yMetric: "intelligence",
      setYMetric: (yMetric) => set({ yMetric }),
      scaleMode: "log",
      setScaleMode: (scaleMode) => set({ scaleMode }),
      autoScaleOnFilter: false,
      setAutoScaleOnFilter: (autoScaleOnFilter) => set({ autoScaleOnFilter }),
      frontierMode: "global",
      setFrontierMode: (frontierMode) => set({ frontierMode }),
      labelMode: "auto",
      setLabelMode: (labelMode) => set({ labelMode }),

      selectedCreators: [],
      setSelectedCreators: (selectedCreators) => set({ selectedCreators }),
      toggleCreator: (slug) =>
        set((s) => ({
          selectedCreators: s.selectedCreators.includes(slug)
            ? s.selectedCreators.filter((c) => c !== slug)
            : [...s.selectedCreators, slug],
        })),
      selectedEfforts: [],
      setSelectedEfforts: (selectedEfforts) => set({ selectedEfforts }),
      toggleEffort: (effort) =>
        set((s) => ({
          selectedEfforts: s.selectedEfforts.includes(effort)
            ? s.selectedEfforts.filter((e) => e !== effort)
            : [...s.selectedEfforts, effort],
        })),
      selectedReleaseIds: [],
      setSelectedReleaseIds: (selectedReleaseIds) => set({ selectedReleaseIds }),
      toggleReleaseId: (id) =>
        set((s) => ({
          selectedReleaseIds: s.selectedReleaseIds.includes(id)
            ? s.selectedReleaseIds.filter((r) => r !== id)
            : [...s.selectedReleaseIds, id],
        })),
      searchQuery: "",
      setSearchQuery: (searchQuery) => set({ searchQuery }),
      minScore: null,
      setMinScore: (minScore) => set({ minScore }),
      maxCost: null,
      setMaxCost: (maxCost) => set({ maxCost }),
      releaseDateFrom: "",
      setReleaseDateFrom: (releaseDateFrom) => set({ releaseDateFrom }),
      reasoningOnly: false,
      setReasoningOnly: (reasoningOnly) => set({ reasoningOnly }),
      openWeightsOnly: false,
      setOpenWeightsOnly: (openWeightsOnly) => set({ openWeightsOnly }),
      paretoOnly: true,
      setParetoOnly: (paretoOnly) => set({ paretoOnly }),
      favoritesOnly: false,
      setFavoritesOnly: (favoritesOnly) => set({ favoritesOnly }),
      resetFilters: () =>
        set({
          selectedCreators: [],
          selectedEfforts: [],
          selectedReleaseIds: [],
          searchQuery: "",
          minScore: null,
          maxCost: null,
          releaseDateFrom: "",
          reasoningOnly: false,
          openWeightsOnly: false,
          paretoOnly: false,
          favoritesOnly: false,
        }),

      favoriteIds: [],
      toggleFavorite: (variantId) =>
        set((s) => ({
          favoriteIds: s.favoriteIds.includes(variantId)
            ? s.favoriteIds.filter((id) => id !== variantId)
            : [...s.favoriteIds, variantId],
        })),
      compareIds: [],
      toggleCompare: (variantId) =>
        set((s) => ({
          compareIds: s.compareIds.includes(variantId)
            ? s.compareIds.filter((id) => id !== variantId)
            : [...s.compareIds, variantId].slice(0, 8),
        })),
      clearCompare: () => set({ compareIds: [] }),
      highlightCompareOnChart: true,
      setHighlightCompareOnChart: (highlightCompareOnChart) =>
        set({ highlightCompareOnChart }),
      activeDetailVariantId: null,
      setActiveDetailVariantId: (id) =>
        set((s) =>
          id === null
            ? { activeDetailVariantId: null, activeDetailVariantIds: [] }
            : {
                activeDetailVariantId: id,
                activeDetailVariantIds: s.activeDetailVariantIds.includes(id)
                  ? s.activeDetailVariantIds
                  : [id],
              }
        ),
      activeDetailVariantIds: [],
      setActiveDetailVariantIds: (ids) =>
        set({
          activeDetailVariantIds: ids,
          activeDetailVariantId: ids[0] ?? null,
        }),
      hoveredReleaseId: null,
      setHoveredReleaseId: (hoveredReleaseId) => set({ hoveredReleaseId }),

      agentParams: DEFAULT_AGENT_PARAMS,
      setAgentParams: (patch) =>
        set((s) => ({
          agentParams: {
            ...s.agentParams,
            ...patch,
            preset: patch.preset ?? "custom",
          },
        })),
      applyAgentPreset: (preset) =>
        set((s) => ({
          agentParams: {
            ...getPresetAgentParams(preset),
            scenarioWeights: s.agentParams.scenarioWeights,
            includeExtraToolCost: s.agentParams.includeExtraToolCost,
          },
        })),

      costTolerancePct: 5,
      setCostTolerancePct: (costTolerancePct) => set({ costTolerancePct }),
      minScoreGain: 1,
      setMinScoreGain: (minScoreGain) => set({ minScoreGain }),
    }),
    {
      name: "llm-frontier-dashboard-v3",
      partialize: (state) => ({
        theme: state.theme,
        selectedCreators: state.selectedCreators,
        favoriteIds: state.favoriteIds,
        compareIds: state.compareIds,
        taskProfile: state.taskProfile,
        xMode: state.xMode,
        yMetric: state.yMetric,
        scaleMode: state.scaleMode,
        frontierMode: state.frontierMode,
        labelMode: state.labelMode,
        agentParams: state.agentParams,
        costTolerancePct: state.costTolerancePct,
        minScoreGain: state.minScoreGain,
      }),
    }
  )
);
