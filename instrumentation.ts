import { getAuthConfigError } from "./lib/auth-config";

export function register(): void {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") {
    return;
  }
  if (process.env.NODE_ENV !== "production") return;

  const configError = getAuthConfigError();
  if (configError) {
    console.error(`[auth] ${configError}`);
    process.exit(1);
  }
}

// Next loads this module before announcing readiness, but awaits register() later in production.
register();
