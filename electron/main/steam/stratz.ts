/**
 * STRATZ GraphQL integration. STRATZ exposes a player's `behaviorScore`
 * (and a few other fields) for accounts that have opened their match
 * history. Communication score is NOT exposed by STRATZ — Valve never
 * made it available outside the Dota 2 client.
 *
 * Requires a STRATZ API key (free, https://stratz.com/api). The key
 * lives in app_settings.stratzApiKey and is supplied via Bearer auth.
 */
import { getSettings } from "../database/settings.repo";
import { fetchWithProxy } from "../net/proxy";

interface StratzPlayerResponse {
  data?: {
    player?: {
      behaviorScore?: number | null;
      steamAccount?: {
        smurfFlag?: number | null;
        seasonRank?: number | null;
        rankShift?: number | null;
        timeCreated?: number | null;
        name?: string | null;
        avatar?: string | null;
      } | null;
      steamAccountId?: number;
      lastMatchDateTime?: number | null;
    } | null;
  };
  errors?: Array<{ message: string }>;
}

export interface StratzData {
  behaviorScore: number | null;
  rankTier: number | null;
  personaName: string | null;
  avatarUrl: string | null;
}

/**
 * Fetch behavior score (and a few opportunistic fields) for the given
 * 32-bit Dota account ID. Returns null if no API key is configured or
 * the player is private / not found.
 */
export async function fetchStratzPlayer(
  accountId32: string | number,
  proxy?: string | null,
): Promise<StratzData | null> {
  const apiKey = getSettings().stratzApiKey;
  if (!apiKey) return null;

  const query = `query Player($id: Long!) {
    player(steamAccountId: $id) {
      behaviorScore
      lastMatchDateTime
      steamAccount {
        seasonRank
        smurfFlag
        name
        avatar
      }
    }
  }`;

  let res: Response;
  try {
    res = await fetchWithProxy("https://api.stratz.com/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": "STRATZ_API",
      },
      body: JSON.stringify({ query, variables: { id: Number(accountId32) } }),
    }, proxy);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const json = (await res.json().catch(() => null)) as StratzPlayerResponse | null;
  const player = json?.data?.player;
  if (!player) return null;

  return {
    behaviorScore: typeof player.behaviorScore === "number" ? player.behaviorScore : null,
    rankTier:
      typeof player.steamAccount?.seasonRank === "number" ? player.steamAccount.seasonRank : null,
    personaName: player.steamAccount?.name ?? null,
    avatarUrl: player.steamAccount?.avatar ?? null,
  };
}
