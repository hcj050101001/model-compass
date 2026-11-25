const PLACEHOLDER = /^(?:change[-_ ]*me|replace[-_ ]*me|placeholder|your[-_ ]|example|sample|dummy|default|dev[-_ ]|test[-_ ]|insert[-_ ]|set[-_ ]*me|todo)/i;

const PREDICTABLE_RUN_LENGTH = 8;
const predictableRuns = new Set<string>();
for (const sequence of [
  "01234567890123456789",
  "abcdefghijklmnopqrstuvwxyz",
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
  const normalized = value.toLowerCase();
  for (let start = 0; start <= normalized.length - PREDICTABLE_RUN_LENGTH; start++) {
    if (predictableRuns.has(normalized.slice(start, start + PREDICTABLE_RUN_LENGTH))) return true;
  }
  return false;
}

function isUsableCredential(value: string | undefined, minLength: number): boolean {
  return Boolean(
    value &&
      value === value.trim() &&
      value.length >= minLength &&
      new Set(value).size >= 8 &&
      !PLACEHOLDER.test(value) &&
      !/^(.+?)\1+$/.test(value) &&
      !hasPredictableRun(value)
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
