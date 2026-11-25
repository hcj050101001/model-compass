import geoip from "geoip-country";
import { LOCALE_COOKIE_NAME, type Locale } from "./messages";

export { LOCALE_COOKIE_NAME, type Locale };

const ZH_COUNTRIES = new Set(["CN", "HK", "MO", "TW"]);

export function extractClientIp(
  forwardedFor?: string | null,
  realIp?: string | null
): string | null {
  const raw = forwardedFor?.split(",")[0]?.trim() || realIp?.trim() || null;
  if (!raw) return null;
  return raw.replace(/^::ffff:/i, "");
}

export function detectLocaleFromIp(
  ip: string | null | undefined,
  acceptLanguage?: string | null
): Locale {
  if (ip) {
    const cleaned = ip.replace(/^::ffff:/i, "").trim();
    const res = geoip.lookup(cleaned);
    if (res && res.country) {
      return ZH_COUNTRIES.has(res.country.toUpperCase()) ? "zh" : "en";
    }
  }

  if (acceptLanguage && /^zh\b/i.test(acceptLanguage.trim())) {
    return "zh";
  }

  return "en";
}

export function resolveRequestLocale(params: {
  cookieLocale?: string | null;
  forwardedFor?: string | null;
  realIp?: string | null;
  acceptLanguage?: string | null;
}): Locale {
  if (params.cookieLocale === "zh" || params.cookieLocale === "en") {
    return params.cookieLocale;
  }
  const ip = extractClientIp(params.forwardedFor, params.realIp);
  return detectLocaleFromIp(ip, params.acceptLanguage);
}
