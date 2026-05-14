/**
 * Encode and decode the Dota 2 rank tier byte used by Valve in
 * `CMsgClientToGCRankResponse` / `player_profile_card`.
 *
 * Byte = medal * 10 + stars, where:
 *   1 Herald, 2 Guardian, 3 Crusader, 4 Archon, 5 Legend,
 *   6 Ancient, 7 Divine, 8 Immortal (no stars; uses leaderboard rank).
 */
export interface ParsedRank {
  medal: number;
  stars: number;
  display: string;
}

const MEDAL_LABELS = [
  "Uncalibrated",
  "Herald",
  "Guardian",
  "Crusader",
  "Archon",
  "Legend",
  "Ancient",
  "Divine",
  "Immortal",
];

export function parseRankTier(rankTier: number | null | undefined): ParsedRank | null {
  if (rankTier === null || rankTier === undefined || rankTier <= 0) return null;
  const medal = Math.floor(rankTier / 10);
  const stars = rankTier % 10;
  if (medal < 1 || medal > 8) return null;
  const label = MEDAL_LABELS[medal] ?? "Uncalibrated";
  const display = medal === 8 ? "Immortal" : `${label} ${stars}`;
  return { medal, stars, display };
}

export { MEDAL_LABELS };
