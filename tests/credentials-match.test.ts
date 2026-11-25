import { describe, expect, it } from "vitest";
import { credentialsMatch } from "@/lib/credentials-match";

describe("credentialsMatch", () => {
  it.each([
    ["equal strings", "credential", "credential", true],
    ["unequal strings of equal length", "credential", "Credential", false],
    ["unequal strings of different lengths", "credential", "credentials", false],
    ["empty versus nonempty", "", "credential", false],
    ["an unpaired surrogate versus U+FFFD", "credential\uD800", "credential\uFFFD", false],
  ] as const)("compares %s without throwing", (_label, provided, expected, matches) => {
    expect(credentialsMatch(provided, expected)).toBe(matches);
  });
});
