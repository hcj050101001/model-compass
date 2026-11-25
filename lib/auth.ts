export const SESSION_COOKIE_NAME = "llm_frontier_session";

function getSecret(): string {
  return (
    process.env.SESSION_SECRET ||
    process.env.ACCESS_PASSWORD ||
    "dev-fallback-secret-change-in-prod"
  );
}

export function isPrivateMode(): boolean {
  return process.env.PRIVATE_MODE !== "false";
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function signHmac(data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(getSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return toBase64Url(new Uint8Array(sig));
}

export async function createSessionToken(role = "viewer"): Promise<string> {
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
  const payload = JSON.stringify({ role, exp });
  const enc = new TextEncoder();
  const encodedPayload = toBase64Url(enc.encode(payload));
  const sig = await signHmac(encodedPayload);
  return `${encodedPayload}.${sig}`;
}

export async function verifySessionToken(
  token: string | undefined | null
): Promise<{ valid: boolean; role?: string }> {
  if (!token) return { valid: false };
  const parts = token.split(".");
  if (parts.length !== 2) return { valid: false };
  const [encodedPayload, sig] = parts;
  const expectedSig = await signHmac(encodedPayload);
  if (sig.length !== expectedSig.length) return { valid: false };
  let diff = 0;
  for (let i = 0; i < sig.length; i++) {
    diff |= sig.charCodeAt(i) ^ expectedSig.charCodeAt(i);
  }
  if (diff !== 0) return { valid: false };

  try {
    const decoded = new TextDecoder().decode(fromBase64Url(encodedPayload));
    const parsed = JSON.parse(decoded) as { role?: string; exp?: number };
    if (!parsed.exp || Date.now() > parsed.exp) {
      return { valid: false };
    }
    return { valid: true, role: parsed.role ?? "viewer" };
  } catch {
    return { valid: false };
  }
}
