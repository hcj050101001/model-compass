import { getActiveMeasurements, getSyncStatusInfo } from "@/lib/database/queries";
import { isPrivateMode } from "@/lib/auth";
import { DashboardClient } from "@/components/DashboardClient";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [{ snapshot, rows }, statusInfo] = await Promise.all([
    getActiveMeasurements(),
    getSyncStatusInfo(),
  ]);

  const latestJob = statusInfo.recentJobs[0];
  const isStale = latestJob?.status === "failed";

  return (
    <DashboardClient
      rows={rows}
      snapshot={snapshot}
      isStale={isStale}
      privateMode={isPrivateMode()}
    />
  );
}
