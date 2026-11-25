// Build-input fingerprint: the single source of truth for which inputs make
// up a production build and how their freshness fingerprint is computed.
//
// Scope of the input set (buildInputs below): every source tree and config
// file that can change the output of `next build` — the app/components/config/
// lib/public/types source trees, the root framework/config files, package
// manifests, and the env files Next.js loads at build time. Each input is
// hashed by relative path + file content (sha256); mtimes are never used, so
// checkouts, copies and CI cache restores cannot produce a false "fresh".
//
// `npm run build` runs this script via postbuild and records the fingerprint
// in .next/build-fingerprint.json; tests/auth-production.test.ts compares the
// recorded value against a freshly computed one to reject stale prebuilt
// bundles.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const buildFingerprintPath = ".next/build-fingerprint.json";

export const buildInputs = [
  "app", "components", "config", "lib", "public", "types",
  "instrumentation.ts", "middleware.ts", "next.config.ts", "postcss.config.mjs",
  "tailwind.config.ts", "tsconfig.json", ".eslintrc.json", "next-env.d.ts",
  "package.json", "package-lock.json",
  ".env", ".env.local", ".env.production", ".env.production.local",
];

function collectFiles(root, input, files) {
  const absolute = join(root, input);
  const stats = statSync(absolute, { throwIfNoEntry: false });
  if (!stats) return; // Optional inputs (e.g. public/, .env*) may be absent.
  if (stats.isDirectory()) {
    for (const entry of readdirSync(absolute).sort()) {
      collectFiles(root, join(input, entry), files);
    }
    return;
  }
  if (!stats.isFile()) {
    throw new Error(`Build input is neither a file nor a directory: ${input}`);
  }
  files.push(input);
}

export function getBuildFingerprint(root = process.cwd()) {
  const hash = createHash("sha256");
  for (const input of buildInputs) {
    const files = [];
    collectFiles(root, input, files);
    for (const file of files) {
      const contentHash = createHash("sha256").update(readFileSync(join(root, file))).digest("hex");
      hash.update(`${JSON.stringify([relative(root, join(root, file)), contentHash])}\n`);
    }
  }
  return hash.digest("hex");
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  writeFileSync(buildFingerprintPath, `${JSON.stringify({ fingerprint: getBuildFingerprint() })}\n`);
}
