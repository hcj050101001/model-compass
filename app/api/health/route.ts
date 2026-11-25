import { NextResponse } from "next/server";
import { getActiveSnapshot } from "@/lib/database/queries";

export async function GET() {
  try {
    const snapshot = await getActiveSnapshot();
    return NextResponse.json({
      status: "ok",
      app: process.env.APP_NAME ?? "ModelCompass",
      hasSnapshot: Boolean(snapshot),
      isDemo: snapshot?.isDemo ?? process.env.DEMO_MODE === "true",
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      {
        status: "error",
        error: err instanceof Error ? err.message : "Database unavailable",
      },
      { status: 500 }
    );
  }
}
