import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import type { AccountInput, AccountRow, AccountUpdate, AccountStatus } from "@shared/types";

interface AccountRecord {
  id: string;
  login: string;
  password: string;
  email: string | null;
  email_password: string | null;
  proxy: string | null;
  steam_id64: string | null;
  friend_code: string | null;
  persona_name: string | null;
  avatar_url: string | null;
  mmr: number | null;
  rank_tier: number | null;
  leaderboard_rank: number | null;
  behavior_score: number | null;
  communication_score: number | null;
  in_low_priority: number;
  low_priority_games_remaining: number | null;
  status: AccountStatus;
  has_ma_file: number;
  notes: string | null;
  sort_order: number;
  last_checked_at: number | null;
  created_at: number;
  updated_at: number;
}

function rowToAccount(record: AccountRecord, tags: string[]): AccountRow {
  return {
    id: record.id,
    login: record.login,
    password: record.password,
    email: record.email,
    emailPassword: record.email_password,
    proxy: record.proxy,
    steamId64: record.steam_id64,
    friendCode: record.friend_code,
    personaName: record.persona_name,
    avatarUrl: record.avatar_url,
    mmr: record.mmr,
    rankTier: record.rank_tier,
    leaderboardRank: record.leaderboard_rank,
    behaviorScore: record.behavior_score,
    communicationScore: record.communication_score,
    inLowPriority: record.in_low_priority ? 1 : 0,
    lowPriorityGamesRemaining: record.low_priority_games_remaining,
    status: record.status,
    hasMaFile: record.has_ma_file ? 1 : 0,
    notes: record.notes,
    tags,
    sortOrder: record.sort_order,
    lastCheckedAt: record.last_checked_at,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function listTags(accountId: string): string[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT tag FROM account_tags WHERE account_id = ? ORDER BY tag")
    .all(accountId) as Array<{ tag: string }>;
  return rows.map((r) => r.tag);
}

function setTags(accountId: string, tags: string[] | undefined): void {
  if (!tags) return;
  const db = getDb();
  db.prepare("DELETE FROM account_tags WHERE account_id = ?").run(accountId);
  if (tags.length === 0) return;
  const insert = db.prepare("INSERT INTO account_tags(account_id, tag) VALUES (?, ?)");
  const unique = Array.from(new Set(tags.map((t) => t.trim()).filter(Boolean)));
  for (const tag of unique) insert.run(accountId, tag);
}

export function listAccounts(): AccountRow[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM accounts ORDER BY sort_order ASC, created_at ASC")
    .all() as AccountRecord[];
  return rows.map((r) => rowToAccount(r, listTags(r.id)));
}

export function getAccount(id: string): AccountRow | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as
    | AccountRecord
    | undefined;
  if (!row) return null;
  return rowToAccount(row, listTags(row.id));
}

export function getAccountByLogin(login: string): AccountRow | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM accounts WHERE login = ? COLLATE NOCASE")
    .get(login) as AccountRecord | undefined;
  if (!row) return null;
  return rowToAccount(row, listTags(row.id));
}

function nextSortOrder(): number {
  const db = getDb();
  const result = db.prepare("SELECT MAX(sort_order) AS max FROM accounts").get() as
    | { max: number | null }
    | undefined;
  return ((result?.max ?? 0) as number) + 1;
}

export function createAccount(input: AccountInput): AccountRow {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  const sortOrder = nextSortOrder();
  db.prepare(
    `INSERT INTO accounts (
       id, login, password, email, email_password, proxy,
       status, in_low_priority, has_ma_file, notes, sort_order,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'unknown', 0, 0, ?, ?, ?, ?)`,
  ).run(
    id,
    input.login,
    input.password,
    input.email ?? null,
    input.emailPassword ?? null,
    input.proxy ?? null,
    input.notes ?? null,
    sortOrder,
    now,
    now,
  );
  setTags(id, input.tags);
  const created = getAccount(id);
  if (!created) throw new Error("Account not found after insert");
  return created;
}

