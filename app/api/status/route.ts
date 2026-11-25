import { NextResponse } from "next/server";
import { getSyncStatusInfo } from "@/lib/database/queries";

export async function GET() {
  const info = await getSyncStatusInfo();
  return NextResponse.json(info);
}
