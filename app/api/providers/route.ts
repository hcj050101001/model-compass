import { NextResponse } from "next/server";
import { getActiveMeasurements } from "@/lib/database/queries";

export async function GET() {
  const { snapshot, rows } = await getActiveMeasurements();
  const byCreator = new Map<
    string,
    {
      id: string;
      name: string;
      slug: string;
      color: string;
      releaseCount: number;
      variantCount: number;
      releaseIds: Set<string>;
    }
  >();

  for (const r of rows) {
    let entry = byCreator.get(r.creatorId);
    if (!entry) {
      entry = {
        id: r.creatorId,
        name: r.creatorName,
        slug: r.creatorSlug,
        color: r.creatorColor,
        releaseCount: 0,
        variantCount: 0,
        releaseIds: new Set(),
      };
      byCreator.set(r.creatorId, entry);
    }
    entry.variantCount += 1;
    entry.releaseIds.add(r.releaseId);
    entry.releaseCount = entry.releaseIds.size;
  }

  const creators = Array.from(byCreator.values())
    .map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      color: c.color,
      releaseCount: c.releaseCount,
      variantCount: c.variantCount,
    }))
    .sort((a, b) => b.variantCount - a.variantCount);

  return NextResponse.json({
    snapshotId: snapshot?.id ?? null,
    isDemo: snapshot?.isDemo ?? true,
    creators,
  });
}
