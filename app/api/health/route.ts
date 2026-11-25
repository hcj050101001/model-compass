import { NextResponse } from "next/server";
import { getActiveSnapshot } from "@/lib/database/queries";
import { SchemaCompatibilityError } from "@/lib/database";

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
    // Desensitized (Package B): never echo raw underlying error text.
    if (err instanceof SchemaCompatibilityError) {
      return NextResponse.json(
        { status: "error", error: "Service unavailable" },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { status: "error", error: "Database unavailable" },
      { status: 500 }
    );
  }
}
