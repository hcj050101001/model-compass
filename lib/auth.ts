import { getAuthConfigError } from "./auth-config";

export const SESSION_COOKIE_NAME = "llm_frontier_session";
export const SESSION_MAX_AGE = 7 * 24 * 60 * 60;
const SESSION_VERSION = 1;
const SESSION_ROLE = "viewer";

export function sessionCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(str: string): Uint8Array<ArrayBuffer> {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function sessionKey(usage: "sign" | "verify"): Promise<CryptoKey> {
  const secret = process.env.SESSION_SECRET;
  const configError = getAuthConfigError();
  if (configError || !secret) throw new Error(configError ?? "SESSION_SECRET is required.");

  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage]
  );
}

export async function createSessionToken(): Promise<string> {
  const exp = Date.now() + SESSION_MAX_AGE * 1000;
  const payload = JSON.stringify({ v: SESSION_VERSION, role: SESSION_ROLE, exp });
  const enc = new TextEncoder();
  const encodedPayload = toBase64Url(enc.encode(payload));
  const signature = await crypto.subtle.sign("HMAC", await sessionKey("sign"), enc.encode(encodedPayload));
  return `${encodedPayload}.${toBase64Url(new Uint8Array(signature))}`;
}

export async function verifySessionToken(
  token: string | undefined | null
): Promise<{ valid: true; role: typeof SESSION_ROLE } | { valid: false }> {
  if (!token) return { valid: false };
  const parts = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!parts) return { valid: false };
  const [, encodedPayload, signature] = parts;

  try {
    const verified = await crypto.subtle.verify(
      "HMAC",
      await sessionKey("verify"),
      fromBase64Url(signature),
      new TextEncoder().encode(encodedPayload)
    );
    if (!verified) return { valid: false };

    const decoded = new TextDecoder().decode(fromBase64Url(encodedPayload));
    const parsed = JSON.parse(decoded);
    if (
      parsed?.v !== SESSION_VERSION ||
      parsed.role !== SESSION_ROLE ||
      !Number.isFinite(parsed.exp) ||
      parsed.exp <= Date.now()
    ) {
      return { valid: false };
    }
    return { valid: true, role: SESSION_ROLE };
  } catch {
    return { valid: false };
  }
}
