import { describe, expect, it, vi } from "vitest";
import { credentialsMatch, delayFailedCredential, getRecordedFailureCount } from "@/lib/credentials-match";

describe("credentialsMatch", () => {
  it.each([
    ["equal strings", "credential", "credential", true],
    ["unequal strings of equal length", "credential", "Credential", false],
    ["unequal strings of different lengths", "credential", "credentials", false],
    ["empty versus nonempty", "", "credential", false],
    ["an unpaired surrogate versus U+FFFD", "credential\uD800", "credential\uFFFD", false],
    ["identical unpaired surrogates", "credential\uD800", "credential\uD800", true],
    ["identical non-ASCII strings", "pässwörd✓", "pässwörd✓", true],
    ["two empty strings", "", "", true],
  ] as const)("compares %s without throwing", (_label, provided, expected, matches) => {
    expect(credentialsMatch(provided, expected)).toBe(matches);
  });
});

it("evicts excess failure records and caps the overflow delay at two seconds", async () => {
  vi.useFakeTimers();
  try {
    const headers = new Headers();
    const failures = Array.from({ length: 47 }, () => delayFailedCredential(headers));
    expect(getRecordedFailureCount()).toBe(47);

    const completed = vi.fn();
    const overflow = Array.from({ length: 5 }, () => delayFailedCredential(headers).then(completed));
    expect(getRecordedFailureCount()).toBe(47);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(completed).toHaveBeenCalledTimes(overflow.length);
    await Promise.all([...failures, ...overflow]);
  } finally {
    vi.useRealTimers();
  }
});

it("evicts the oldest failures when batches with different timestamps overflow", async () => {
  vi.resetModules();
  const { delayFailedCredential, getRecordedFailureCount } = await import("@/lib/credentials-match");
  vi.useFakeTimers({ now: 0 });
  vi.stubEnv("TRUST_PROXY", "true");
  try {
    const headers = new Headers();
    const older = Array.from({ length: 5 }, () => delayFailedCredential(headers));
    await vi.advanceTimersByTimeAsync(1_000);
    const newer = Array.from({ length: 47 }, () => delayFailedCredential(headers));
    expect(getRecordedFailureCount()).toBe(47);

    // Only the older batch's window has expired. The probe prunes expired records.
    await vi.advanceTimersByTimeAsync(59_001);
    const completed = vi.fn();
    const probe = delayFailedCredential(new Headers({ "x-forwarded-for": "192.0.2.1" })).then(completed);
    expect(getRecordedFailureCount()).toBe(47);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(completed).toHaveBeenCalledTimes(1);
    await Promise.all([...older, ...newer, probe]);
  } finally {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  }
});