export function updateAccount(id: string, patch: AccountUpdate): AccountRow {
  const db = getDb();
  const existing = getAccount(id);
  if (!existing) throw new Error(`Account ${id} not found`);
  const now = Date.now();

  const fieldMap: Array<[keyof AccountUpdate, string]> = [
    ["password", "password"],
    ["email", "email"],
    ["emailPassword", "email_password"],
    ["proxy", "proxy"],
    ["steamId64", "steam_id64"],
    ["friendCode", "friend_code"],
    ["personaName", "persona_name"],
    ["avatarUrl", "avatar_url"],
    ["mmr", "mmr"],
    ["rankTier", "rank_tier"],
    ["leaderboardRank", "leaderboard_rank"],
    ["behaviorScore", "behavior_score"],
    ["communicationScore", "communication_score"],
    ["lowPriorityGamesRemaining", "low_priority_games_remaining"],
    ["notes", "notes"],
    ["status", "status"],
    ["lastCheckedAt", "last_checked_at"],
    ["sortOrder", "sort_order"],
  ];

  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  for (const [key, col] of fieldMap) {
    if (patch[key] !== undefined) {
      sets.push(`${col} = ?`);
      values.push(patch[key] as string | number | null);
    }
  }
  if (patch.inLowPriority !== undefined) {
    sets.push("in_low_priority = ?");
    values.push(patch.inLowPriority ? 1 : 0);
  }
  if (patch.hasMaFile !== undefined) {
    sets.push("has_ma_file = ?");
    values.push(patch.hasMaFile ? 1 : 0);
  }
  sets.push("updated_at = ?");
  values.push(now);
  values.push(id);

  if (sets.length > 1) {
    db.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }
  if (patch.tags !== undefined) setTags(id, patch.tags);

  const updated = getAccount(id);
  if (!updated) throw new Error("Account disappeared after update");
  return updated;
}

export function deleteAccount(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
  return result.changes > 0;
}

export function reorderAccounts(orderedIds: string[]): void {
  const db = getDb();
  const update = db.prepare("UPDATE accounts SET sort_order = ?, updated_at = ? WHERE id = ?");
  const now = Date.now();
  const tx = db.transaction((ids: string[]) => {
    ids.forEach((id, index) => update.run(index + 1, now, id));
  });
  tx(orderedIds);
}

export interface MaFileRecord {
  accountId: string;
  sharedSecret: string;
  identitySecret: string;
  serialNumber: string | null;
  revocationCode: string | null;
  deviceId: string | null;
  rawJson: string;
}

export function setMaFile(record: MaFileRecord): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO ma_files (account_id, shared_secret, identity_secret, serial_number, revocation_code, device_id, raw_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET
       shared_secret = excluded.shared_secret,
       identity_secret = excluded.identity_secret,
       serial_number = excluded.serial_number,
       revocation_code = excluded.revocation_code,
       device_id = excluded.device_id,
       raw_json = excluded.raw_json`,
  ).run(
    record.accountId,
    record.sharedSecret,
    record.identitySecret,
    record.serialNumber,
    record.revocationCode,
    record.deviceId,
    record.rawJson,
    now,
  );
  db
    .prepare("UPDATE accounts SET has_ma_file = 1, updated_at = ? WHERE id = ?")
    .run(now, record.accountId);
}

export function getMaFile(accountId: string): MaFileRecord | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM ma_files WHERE account_id = ?").get(accountId) as
    | {
        account_id: string;
        shared_secret: string;
        identity_secret: string;
        serial_number: string | null;
        revocation_code: string | null;
        device_id: string | null;
        raw_json: string;
      }
    | undefined;
  if (!row) return null;
  return {
    accountId: row.account_id,
    sharedSecret: row.shared_secret,
    identitySecret: row.identity_secret,
    serialNumber: row.serial_number,
    revocationCode: row.revocation_code,
    deviceId: row.device_id,
    rawJson: row.raw_json,
  };
}

export function removeMaFile(accountId: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM ma_files WHERE account_id = ?").run(accountId);
  if (result.changes > 0) {
    db
      .prepare("UPDATE accounts SET has_ma_file = 0, updated_at = ? WHERE id = ?")
      .run(Date.now(), accountId);
    return true;
  }
  return false;
}

export function getAllTags(): string[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT DISTINCT tag FROM account_tags ORDER BY tag")
    .all() as Array<{ tag: string }>;
  return rows.map((r) => r.tag);
}
