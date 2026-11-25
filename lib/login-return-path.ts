export function getLoginReturnPath(value: string | null): string {
  if (!value?.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";

  try {
    const origin = "https://model-compass.invalid";
    const target = new URL(value, origin);
    const pathname = decodeURIComponent(target.pathname);
    if (
      target.origin !== origin ||
      pathname.startsWith("//") ||
      pathname.startsWith("/\\") ||
      pathname.replace(/\/+$/, "") === "/login" ||
      pathname.startsWith("/api/")
    ) return "/";
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/";
  }
}
