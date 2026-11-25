const PLACEHOLDER = /^(?:change[-_ ]*me|replace[-_ ]*me|placeholder|your[-_ ]|example|sample|dummy|default|dev[-_ ]|test[-_ ]|insert[-_ ]|set[-_ ]*me|todo)/i;

export function isPrivateMode(): boolean {
  return process.env.PRIVATE_MODE !== "false";
}

function isUsableCredential(value: string | undefined, minLength: number): boolean {
  return Boolean(
    value &&
      value === value.trim() &&
      value.length >= minLength &&
      new Set(value).size >= 8 &&
      !PLACEHOLDER.test(value) &&
      !/^(.+?)\1+$/.test(value)
  );
}

export function getAuthConfigError(): string | undefined {
  const { PRIVATE_MODE, SESSION_SECRET, ACCESS_PASSWORD } = process.env;
  const production = process.env.NODE_ENV === "production";
  if (production && PRIVATE_MODE !== "true" && PRIVATE_MODE !== "false") {
    return 'PRIVATE_MODE must be explicitly set to "true" or "false".';
  }
  if (!production && !isPrivateMode()) return;

  if (!isUsableCredential(SESSION_SECRET, 32)) {
    return "SESSION_SECRET must be an independently generated random value of at least 32 characters.";
  }
  if (!isUsableCredential(ACCESS_PASSWORD, 24)) {
    return "ACCESS_PASSWORD must be an independently generated random value of at least 24 characters.";
  }
  if (SESSION_SECRET === ACCESS_PASSWORD) {
    return "SESSION_SECRET and ACCESS_PASSWORD must be different.";
  }
}
