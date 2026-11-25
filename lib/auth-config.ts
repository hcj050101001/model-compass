const PLACEHOLDER = /^(?:change[-_ ]*me|replace[-_ ]*me|placeholder|your[-_ ]|example|sample|dummy|default|dev[-_ ]|test[-_ ]|insert[-_ ]|set[-_ ]*me|todo)/i;

const PREDICTABLE_RUN_LENGTH = 8;
const SEQUENCE_RINGS = [
  "0123456789",
  "0123456789abcdef",
  "abcdefghijklmnopqrstuvwxyz",
  // Catch alphabetic progressions that continue through decimal digits.
  "abcdefghijklmnopqrstuvwxyz0123456789",
  "qwertyuiopasdfghjklzxcvbnm",
  "1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p",
];

export function isPrivateMode(): boolean {
  return process.env.PRIVATE_MODE !== "false";
}

function hasPredictableRun(value: string, ring: string, stride: number, offset: number): boolean {
  let previousPosition = -1;
  let previousDifference = 0;
  let runLength = 1;
  for (let index = offset; index < value.length; index += stride) {
    const position = ring.indexOf(value[index]);
    const difference = position < 0 || previousPosition < 0
      ? 0
      : (position - previousPosition + ring.length) % ring.length;

    if (difference === 0) {
      runLength = 1;
    } else {
      runLength = difference === previousDifference ? runLength + 1 : 2;
      if (runLength >= PREDICTABLE_RUN_LENGTH) return true;
    }
    previousDifference = difference;
    previousPosition = position;
  }
  return false;
}

function hasPredictableSequence(value: string): boolean {
  const maxStride = Math.floor(value.length / PREDICTABLE_RUN_LENGTH);
  for (let stride = 1; stride <= maxStride; stride++) {
    for (let offset = 0; offset < stride; offset++) {
      for (const ring of SEQUENCE_RINGS) {
        if (hasPredictableRun(value, ring, stride, offset)) return true;
      }
    }
  }
  return false;
}

function hasRepeatedCharacterRun(value: string): boolean {
  let previousCharacter = "";
  let runLength = 0;
  for (const character of value) {
    runLength = character === previousCharacter ? runLength + 1 : 1;
    if (runLength >= PREDICTABLE_RUN_LENGTH) return true;
    previousCharacter = character;
  }
  return false;
}

function isPredictableCredential(value: string): boolean {
  if (hasRepeatedCharacterRun(value)) return true;
  const raw = value.toLowerCase();
  const alphanumeric = raw.replace(/[^a-z0-9]/g, "");
  return (alphanumeric !== value && hasRepeatedCharacterRun(alphanumeric)) ||
    hasPredictableSequence(raw) ||
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
