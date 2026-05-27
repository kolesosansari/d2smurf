import { getMaFile, updateAccount } from "../database/accounts.repo";
import { getSettings } from "../database/settings.repo";
import { fetchWithProxy } from "../net/proxy";
import type { AccountRow } from "@shared/types";
import { mmrToRankTier, steamId64ToFriendCode } from "@shared/types";

interface SteamPlayer {
  steamid: string;
  personaname?: string;
  avatarfull?: string;
  profileurl?: string;
}

interface SteamSummaryResponse {
  response?: { players?: SteamPlayer[] };
}

interface OpenDotaProfile {
  profile?: {
    account_id?: number;
    personaname?: string;
    avatarfull?: string;
    steamid?: string;
  };
  mmr_estimate?: { estimate?: number };
  rank_tier?: number;
  leaderboard_rank?: number | null;
}

async function fetchJson<T>(url: string, proxy?: string | null): Promise<T | null> {
  try {
    const res = await fetchWithProxy(url, { method: "GET" }, proxy);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Refresh an account's public profile data without logging into Steam.
 * Pulls aggregate Dota 2 stats from OpenDota and basic profile fields
 * from the Steam Web API when an API key is configured.
 *
 * Returns the updated account. Behavior/communication score and LP status
 * cannot be obtained without logging into the Steam game coordinator —
 * those are filled in by the GC checker (added in a later phase).
 */
export async function refreshAccountPublic(account: AccountRow): Promise<AccountRow> {
  const settings = getSettings();
  const update: Parameters<typeof updateAccount>[1] = {
    lastCheckedAt: Date.now(),
  };

  const steamId64 = account.steamId64;

  if (steamId64 && settings.steamWebApiKey) {
    const summary = await fetchJson<SteamSummaryResponse>(
      `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${encodeURIComponent(
        settings.steamWebApiKey,
      )}&steamids=${steamId64}`,
      account.proxy,
    );
    const player = summary?.response?.players?.[0];
    if (player) {
      update.personaName = player.personaname ?? null;
      update.avatarUrl = player.avatarfull ?? null;
      update.status = "ok";
    }
  }

  if (steamId64) {
    const accountId32 = (BigInt(steamId64) - 76561197960265728n).toString();
    const dota = await fetchJson<OpenDotaProfile>(
      `https://api.opendota.com/api/players/${accountId32}`,
      account.proxy,
    );
    if (dota) {
      if (dota.mmr_estimate?.estimate) update.mmr = dota.mmr_estimate.estimate;
      if (dota.rank_tier) update.rankTier = dota.rank_tier;
      if (typeof dota.leaderboard_rank === "number") {
        update.leaderboardRank = dota.leaderboard_rank;
      }
      if (!update.personaName && dota.profile?.personaname) {
        update.personaName = dota.profile.personaname;
      }
      if (!update.avatarUrl && dota.profile?.avatarfull) {
        update.avatarUrl = dota.profile.avatarfull;
      }
      update.friendCode = steamId64ToFriendCode(steamId64);
    }
  }

  if (!update.rankTier && update.mmr !== undefined && update.mmr !== null) {
    update.rankTier = mmrToRankTier(update.mmr);
  }

  return updateAccount(account.id, update);
}

/**
 * Whether GC-based deep check is available for this account. The GC check
 * needs both stored credentials and a `.maFile` to handle Steam Guard.
 */
export function canDeepCheck(account: AccountRow): boolean {
  if (!account.password) return false;
  if (!account.hasMaFile) return false;
  const ma = getMaFile(account.id);
  return ma !== null;
}
