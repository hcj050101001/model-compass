import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import { LocaleProvider } from "@/components/i18n/LocaleProvider";
import { LOCALE_COOKIE_NAME, resolveRequestLocale } from "@/lib/i18n/locale";
import "./globals.css";

export const metadata: Metadata = {
  title: "ModelCompass · 智价罗盘 — AI Model Intelligence & Cost",
  description:
    "Unified cost-vs-intelligence analytics dashboard for AI models and reasoning effort levels across coding, research, and agent tasks.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0b0f17" },
    { media: "(prefers-color-scheme: light)", color: "#f8fafc" },
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const headerList = await headers();
  const cookieStore = await cookies();

  const initialLocale = resolveRequestLocale({
    cookieLocale: cookieStore.get(LOCALE_COOKIE_NAME)?.value,
    forwardedFor: headerList.get("x-forwarded-for"),
    realIp: headerList.get("x-real-ip"),
    acceptLanguage: headerList.get("accept-language"),
  });

  return (
    <html lang={initialLocale} className="dark" suppressHydrationWarning>
      <body className="min-h-screen overflow-x-clip bg-bg-primary text-text-primary antialiased">
        <LocaleProvider initialLocale={initialLocale}>
          {children}
        </LocaleProvider>
      </body>
    </html>
  );
}
