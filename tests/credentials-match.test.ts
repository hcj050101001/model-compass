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
