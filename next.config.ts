import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Preserve the listener origin so Next can send same-origin middleware redirects as relative URLs.
  skipMiddlewareUrlNormalize: true,
  serverExternalPackages: ["@libsql/client", "geoip-country"],
};

export default nextConfig;
