import Database from "better-sqlite3-multiple-ciphers";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { app } from "electron";

type DatabaseInstance = ReturnType<typeof Database>;

const DEFAULT_DB_NAME = "vault.db";

let dbInstance: DatabaseInstance | null = null;
let dbPath: string | null = null;

export function getDbPath(): string {
  if (dbPath) return dbPath;
  const userData = app.getPath("userData");
  dbPath = join(userData, DEFAULT_DB_NAME);
  return dbPath;
}

export function isOpen(): boolean {
  return dbInstance !== null;
}

export function openDb(passphrase: string): DatabaseInstance {
  if (dbInstance) return dbInstance;
  const path = getDbPath();
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma(`cipher='sqlcipher'`);
  db.pragma(`key='${passphrase.replace(/'/g, "''")}'`);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  try {
    db.prepare("SELECT count(*) FROM sqlite_master").get();
  } catch (err) {
    db.close();
    dbInstance = null;
    throw new Error(`Failed to open encrypted database: ${(err as Error).message}`);
  }

  dbInstance = db;
  runMigrations(db);
  return db;
}

export function closeDb(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // ignore
    }
    dbInstance = null;
  }
}

export function getDb(): DatabaseInstance {
  if (!dbInstance) throw new Error("Database is not open. Unlock the vault first.");
  return dbInstance;
}

function runMigrations(db: DatabaseInstance): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      login TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password TEXT NOT NULL,
      email TEXT,
      email_password TEXT,
      proxy TEXT,
      steam_id64 TEXT,
      friend_code TEXT,
      persona_name TEXT,
      avatar_url TEXT,
      mmr INTEGER,
      rank_tier INTEGER,
      leaderboard_rank INTEGER,
      behavior_score INTEGER,
      communication_score INTEGER,
      in_low_priority INTEGER NOT NULL DEFAULT 0,
      low_priority_games_remaining INTEGER,
      status TEXT NOT NULL DEFAULT 'unknown',
      has_ma_file INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      sort_order REAL NOT NULL DEFAULT 0,
      last_checked_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_accounts_sort_order ON accounts(sort_order);
    CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
    CREATE INDEX IF NOT EXISTS idx_accounts_mmr ON accounts(mmr);

    CREATE TABLE IF NOT EXISTS account_tags (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      tag TEXT NOT NULL COLLATE NOCASE,
      PRIMARY KEY (account_id, tag)
    );

    CREATE INDEX IF NOT EXISTS idx_account_tags_tag ON account_tags(tag);

    CREATE TABLE IF NOT EXISTS ma_files (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      shared_secret TEXT NOT NULL,
      identity_secret TEXT NOT NULL,
      serial_number TEXT,
      revocation_code TEXT,
      device_id TEXT,
      raw_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

/**
 * Test-only helper for headless / non-Electron contexts.
 * Allows overriding the db location for unit tests.
 */
export function _setDbPathForTesting(path: string): void {
  dbPath = path;
}
