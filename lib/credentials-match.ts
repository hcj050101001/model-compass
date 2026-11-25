import { createHash, timingSafeEqual } from "node:crypto";

function credentialDigest(value: string): Buffer {
  // Hash JavaScript code units so an unpaired surrogate cannot match a replacement character.
  return createHash("sha256").update(value, "utf16le").digest();
}

export function credentialsMatch(provided: string, expected: string): boolean {
  return timingSafeEqual(credentialDigest(provided), credentialDigest(expected));
}
