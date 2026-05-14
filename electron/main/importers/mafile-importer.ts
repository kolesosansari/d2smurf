import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import type { MaFileSecrets } from "@shared/types";

/**
 * `.maFile` files produced by Steam Desktop Authenticator are JSON.
 * Some are wrapped with an `"AccountName"` and contain nested `Session` data.
 * We only need the secrets that allow us to generate 2FA codes
 * and confirm logins/trades through the mobile API.
 */
export interface ParsedMaFile {
  secrets: MaFileSecrets;
  rawJson: string;
  filePath: string;
}

export async function parseMaFile(filePath: string): Promise<ParsedMaFile> {
  const text = await readFile(filePath, "utf8");
  return parseMaFileContent(text, filePath);
}

export function parseMaFileContent(text: string, filePath = ""): ParsedMaFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON in ${filePath || "input"}: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Unexpected shape for ${filePath || "input"}`);
  }
  const obj = parsed as Record<string, unknown>;
  const sharedSecret = (obj["shared_secret"] ?? obj["sharedSecret"]) as string | undefined;
  const identitySecret = (obj["identity_secret"] ?? obj["identitySecret"]) as string | undefined;
  if (!sharedSecret || !identitySecret) {
    throw new Error(
      `Missing shared_secret/identity_secret in ${filePath || "input"} (likely not a valid .maFile)`,
    );
  }
  const session = (obj["Session"] ?? obj["session"]) as Record<string, unknown> | undefined;
  const steamid = (obj["steamid"] ??
    session?.["SteamID"] ??
    session?.["steamid"]) as string | number | undefined;
  const accountName = (obj["account_name"] ??
    obj["AccountName"] ??
    obj["accountName"]) as string | undefined;

  const secrets: MaFileSecrets = {
    shared_secret: sharedSecret,
    identity_secret: identitySecret,
    serial_number: obj["serial_number"] as string | undefined,
    revocation_code: obj["revocation_code"] as string | undefined,
    uri: obj["uri"] as string | undefined,
    server_time: obj["server_time"] as number | undefined,
    account_name: accountName,
    token_gid: obj["token_gid"] as string | undefined,
    device_id: obj["device_id"] as string | undefined,
    steamid: steamid !== undefined ? String(steamid) : undefined,
  };

  return {
    secrets,
    rawJson: text,
    filePath,
  };
}

export async function parseMaFolder(folderPath: string): Promise<ParsedMaFile[]> {
  const entries = await readdir(folderPath, { withFileTypes: true });
  const results: ParsedMaFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (extname(name).toLowerCase() !== ".mafile") continue;
    try {
      const parsed = await parseMaFile(join(folderPath, name));
      results.push(parsed);
    } catch {
      // skip invalid files
    }
  }
  return results;
}
