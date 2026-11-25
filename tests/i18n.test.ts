import { describe, expect, it } from "vitest";
import {
  detectLocaleFromIp,
  extractClientIp,
  resolveRequestLocale,
} from "@/lib/i18n/locale";

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
