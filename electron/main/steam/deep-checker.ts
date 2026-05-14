/**
 * "Deep check": pulls live data that requires either a Steam logon or a
 * STRATZ API key. Use this for accounts where:
 *   - a `.maFile` is linked (we can generate 2FA codes ourselves), or
 *   - the user wants the behavior_score that STRATZ exposes.
 *
 * Flow:
 *   1. If we don't yet have a SteamID64 for the account, log into Steam
 *      with stored creds + TOTP from the `.maFile` and capture it.
 *      We also fetch persona name + avatar in the same session.
 *   2. With the SteamID64 in hand, fall back through OpenDota → STRATZ
 *      → Steam Web API for the rest of the profile data (MMR, rank,
 *      behavior_score).
 *
 * What this currently CAN fetch:
 *   - SteamID64, friend code, persona name, avatar (via steam-user logon)
 *   - MMR estimate, rank_tier, leaderboard_rank (OpenDota)
 *   - Behavior score (STRATZ, if api key set and player opted in)
 *
 * What this currently CANNOT fetch:
 *   - Communication score — Valve doesn't expose it via any public API
 *   - Real-time LP status — only visible inside the Dota 2 client.
 *
 * Those will need either Dota 2 GC protobuf integration (planned) or
 * in-game scraping (out of scope).
 */
import { getMaFile, updateAccount } from "../database/accounts.repo";
import { getSettings } from "../database/settings.repo";
import type { AccountRow, AccountUpdate } from "@shared/types";
import { mmrToRankTier, steamId64ToFriendCode } from "@shared/types";
import { refreshAccountPublic } from "./checker";
import { steamLogon } from "./gc-login";
import { fetchStratzPlayer } from "./stratz";

export interface DeepCheckResult {
  ok: boolean;
  error?: string;
  account?: AccountRow;
  steps: string[];
}

export async function deepCheckAccount(account: AccountRow): Promise<DeepCheckResult> {
  const steps: string[] = [];
  const update: AccountUpdate = { lastCheckedAt: Date.now() };

  // Step 1: make sure we have a SteamID64. If not, log into Steam.
  let steamId64 = account.steamId64;
  if (!steamId64) {
    if (!account.password) {
      return { ok: false, error: "No stored password — cannot log into Steam.", steps };
    }
    const ma = getMaFile(account.id);
    if (!ma?.sharedSecret) {
      return {
        ok: false,
        error: "No .maFile linked — Steam Guard cannot be answered. Link a .maFile first.",
        steps,
      };
    }
    steps.push("Logging into Steam to resolve SteamID64…");
    const logon = await steamLogon({
      login: account.login,
      password: account.password,
      sharedSecret: ma.sharedSecret,
    });
    if (!logon.ok || !logon.steamId64) {
      return { ok: false, error: logon.error ?? "Steam logon failed.", steps };
    }
    steamId64 = logon.steamId64;
    steps.push(`Steam logon ok (SteamID ${steamId64}).`);
    update.steamId64 = steamId64;
    if (logon.personaName) update.personaName = logon.personaName;
    if (logon.avatarUrl) update.avatarUrl = logon.avatarUrl;
    update.friendCode = steamId64ToFriendCode(steamId64);
  }

  // Step 2: STRATZ for behavior score + rank confirmation.
  const accountId32 = (BigInt(steamId64) - 76561197960265728n).toString();
  if (getSettings().stratzApiKey) {
    steps.push("Querying STRATZ for behavior score…");
    const stratz = await fetchStratzPlayer(accountId32);
    if (stratz) {
      if (typeof stratz.behaviorScore === "number") update.behaviorScore = stratz.behaviorScore;
      if (stratz.rankTier) update.rankTier = stratz.rankTier;
      if (!update.personaName && stratz.personaName) update.personaName = stratz.personaName;
      if (!update.avatarUrl && stratz.avatarUrl) update.avatarUrl = stratz.avatarUrl;
      steps.push(
        stratz.behaviorScore !== null
          ? `STRATZ ok (behavior=${stratz.behaviorScore}).`
          : "STRATZ ok but behavior score is private.",
      );
    } else {
      steps.push("STRATZ returned no data (player private or no recent matches).");
    }
  } else {
    steps.push("No STRATZ API key — skipped behavior score lookup.");
  }

  // Step 3: standard public refresh (OpenDota MMR estimate + Steam Web API).
  // We feed the current SteamID64 forward via the update we'll apply at the
  // end, but refreshAccountPublic re-reads the row, so persist first.
  const merged = updateAccount(account.id, update);
  steps.push("Running public refresh (OpenDota + Steam Web API)…");
  const refreshed = await refreshAccountPublic(merged);

  // Re-derive rank from MMR if STRATZ + OpenDota both failed.
  if (
    refreshed.rankTier === null &&
    refreshed.mmr !== null &&
    typeof refreshed.mmr === "number"
  ) {
    const tier = mmrToRankTier(refreshed.mmr);
    if (tier !== null) {
      const finalRow = updateAccount(account.id, { rankTier: tier });
      return { ok: true, account: finalRow, steps };
    }
  }

  return { ok: true, account: refreshed, steps };
}
