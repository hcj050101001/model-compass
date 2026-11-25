import { getSyncStatusInfo } from "@/lib/database/queries";
import { isPrivateMode } from "@/lib/auth";
import { SettingsClient } from "@/components/SettingsClient";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const statusInfo = await getSyncStatusInfo();
  return <SettingsClient statusInfo={statusInfo} privateMode={isPrivateMode()} />;
}
