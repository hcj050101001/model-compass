import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

const FAILURE_WINDOW_MS = 60_000;
const BASE_FAILURE_DELAY_MS = 300;
const FAILURE_DELAY_STEP_MS = 100;
const MAX_FAILURE_DELAY_MS = 2_000;
const GLOBAL_FAILURE_THRESHOLD = 30;
const MAX_RECORDED_FAILURES = GLOBAL_FAILURE_THRESHOLD +
  (MAX_FAILURE_DELAY_MS - BASE_FAILURE_DELAY_MS) / FAILURE_DELAY_STEP_MS;

const failures: { source: string | undefined; at: number }[] = [];

function credentialDigest(value: string): Buffer {
  // Hash JavaScript code units so an unpaired surrogate cannot match a replacement character.
  return createHash("sha256").update(value, "utf16le").digest();
}

export function credentialsMatch(provided: string, expected: string): boolean {
  return timingSafeEqual(credentialDigest(provided), credentialDigest(expected));
}

function getTrustedSource(headers: Headers): string | undefined {
  if (process.env.TRUST_PROXY !== "true") return;
  // The trusted proxy must write its peer address as the last entry.
  const forwarded = headers.get("x-forwarded-for") ?? "";
  const address = forwarded.slice(forwarded.lastIndexOf(",") + 1).trim();
  if (isIP(address)) return address;
}

export function delayFailedCredential(headers: Headers): Promise<void> {
  const now = Date.now();
  const expiresBefore = now - FAILURE_WINDOW_MS;
  while (failures.length && failures[0].at <= expiresBefore) failures.shift();

  // At capacity the global delay is capped. Discarded failures expire before the retained ones.
  if (failures.length === MAX_RECORDED_FAILURES) failures.shift();
  const source = getTrustedSource(headers);
  failures.push({ source, at: now });

  const sourceFailures = failures.filter((failure) => failure.source === source).length;
  const delaySteps = Math.max(sourceFailures - 1, failures.length - GLOBAL_FAILURE_THRESHOLD);
  const delay = Math.min(MAX_FAILURE_DELAY_MS, BASE_FAILURE_DELAY_MS + FAILURE_DELAY_STEP_MS * delaySteps);
  return new Promise((resolve) => setTimeout(resolve, delay));
}
