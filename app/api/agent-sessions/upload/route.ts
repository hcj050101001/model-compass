import { NextResponse } from "next/server";

export function POST() {
  return NextResponse.json({ error: "Agent session uploads are disabled" }, { status: 403 });
}
