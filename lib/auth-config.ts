const PLACEHOLDER = /^(?:change[-_ ]*me|replace[-_ ]*me|placeholder|your[-_ ]|example|sample|dummy|default|dev[-_ ]|test[-_ ]|insert[-_ ]|set[-_ ]*me|todo)/i;

const PREDICTABLE_RUN_LENGTH = 8;
const INTERLEAVED_RUN_LENGTH = PREDICTABLE_RUN_LENGTH * 2 - 1;
const ALTERNATING_LETTERS_AND_DIGITS = /^(?:(?:[a-z]\d)+[a-z]|(?:\d[a-z])+\d)$/;
const predictableRuns = new Set<string>();
for (const sequence of [
  "34567890123456",
  "0123456789abcdef",
  "qwertyuiopasdfghjklzxcvbnm",
  "1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p",
]) {
  for (let start = 0; start <= sequence.length - PREDICTABLE_RUN_LENGTH; start++) {
    const run = sequence.slice(start, start + PREDICTABLE_RUN_LENGTH);
    predictableRuns.add(run);
    predictableRuns.add([...run].reverse().join(""));
  }
}

export function isPrivateMode(): boolean {
  return process.env.PRIVATE_MODE !== "false";
}

function hasPredictableRun(value: string): boolean {
  for (let start = 0; start <= value.length - PREDICTABLE_RUN_LENGTH; start++) {
    const run = value.slice(start, start + PREDICTABLE_RUN_LENGTH);
    if (predictableRuns.has(run)) return true;
    const first = run.charCodeAt(0);
    const step = run.charCodeAt(1) - first;
    if (
      Math.abs(step) === 1 &&
      /^[a-z0-9]+$/.test(run) &&
      [...run].every((char, index) => char.charCodeAt(0) === first + step * index)
    ) return true;
  }
  return false;
}

function hasInterleavedPredictableRun(value: string): boolean {
  for (let start = 0; start <= value.length - INTERLEAVED_RUN_LENGTH; start++) {
    const run = value.slice(start, start + INTERLEAVED_RUN_LENGTH);
    if (!ALTERNATING_LETTERS_AND_DIGITS.test(run)) continue;
    const sequence = [...run].filter((_, index) => index % 2 === 0).join("");
    if (hasPredictableRun(sequence)) return true;
  }
  return false;
}

function isPredictableCredential(value: string): boolean {
  const raw = value.toLowerCase();
  const alphanumeric = raw.replace(/[^a-z0-9]/g, "");
  return hasPredictableRun(raw) ||
    (alphanumeric !== raw && hasPredictableRun(alphanumeric)) ||
    hasInterleavedPredictableRun(alphanumeric);
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
