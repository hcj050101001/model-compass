import type { MetadataRoute } from "next";

// Package G (AC-G4 / ADR-8): the sitemap lists exactly the two public
// routes. /settings (signed-in page) and /login must never be listed.
const SITE_ORIGIN = "https://llm.nianhub.com";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE_ORIGIN}/` },
    { url: `${SITE_ORIGIN}/compare` },
  ];
}
