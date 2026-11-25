"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { DemoBanner } from "./layout/DemoBanner";
import { Footer } from "./layout/Footer";
import { Header } from "./layout/Header";

interface SettingsClientProps {
  statusInfo: {
    activeSnapshot: {
      id: string;
      source: string;
      benchmarkVersion: string;
      fetchedAt: string;
      modelCount: number;
      variantCount: number;
      contentHash: string;
      status: string;
      isDemo: boolean;
    } | null;
    recentJobs: Array<{
      id: string;
      startedAt: string;
      completedAt: string | null;
      status: string;
      fetchedCount: number;
      validCount: number;
      rejectedCount: number;
      errorMessage: string | null;
      rateLimitRemaining: number | null;
      rateLimitReset: string | null;
    }>;
    snapshots: Array<{
      id: string;
      source: string;
      benchmarkVersion: string;
      fetchedAt: string;
      modelCount: number;
      variantCount: number;
      status: string;
      isDemo: boolean;
    }>;
    demoModeEnv: boolean;
    hasApiKey: boolean;
    syncIntervalMinutes: number;
    apiTier: string;
  };
  privateMode: boolean;
}

export function SettingsClient({
  statusInfo,
  privateMode,
}: SettingsClientProps) {
  const router = useRouter();
  const { t } = useLocale();
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const snap = statusInfo.activeSnapshot;

  async function triggerSync() {
    setSyncing(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/sync", { method: "POST" });
      const data = await res.json();
      setMessage(
        `Sync status: ${data.status}${data.errorMessage ? ` — ${data.errorMessage}` : ""}`
      );
      router.refresh();
    } catch {
      setMessage("Sync failed due to network error.");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-bg-primary text-text-primary">
      <DemoBanner isDemo={snap?.isDemo ?? true} fetchedAt={snap?.fetchedAt} />
      <Header
        fetchedAt={snap?.fetchedAt}
        isDemo={snap?.isDemo}
        indexVersion={snap?.benchmarkVersion}
        privateMode={privateMode}
        onSyncComplete={() => router.refresh()}
      />

      <main className="mx-auto w-full max-w-[1280px] flex-1 space-y-4 px-3 py-4 text-xs sm:space-y-6 sm:px-4 sm:py-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold text-text-primary">
              {t("settingsTitle")}
            </h1>
            <p className="text-text-muted">{t("settingsDesc")}</p>
          </div>
          {privateMode && (
            <button
              type="button"
              onClick={triggerSync}
              disabled={syncing}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-accent px-3.5 py-2.5 font-semibold text-slate-950 hover:bg-accent-hover active:scale-[0.99] disabled:opacity-50 sm:w-auto sm:rounded-lg sm:py-2"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
              <span>{t("runSyncNow")}</span>
            </button>
          )}
        </div>

        {message && (
          <div className="rounded-lg border border-border bg-bg-secondary px-4 py-2.5 text-text-primary">
            {message}
          </div>
        )}

        {/* Configuration Summary */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              label: "Data Mode",
              val: snap?.isDemo ? "DEMO (Synthetic)" : "LIVE (Artificial Analysis)",
            },
            {
              label: "AA API Key Configured",
              val: statusInfo.hasApiKey ? "Yes (Server-side only)" : "Not Configured",
            },
            {
              label: "AA API Tier & Interval",
              val: `${statusInfo.apiTier} · Every ${statusInfo.syncIntervalMinutes} min`,
            },
            {
              label: "Active Snapshot",
              val: snap
                ? `${snap.modelCount} models / ${snap.variantCount} variants`
                : "None",
            },
          ].map((c) => (
            <div
              key={c.label}
              className="rounded-xl border border-border bg-bg-secondary p-3.5"
            >
              <div className="text-[11px] text-text-muted">{c.label}</div>
              <div className="mt-1 font-semibold text-text-primary">{c.val}</div>
            </div>
          ))}
        </div>

        {/* Sync Jobs */}
        <div className="rounded-xl border border-border bg-bg-secondary overflow-hidden">
          <div className="border-b border-border px-4 py-3 font-semibold text-text-primary">
            {t("recentJobs")}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-bg-tertiary text-text-muted">
                <tr>
                  <th className="whitespace-nowrap px-3 py-2">Started</th>
                  <th className="whitespace-nowrap px-3 py-2">Status</th>
                  <th className="whitespace-nowrap px-3 py-2">Fetched</th>
                  <th className="whitespace-nowrap px-3 py-2">Valid</th>
                  <th className="whitespace-nowrap px-3 py-2">Rejected</th>
                  <th className="whitespace-nowrap px-3 py-2">Quota Remaining</th>
                  <th className="whitespace-nowrap px-3 py-2">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {statusInfo.recentJobs.map((j) => (
                  <tr key={j.id}>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {new Date(j.startedAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 font-semibold">{j.status}</td>
                    <td className="px-3 py-2">{j.fetchedCount}</td>
                    <td className="px-3 py-2">{j.validCount}</td>
                    <td className="px-3 py-2">{j.rejectedCount}</td>
                    <td className="px-3 py-2">{j.rateLimitRemaining ?? "—"}</td>
                    <td className="px-3 py-2 text-text-muted">
                      {j.errorMessage ?? "OK"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Methodology & Compliance */}
        <div className="rounded-xl border border-border bg-bg-secondary p-4 space-y-2 leading-relaxed text-text-secondary">
          <h2 className="text-sm font-semibold text-text-primary">
            {t("methodologyTitle")}
          </h2>
          <p>{t("methodologyP1")}</p>
          <p>{t("methodologyP2")}</p>
          <p>{t("methodologyP3")}</p>
        </div>
      </main>

      <Footer
        indexVersion={snap?.benchmarkVersion}
        source={snap?.source}
        isDemo={snap?.isDemo}
      />
    </div>
  );
}
