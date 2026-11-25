import { getActiveMeasurements } from "@/lib/database/queries";
import { isPrivateMode } from "@/lib/auth-config";
import { ComparePageClient } from "@/components/ComparePageClient";

export const dynamic = "force-dynamic";

export default async function ComparePage() {
  const { snapshot, rows } = await getActiveMeasurements();
  return (
    <ComparePageClient
      rows={rows}
      snapshot={snapshot}
      privateMode={isPrivateMode()}
    />
  );
}
