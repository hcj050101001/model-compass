import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createSessionToken,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE,
  sessionCookieOptions,
} from "@/lib/auth";
import { getAuthConfigError, isPrivateMode } from "@/lib/auth-config";

const MAX_LOGIN_BODY_BYTES = 4 * 1024;
const LoginSchema = z.object({
  password: z.string().min(1),
});

export async function POST(request: Request) {
  if (getAuthConfigError()) {
    return NextResponse.json({ error: "Authentication unavailable" }, { status: 503 });
  }

  if (!isPrivateMode()) {
    return NextResponse.json({ ok: true, privateMode: false });
  }

  const reader = request.body?.getReader();
  if (!reader) {
    return NextResponse.json({ error: "Password is required" }, { status: 400 });
  }

  let body: unknown;
  try {
    const bytes = new Uint8Array(MAX_LOGIN_BODY_BYTES);
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > bytes.length) {
        void reader.cancel().catch(() => {});
        return NextResponse.json({ error: "Login body is too large" }, { status: 413 });
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
    body = JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)));
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  } finally {
    reader.releaseLock();
  }

  const parsed = LoginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Password is required" }, { status: 400 });
  }

  if (parsed.data.password !== process.env.ACCESS_PASSWORD) {
    return NextResponse.json({ error: "Invalid access password" }, { status: 401 });
  }

  const token = await createSessionToken();
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions(SESSION_MAX_AGE));
  return response;
}
