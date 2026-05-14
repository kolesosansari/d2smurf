/**
 * Shared types between Electron main process and renderer.
 */

export type AccountStatus = "unknown" | "ok" | "lp" | "error";

export interface MaFileSecrets {
  shared_secret: string;
  identity_secret: string;
  serial_number?: string;
  revocation_code?: string;
  uri?: string;
  server_time?: number;
  account_name?: string;
  token_gid?: string;
  device_id?: string;
  steamid?: string;
}

export interface AccountInput {
  login: string;
  password: string;
  email?: string | null;
  emailPassword?: string | null;
  proxy?: string | null;
  notes?: string | null;
  tags?: string[];
}

export interface AccountRow {
  id: string;
  login: string;
  password: string;
  email: string | null;
  emailPassword: string | null;
  proxy: string | null;
  steamId64: string | null;
  friendCode: string | null;
  personaName: string | null;
  avatarUrl: string | null;
  mmr: number | null;
  rankTier: number | null;
  leaderboardRank: number | null;
  behaviorScore: number | null;
  communicationScore: number | null;
  inLowPriority: 0 | 1;
  lowPriorityGamesRemaining: number | null;
  status: AccountStatus;
  hasMaFile: 0 | 1;
  notes: string | null;
  tags: string[];
  sortOrder: number;
  lastCheckedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AccountUpdate {
  password?: string;
  email?: string | null;
  emailPassword?: string | null;
  proxy?: string | null;
  notes?: string | null;
  tags?: string[];
  steamId64?: string | null;
  friendCode?: string | null;
  personaName?: string | null;
  avatarUrl?: string | null;
  mmr?: number | null;
  rankTier?: number | null;
  leaderboardRank?: number | null;
  behaviorScore?: number | null;
  communicationScore?: number | null;
  inLowPriority?: boolean;
  lowPriorityGamesRemaining?: number | null;
  status?: AccountStatus;
  hasMaFile?: boolean;
  lastCheckedAt?: number | null;
  sortOrder?: number;
}

export interface VaultStatus {
  isInitialized: boolean;
  isUnlocked: boolean;
}

export interface VaultUnlockResult {
  ok: boolean;
  error?: string;
}

export interface ImportTxtParsed {
  login: string;
  password: string;
  email?: string;
  emailPassword?: string;
}

export interface ImportResult {
  added: number;
  skipped: number;
  errors: string[];
}

export interface CheckProgress {
  accountId: string;
  login: string;
  status: "queued" | "running" | "done" | "failed";
  message?: string;
}

export interface AppSettings {
  theme: "dark" | "light" | "system";
  autoCheckEnabled: boolean;
  autoCheckIntervalHours: number;
  steamPath: string | null;
  overplusPath: string | null;
  dotaLaunchOptions: string;
  steamWebApiKey: string | null;
  stratzApiKey: string | null;
}

export type IpcChannel =
  | "vault:status"
  | "vault:initialize"
  | "vault:unlock"
  | "vault:lock"
  | "vault:change-password"
  | "accounts:list"
  | "accounts:get"
  | "accounts:create"
  | "accounts:update"
  | "accounts:delete"
  | "accounts:reorder"
  | "accounts:bulk-check"
  | "accounts:check-one"
  | "accounts:deep-check"
  | "import:txt"
  | "import:mafile"
  | "import:mafile-folder"
  | "settings:get"
  | "settings:update"
  | "launcher:start-steam"
  | "launcher:start-with-overplus"
  | "sda:add-phone"
  | "sda:confirm-phone"
  | "sda:enable-two-factor"
  | "sda:finalize-two-factor"
  | "sda:generate-code"
  | "sda:export-mafile"
  | "backup:export"
  | "backup:import";

export interface RankInfo {
  tier: number;
  medal: number;
  stars: number;
  name: string;
}

/**
 * Convert MMR to approximate Dota 2 rank tier.
 * Tier encoding follows Valve: tier * 10 + stars (1-5).
 * Medals: 1 Herald, 2 Guardian, 3 Crusader, 4 Archon, 5 Legend, 6 Ancient, 7 Divine, 8 Immortal.
 *
 * Bucket thresholds are approximate (Valve does not publish exact mapping).
 */
export const MEDAL_NAMES = [
  "Uncalibrated",
  "Herald",
  "Guardian",
  "Crusader",
  "Archon",
  "Legend",
  "Ancient",
  "Divine",
  "Immortal",
] as const;

export type MedalName = (typeof MEDAL_NAMES)[number];

const RANK_THRESHOLDS: Array<{ mmr: number; tier: number }> = [
  { mmr: 0, tier: 11 },
  { mmr: 154, tier: 12 },
  { mmr: 308, tier: 13 },
  { mmr: 462, tier: 14 },
  { mmr: 616, tier: 15 },
  { mmr: 770, tier: 21 },
  { mmr: 924, tier: 22 },
  { mmr: 1078, tier: 23 },
  { mmr: 1232, tier: 24 },
  { mmr: 1386, tier: 25 },
  { mmr: 1540, tier: 31 },
  { mmr: 1694, tier: 32 },
  { mmr: 1848, tier: 33 },
  { mmr: 2002, tier: 34 },
  { mmr: 2156, tier: 35 },
  { mmr: 2310, tier: 41 },
  { mmr: 2464, tier: 42 },
  { mmr: 2618, tier: 43 },
  { mmr: 2772, tier: 44 },
  { mmr: 2926, tier: 45 },
  { mmr: 3080, tier: 51 },
  { mmr: 3234, tier: 52 },
  { mmr: 3388, tier: 53 },
  { mmr: 3542, tier: 54 },
  { mmr: 3696, tier: 55 },
  { mmr: 3850, tier: 61 },
  { mmr: 4004, tier: 62 },
  { mmr: 4158, tier: 63 },
  { mmr: 4312, tier: 64 },
  { mmr: 4466, tier: 65 },
  { mmr: 4620, tier: 71 },
  { mmr: 4774, tier: 72 },
  { mmr: 4928, tier: 73 },
  { mmr: 5082, tier: 74 },
  { mmr: 5236, tier: 75 },
  { mmr: 5420, tier: 80 },
];

export function mmrToRankTier(mmr: number | null | undefined): number | null {
  if (mmr === null || mmr === undefined || mmr < 0) return null;
  let tier = RANK_THRESHOLDS[0].tier;
  for (const entry of RANK_THRESHOLDS) {
    if (mmr >= entry.mmr) tier = entry.tier;
  }
  return tier;
}

export function rankTierToInfo(tier: number | null | undefined): RankInfo | null {
  if (tier === null || tier === undefined) return null;
  const medal = Math.floor(tier / 10);
  const stars = tier % 10;
  if (medal < 1 || medal > 8) return null;
  return {
    tier,
    medal,
    stars,
    name: MEDAL_NAMES[medal] ?? "Uncalibrated",
  };
}

/**
 * Steam friend code helpers: Dota's "friend code" is the lower 32 bits of
 * the SteamID64. Steam community frequently calls this "Dota friend ID".
 */
export function steamId64ToFriendCode(steamId64: string | bigint | null | undefined): string | null {
  if (steamId64 === null || steamId64 === undefined) return null;
  try {
    const id = typeof steamId64 === "string" ? BigInt(steamId64) : steamId64;
    const account = id - 76561197960265728n;
    if (account < 0n) return null;
    return account.toString();
  } catch {
    return null;
  }
}

export function friendCodeToSteamId64(friendCode: string | number | null | undefined): string | null {
  if (friendCode === null || friendCode === undefined) return null;
  try {
    const id = BigInt(friendCode) + 76561197960265728n;
    return id.toString();
  } catch {
    return null;
  }
}
