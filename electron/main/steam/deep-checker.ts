/**
 * "Deep check": pulls live data that requires either a Steam logon or a
 * STRATZ API key. Use this for accounts where:
 *   - a `.maFile` is linked (we can generate 2FA codes ourselves), or
 *   - the user wants the behavior_score that STRATZ exposes.
 *
 * Flow:
 *   1. Log into Steam with stored creds + TOTP from the `.maFile`, launch a
 *      lightweight Dota 2 GC session and parse account state from protobufs.
 *   2. With the SteamID64 in hand, fall back through OpenDota → STRATZ
 *      → Steam Web API for public profile data (MMR estimate, avatar, rank).
 *
 * What this currently CAN fetch:
 *   - SteamID64, friend code, persona name, avatar (via steam-user logon)
 *   - Low Priority status / remaining games (Dota GC SO cache)
 *   - MMR estimate, rank_tier, leaderboard_rank (OpenDota)
 *   - Rank tier / leaderboard rank (Dota GC profile card)
 *   - Behavior score (Dota GC conduct scorecard, STRATZ fallback)
 *
 * What this currently CANNOT fetch:
 *   - Exact raw Communication score. Current GC protos expose comms reports
 *     and chat restrictions, but not a separate 1–12000 communication score.
 */
import { getMaFile, updateAccount } from "../database/accounts.repo";
import { getSettings } from "../database/settings.repo";
import type { AccountRow, AccountUpdate } from "@shared/types";
import { mmrToRankTier, steamId64ToFriendCode } from "@shared/types";
import { refreshAccountPublic } from "./checker";
import { dotaGcCheck } from "./dota-gc";
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

  // Step 1: log into Steam and ask the Dota 2 GC for private account state.
  let steamId64 = account.steamId64;
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

  steps.push("Logging into Steam + Dota 2 GC…");
  const gc = await dotaGcCheck({
    login: account.login,
    password: account.password,
    sharedSecret: ma.sharedSecret,
    proxy: account.proxy,
  });
  steps.push(...gc.steps);

  if (gc.data.steamId64) {
    steamId64 = gc.data.steamId64;
    update.steamId64 = gc.data.steamId64;
    update.friendCode = gc.data.friendCode ?? steamId64ToFriendCode(gc.data.steamId64);
  }
  if (gc.data.personaName) update.personaName = gc.data.personaName;
  if (gc.data.avatarUrl) update.avatarUrl = gc.data.avatarUrl;
  if (typeof gc.data.rankTier === "number") update.rankTier = gc.data.rankTier;
  if (typeof gc.data.leaderboardRank === "number") update.leaderboardRank = gc.data.leaderboardRank;
  if (typeof gc.data.behaviorScore === "number") update.behaviorScore = gc.data.behaviorScore;
  if (typeof gc.data.communicationScore === "number") {
    update.communicationScore = gc.data.communicationScore;
  }
  if (typeof gc.data.inLowPriority === "boolean") update.inLowPriority = gc.data.inLowPriority;
  if (gc.data.lowPriorityGamesRemaining !== undefined) {
    update.lowPriorityGamesRemaining = gc.data.lowPriorityGamesRemaining;
  }

  if (!gc.ok) {
    steps.push(`Dota GC failed: ${gc.error ?? "unknown error"}.`);
    if (!steamId64) return { ok: false, error: gc.error ?? "Dota GC check failed.", steps };
  }

  if (!steamId64) {
    return { ok: false, error: "SteamID64 was not resolved.", steps };
  }

  // Step 2: STRATZ for behavior score + rank confirmation.
  const accountId32 = (BigInt(steamId64) - 76561197960265728n).toString();
  if (getSettings().stratzApiKey) {
    steps.push("Querying STRATZ for behavior score…");
    const stratz = await fetchStratzPlayer(accountId32, account.proxy);
    if (stratz) {
      if (typeof stratz.behaviorScore === "number" && update.behaviorScore === undefined) {
        update.behaviorScore = stratz.behaviorScore;
      }
      if (stratz.rankTier && update.rankTier === undefined) update.rankTier = stratz.rankTier;
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
