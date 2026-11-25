import { describe, expect, it } from "vitest";
import {
  detectLocaleFromIp,
  extractClientIp,
  resolveRequestLocale,
} from "@/lib/i18n/locale";
import { messages } from "@/lib/i18n/messages";

describe("IP Geolocation Locale Detection", () => {
  it("maps Mainland China / HK / MO / TW IPs to zh", () => {
    expect(detectLocaleFromIp("223.5.5.5")).toBe("zh");
    expect(detectLocaleFromIp("114.114.114.114")).toBe("zh");
    expect(detectLocaleFromIp("::ffff:223.5.5.5")).toBe("zh");
  });

  it("maps foreign IPs to en", () => {
    expect(detectLocaleFromIp("8.8.8.8")).toBe("en");
    expect(detectLocaleFromIp("1.1.1.1")).toBe("en");
  });

  it("extracts first IP from x-forwarded-for", () => {
    expect(extractClientIp("223.5.5.5, 127.0.0.1", null)).toBe("223.5.5.5");
  });

  it("respects manual cookie override over IP geolocation", () => {
    expect(
      resolveRequestLocale({
        cookieLocale: "en",
        forwardedFor: "223.5.5.5",
      })
    ).toBe("en");
    expect(
      resolveRequestLocale({
        cookieLocale: "zh",
        forwardedFor: "8.8.8.8",
      })
    ).toBe("zh");
  });

  it("falls back to Accept-Language for private/loopback IPs", () => {
    expect(detectLocaleFromIp("127.0.0.1", "zh-CN,zh;q=0.9")).toBe("zh");
    expect(detectLocaleFromIp("127.0.0.1", "en-US,en;q=0.9")).toBe("en");
  });
});

// Package G (AC-G2/G5): bilingual copy parity for the public header
// navigation and the touch hint.
describe("Bilingual messages for navigation and touch hints", () => {
  it("keeps the zh and en message key sets identical", () => {
    expect(Object.keys(messages.zh).sort()).toEqual(
      Object.keys(messages.en).sort()
    );
  });

  it("provides non-empty navigation labels in both locales", () => {
    for (const key of ["navDashboard", "navCompare", "navSettings"] as const) {
      expect(messages.zh[key].trim().length).toBeGreaterThan(0);
      expect(messages.en[key].trim().length).toBeGreaterThan(0);
    }
  });

  it("points the touch chart hint at the leaderboard cards in both locales", () => {
    expect(messages.zh.mobileChartHint).toContain("排行榜");
    expect(messages.en.mobileChartHint.toLowerCase()).toContain("leaderboard");
  });
});
