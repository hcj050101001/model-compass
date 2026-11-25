import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createSessionToken,
  isPrivateMode,
  SESSION_COOKIE_NAME,
} from "@/lib/auth";

const LoginSchema = z.object({
  password: z.string().min(1),
});

export async function POST(request: Request) {
  if (!isPrivateMode()) {
    return NextResponse.json({ ok: true, privateMode: false });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = LoginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Password is required" }, { status: 400 });
  }

  const expected = process.env.ACCESS_PASSWORD;
  if (!expected) {
    return NextResponse.json(
      { error: "Server ACCESS_PASSWORD is not configured" },
      { status: 500 }
    );
  }

  if (parsed.data.password !== expected) {
    return NextResponse.json({ error: "Invalid access password" }, { status: 401 });
  }

  const token = await createSessionToken("admin");
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  });
  return response;
}
