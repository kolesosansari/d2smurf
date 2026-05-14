import { app } from "electron";
import { join } from "node:path";
import { closeDb, openDb } from "../database/db";
import { deriveKey, encryptBlob, decryptBlob } from "../crypto/master-password";
import { JsonStore } from "./json-store";
import type { VaultStatus, VaultUnlockResult } from "@shared/types";

interface VaultMetadata extends Record<string, unknown> {
  saltB64: string;
  verifierB64: string;
  createdAt: number;
}

let metadataStore: JsonStore<VaultMetadata> | null = null;

function metadata(): JsonStore<VaultMetadata> {
  if (!metadataStore) {
    metadataStore = new JsonStore<VaultMetadata>(
      join(app.getPath("userData"), "vault-meta.json"),
    );
  }
  return metadataStore;
}

let derivedKey: Buffer | null = null;
let unlockedAt: number | null = null;

export function getStatus(): VaultStatus {
  const meta = metadata();
  const isInitialized = !!meta.get("saltB64") && !!meta.get("verifierB64");
  return {
    isInitialized,
    isUnlocked: derivedKey !== null,
  };
}

export function isUnlocked(): boolean {
  return derivedKey !== null;
}

export function getUnlockedSince(): number | null {
  return unlockedAt;
}

export function initializeVault(masterPassword: string): VaultUnlockResult {
  if (!masterPassword || masterPassword.length < 4) {
    return { ok: false, error: "Master password must be at least 4 characters." };
  }
  const meta = metadata();
  if (meta.get("saltB64")) {
    return { ok: false, error: "Vault already initialized. Use unlock instead." };
  }
  const { key, salt } = deriveKey(masterPassword);
  const verifier = encryptBlob(key, "d2smurf-vault-v1");
  meta.set("saltB64", salt.toString("base64"));
  meta.set("verifierB64", verifier.toString("base64"));
  meta.set("createdAt", Date.now());

  derivedKey = key;
  unlockedAt = Date.now();
  try {
    openDb(masterPassword);
  } catch (err) {
    derivedKey = null;
    unlockedAt = null;
    meta.delete("saltB64");
    meta.delete("verifierB64");
    return { ok: false, error: (err as Error).message };
  }
  return { ok: true };
}

export function unlockVault(masterPassword: string): VaultUnlockResult {
  const meta = metadata();
  const saltB64 = meta.get("saltB64");
  const verifierB64 = meta.get("verifierB64");
  if (!saltB64 || !verifierB64) {
    return { ok: false, error: "Vault is not initialized." };
  }
  const salt = Buffer.from(saltB64, "base64");
  const { key } = deriveKey(masterPassword, salt);
  try {
    const verifier = Buffer.from(verifierB64, "base64");
    const decrypted = decryptBlob(key, verifier);
    if (decrypted.toString("utf8") !== "d2smurf-vault-v1") {
      return { ok: false, error: "Invalid master password." };
    }
  } catch {
    return { ok: false, error: "Invalid master password." };
  }

  try {
    openDb(masterPassword);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  derivedKey = key;
  unlockedAt = Date.now();
  return { ok: true };
}

export function lockVault(): void {
  derivedKey = null;
  unlockedAt = null;
  closeDb();
}

export function getDerivedKey(): Buffer | null {
  return derivedKey;
}

/**
 * Test helpers: allows pointing the metadata store at an alternative path
 * so unit tests can run without Electron's userData directory.
 */
export function _setMetadataStoreForTesting(store: JsonStore<VaultMetadata>): void {
  metadataStore = store;
}

export function _resetForTesting(): void {
  derivedKey = null;
  unlockedAt = null;
}
