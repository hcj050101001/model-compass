import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

const FAILURE_WINDOW_MS = 60_000;
const SOURCE_FAILURE_LIMIT = 5;
const GLOBAL_FAILURE_LIMIT = 30;
const FAILED_CREDENTIAL_DELAY_MS = 300;

function credentialDigest(value: string): Buffer {
  // Hash JavaScript code units so an unpaired surrogate cannot match a replacement character.
  return createHash("sha256").update(value, "utf16le").digest();
}

export function credentialsMatch(provided: string, expected: string): boolean {
  return timingSafeEqual(credentialDigest(provided), credentialDigest(expected));
}

type CredentialAttempt =
  | { status: "accepted" | "rejected" }
  | { status: "limited"; retryAfter: number };

export function createCredentialRateLimiter() {
  const failures: { source: string; at: number }[] = [];

  return function checkAttempt(headers: Headers, matches: () => boolean): CredentialAttempt {
    const now = Date.now();
    const expiresBefore = now - FAILURE_WINDOW_MS;
    while (failures.length && failures[0].at <= expiresBefore) failures.shift();

    // The nearest proxy must append or overwrite its peer address. The global limit covers all sources.
    const forwarded = headers.get("x-forwarded-for") ?? "";
    const address = forwarded.slice(forwarded.lastIndexOf(",") + 1).trim();
    const source = isIP(address) ? address : "";
    const sourceFailures = failures.filter((failure) => failure.source === source);
    const sourceBlockedUntil = sourceFailures.length >= SOURCE_FAILURE_LIMIT
      ? sourceFailures[0].at + FAILURE_WINDOW_MS
      : 0;
    const globallyBlockedUntil = failures.length >= GLOBAL_FAILURE_LIMIT
      ? failures[0].at + FAILURE_WINDOW_MS
      : 0;
    const blockedUntil = Math.max(sourceBlockedUntil, globallyBlockedUntil);
    if (blockedUntil > now) {
      return { status: "limited", retryAfter: Math.ceil((blockedUntil - now) / 1000) };
    }

    if (matches()) return { status: "accepted" };
    // Record the failure before the route awaits the response delay, including under concurrency.
    failures.push({ source, at: now });
    return { status: "rejected" };
  };
}

export function delayFailedCredential(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, FAILED_CREDENTIAL_DELAY_MS));
}
