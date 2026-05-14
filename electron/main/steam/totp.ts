import { createHmac } from "node:crypto";

const STEAM_CHARS = "23456789BCDFGHJKMNPQRTVWXY";

/**
 * Generate a Steam 5-character TOTP code from a base64 shared_secret.
 * Pure implementation — no external deps, suitable for use without
 * the `steam-totp` package being installed yet.
 */
export function generateSteamGuardCode(sharedSecretBase64: string, timeOverride?: number): string {
  if (!sharedSecretBase64) throw new Error("shared_secret is required");
  const secret = Buffer.from(sharedSecretBase64, "base64");
  const now = Math.floor((timeOverride ?? Date.now() / 1000) / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(0, 0);
  buf.writeUInt32BE(now, 4);
  const hmac = createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  let codeInt =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  let code = "";
  for (let i = 0; i < 5; i += 1) {
    code += STEAM_CHARS.charAt(codeInt % STEAM_CHARS.length);
    codeInt = Math.floor(codeInt / STEAM_CHARS.length);
  }
  return code;
}

export function secondsLeftInWindow(timeOverride?: number): number {
  const t = timeOverride ?? Date.now() / 1000;
  return 30 - (Math.floor(t) % 30);
}
