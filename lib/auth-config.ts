const PLACEHOLDER = /^(?:change[-_ ]*me|replace[-_ ]*me|placeholder|your[-_ ]|example|sample|dummy|default|dev[-_ ]|test[-_ ]|insert[-_ ]|set[-_ ]*me|todo)/i;

const PREDICTABLE_RUN_LENGTH = 8;
const predictableRuns = new Set<string>();
for (const ring of [
  "0123456789",
  "0123456789abcdef",
  "abcdefghijklmnopqrstuvwxyz",
  "qwertyuiopasdfghjklzxcvbnm",
  "1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p",
]) {
  for (let start = 0; start < ring.length; start++) {
    for (const step of [1, 2, -1, -2]) {
      let run = "";
      let position = start;
      for (let length = 0; length < PREDICTABLE_RUN_LENGTH; length++) {
        run += ring[position];
        position = (position + step + ring.length) % ring.length;
      }
      predictableRuns.add(run);
    }
  }
}

export function isPrivateMode(): boolean {
  return process.env.PRIVATE_MODE !== "false";
}

function hasPredictableRun(value: string): boolean {
  for (let start = 0; start <= value.length - PREDICTABLE_RUN_LENGTH; start++) {
    if (predictableRuns.has(value.slice(start, start + PREDICTABLE_RUN_LENGTH))) return true;
  }
  return false;
}

function hasPredictableSequence(value: string): boolean {
  if (hasPredictableRun(value)) return true;
  if (value.length < PREDICTABLE_RUN_LENGTH * 2 - 1) return false;

  let evenTrack = "";
  let oddTrack = "";
  for (let index = 0; index < value.length; index += 2) {
    evenTrack += value[index];
    oddTrack += value[index + 1] ?? "";
  }
  return hasPredictableRun(evenTrack) || hasPredictableRun(oddTrack);
}

function isPredictableCredential(value: string): boolean {
  const raw = value.toLowerCase();
  const alphanumeric = raw.replace(/[^a-z0-9]/g, "");
  return hasPredictableSequence(raw) ||
    (alphanumeric !== raw && hasPredictableSequence(alphanumeric));
}

function isUsableCredential(value: string | undefined, minLength: number): boolean {
  return Boolean(
    value &&
      value === value.trim() &&
      value.length >= minLength &&
      new Set(value).size >= 8 &&
      !PLACEHOLDER.test(value) &&
      !/^(.+?)\1+$/.test(value) &&
      !isPredictableCredential(value)
  );
}

export function getAdminTokenConfigError(token: string | undefined): string | undefined {
  if (!token) return;
  if (!isUsableCredential(token, 32)) {
    return "ADMIN_TOKEN must be an independently generated random value of at least 32 characters.";
  }
  if (token === process.env.SESSION_SECRET || token === process.env.ACCESS_PASSWORD) {
    return "ADMIN_TOKEN must be different from SESSION_SECRET and ACCESS_PASSWORD.";
  }
}

export function getAuthConfigError(): string | undefined {
  const { PRIVATE_MODE, SESSION_SECRET, ACCESS_PASSWORD, ADMIN_TOKEN } = process.env;
  const production = process.env.NODE_ENV === "production";
  if (production && PRIVATE_MODE !== "true" && PRIVATE_MODE !== "false") {
    return 'PRIVATE_MODE must be explicitly set to "true" or "false".';
  }
  if (!production && !isPrivateMode()) return getAdminTokenConfigError(ADMIN_TOKEN);

  if (!isUsableCredential(SESSION_SECRET, 32)) {
    return "SESSION_SECRET must be an independently generated random value of at least 32 characters.";
  }
  if (!isUsableCredential(ACCESS_PASSWORD, 24)) {
    return "ACCESS_PASSWORD must be an independently generated random value of at least 24 characters.";
  }
  if (SESSION_SECRET === ACCESS_PASSWORD) {
    return "SESSION_SECRET and ACCESS_PASSWORD must be different.";
  }
  return getAdminTokenConfigError(ADMIN_TOKEN);
}

// Next's Node instrumentation imports this module at startup in development too.
if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "development" && !isPrivateMode()) {
  const configError = getAuthConfigError();
  if (configError) {
    console.error(`[auth] ${configError}`);
    process.exit(1);
  }
}
