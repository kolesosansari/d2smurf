import { scryptSync, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";

const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const SCRYPT_N = 1 << 15; // 32768
const SCRYPT_R = 8;
const SCRYPT_P = 1;

export interface DerivedKey {
  key: Buffer;
  salt: Buffer;
}

export function deriveKey(masterPassword: string, salt?: Buffer): DerivedKey {
  const useSalt = salt ?? randomBytes(SALT_LEN);
  const key = scryptSync(masterPassword, useSalt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  return { key, salt: useSalt };
}

export function encryptBlob(key: Buffer, plaintext: Buffer | string): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plain = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, "utf8");
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

export function decryptBlob(key: Buffer, payload: Buffer): Buffer {
  if (payload.length < IV_LEN + TAG_LEN) throw new Error("Payload too short");
  const iv = payload.subarray(0, IV_LEN);
  const tag = payload.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = payload.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function makeVerifier(key: Buffer): Buffer {
  const known = Buffer.from("d2smurf-vault-v1", "utf8");
  return encryptBlob(key, known);
}

export function checkVerifier(key: Buffer, verifier: Buffer): boolean {
  try {
    const dec = decryptBlob(key, verifier);
    const expected = Buffer.from("d2smurf-vault-v1", "utf8");
    return constantTimeEqual(dec, expected);
  } catch {
    return false;
  }
}
