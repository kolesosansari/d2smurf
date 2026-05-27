import SteamUser from "steam-user";
import * as SteamTotp from "steam-totp";
import protobuf from "protobufjs";
import { steamId64ToFriendCode } from "@shared/types";
import { steamUserProxyOptions } from "../net/proxy";

const DOTA_APP_ID = 570;
const LOGON_TIMEOUT_MS = 45_000;
const GC_REQUEST_TIMEOUT_MS = 10_000;
const GC_HELLO_INTERVAL_MS = 1_000;
const STEAM_ID64_OFFSET = 76561197960265728n;

const EGC_CLIENT_WELCOME = 4004;
const EGC_CLIENT_HELLO = 4006;
const EGC_CLIENT_CONNECTION_STATUS = 4009;
const EMSG_GET_PROFILE_CARD = 7534;
const EMSG_GET_PROFILE_CARD_RESPONSE = 7535;
const EMSG_LATEST_CONDUCT_SCORECARD_REQUEST = 8095;
const EMSG_LATEST_CONDUCT_SCORECARD = 8096;
const EMSG_RANK_REQUEST = 8879;
const EMSG_RANK_RESPONSE = 8880;

const SO_TYPE_DOTA_GAME_ACCOUNT_CLIENT = 2002;
const RANK_TYPE_RANKED_GLICKO = 6;
const RANK_TYPE_BEHAVIOR_PRIVATE = 100;
const RANK_TYPE_BEHAVIOR_PUBLIC = 101;

interface DotaGcInput {
  login: string;
  password: string;
  sharedSecret?: string | null;
  proxy?: string | null;
}

export interface DotaGcData {
  steamId64?: string;
  friendCode?: string | null;
  personaName?: string | null;
  avatarUrl?: string | null;
  rankTier?: number | null;
  leaderboardRank?: number | null;
  behaviorScore?: number | null;
  communicationScore?: number | null;
  inLowPriority?: boolean;
  lowPriorityGamesRemaining?: number | null;
}

export interface DotaGcCheckResult {
  ok: boolean;
  error?: string;
  data: DotaGcData;
  steps: string[];
}

interface CMsgClientWelcome {
  outofdateSubscribedCaches?: CMsgSOCacheSubscribed[];
}

interface CMsgSOCacheSubscribed {
  objects?: CMsgSOCacheSubscribedType[];
}

interface CMsgSOCacheSubscribedType {
  typeId?: number;
  objectData?: Uint8Array[];
}

interface CSODOTAGameAccountClient {
  accountId?: number;
  lowPriorityUntilDate?: number;
  lowPriorityGamesRemaining?: number;
  playerBehaviorScoreLastReport?: number;
}

interface CMsgDOTAProfileCard {
  rankTier?: number;
  leaderboardRank?: number;
}

interface CMsgPlayerConductScorecard {
  rawBehaviorScore?: number;
}

interface CMsgGCToClientRankResponse {
  result?: number;
  rankValue?: number;
  rankData1?: number;
  rankData2?: number;
  rankData3?: number;
}

const root = new protobuf.Root();

const CMsgSOCacheSubscribedType = new protobuf.Type("CMsgSOCacheSubscribedType")
  .add(new protobuf.Field("typeId", 1, "int32"))
  .add(new protobuf.Field("objectData", 2, "bytes", "repeated"));

const CMsgSOCacheSubscribed = new protobuf.Type("CMsgSOCacheSubscribed").add(
  new protobuf.Field("objects", 2, "CMsgSOCacheSubscribedType", "repeated"),
);

const CMsgClientWelcome = new protobuf.Type("CMsgClientWelcome").add(
  new protobuf.Field("outofdateSubscribedCaches", 3, "CMsgSOCacheSubscribed", "repeated"),
);

const CMsgConnectionStatus = new protobuf.Type("CMsgConnectionStatus").add(
  new protobuf.Field("status", 1, "uint32"),
);

const CMsgClientHello = new protobuf.Type("CMsgClientHello");

const CSODOTAGameAccountClient = new protobuf.Type("CSODOTAGameAccountClient")
  .add(new protobuf.Field("accountId", 1, "uint32"))
  .add(new protobuf.Field("lowPriorityUntilDate", 18, "uint32"))
  .add(new protobuf.Field("lowPriorityGamesRemaining", 48, "uint32"))
  .add(new protobuf.Field("playerBehaviorScoreLastReport", 72, "uint32"));

const CMsgClientToGCGetProfileCard = new protobuf.Type("CMsgClientToGCGetProfileCard").add(
  new protobuf.Field("accountId", 1, "uint32"),
);

const CMsgDOTAProfileCard = new protobuf.Type("CMsgDOTAProfileCard")
  .add(new protobuf.Field("rankTier", 8, "uint32"))
  .add(new protobuf.Field("leaderboardRank", 9, "uint32"));

const CMsgPlayerConductScorecardRequest = new protobuf.Type("CMsgPlayerConductScorecardRequest");

const CMsgPlayerConductScorecard = new protobuf.Type("CMsgPlayerConductScorecard").add(
  new protobuf.Field("rawBehaviorScore", 17, "uint32"),
);

const CMsgClientToGCRankRequest = new protobuf.Type("CMsgClientToGCRankRequest").add(
  new protobuf.Field("rankType", 1, "uint32"),
);

const CMsgGCToClientRankResponse = new protobuf.Type("CMsgGCToClientRankResponse")
  .add(new protobuf.Field("result", 1, "uint32"))
  .add(new protobuf.Field("rankValue", 2, "uint32"))
  .add(new protobuf.Field("rankData1", 3, "uint32"))
  .add(new protobuf.Field("rankData2", 4, "uint32"))
  .add(new protobuf.Field("rankData3", 5, "uint32"));

root
  .add(CMsgSOCacheSubscribedType)
  .add(CMsgSOCacheSubscribed)
  .add(CMsgClientWelcome)
  .add(CMsgConnectionStatus)
  .add(CMsgClientHello)
  .add(CSODOTAGameAccountClient)
  .add(CMsgClientToGCGetProfileCard)
  .add(CMsgDOTAProfileCard)
  .add(CMsgPlayerConductScorecardRequest)
  .add(CMsgPlayerConductScorecard)
  .add(CMsgClientToGCRankRequest)
  .add(CMsgGCToClientRankResponse)
  .resolveAll();

function decodeMessage<T>(type: protobuf.Type, payload: Uint8Array): T | null {
  try {
    return type.decode(payload) as unknown as T;
  } catch {
    return null;
  }
}

function encodeMessage(type: protobuf.Type, payload: Record<string, unknown> = {}): Buffer {
  return Buffer.from(type.encode(type.fromObject(payload)).finish());
}

function steamId64ToAccountId32(steamId64: string): number {
  return Number(BigInt(steamId64) - STEAM_ID64_OFFSET);
}

function isScore(value: unknown): value is number {
  return typeof value === "number" && value > 0 && value <= 12_000;
}

function applyGameAccountCache(cache: CSODOTAGameAccountClient, data: DotaGcData): void {
  const gamesRemaining = cache.lowPriorityGamesRemaining ?? 0;
  const lowPriorityUntil = cache.lowPriorityUntilDate ?? 0;
  const nowSeconds = Math.floor(Date.now() / 1000);

  data.inLowPriority = gamesRemaining > 0 || lowPriorityUntil > nowSeconds;
  data.lowPriorityGamesRemaining = gamesRemaining;

  if (isScore(cache.playerBehaviorScoreLastReport) && data.behaviorScore === undefined) {
    data.behaviorScore = cache.playerBehaviorScoreLastReport;
  }
}

function applyWelcome(payload: Buffer, data: DotaGcData, steps: string[]): void {
  const welcome = decodeMessage<CMsgClientWelcome>(CMsgClientWelcome, payload);
  if (!welcome) {
    steps.push("Dota GC welcome received, but SO cache decode failed.");
    return;
  }

  let foundGameAccount = false;
  for (const cache of welcome.outofdateSubscribedCaches ?? []) {
    for (const objectType of cache.objects ?? []) {
      if (objectType.typeId !== SO_TYPE_DOTA_GAME_ACCOUNT_CLIENT) continue;
      for (const objectData of objectType.objectData ?? []) {
        const gameAccount = decodeMessage<CSODOTAGameAccountClient>(
          CSODOTAGameAccountClient,
          objectData,
        );
        if (!gameAccount) continue;
        foundGameAccount = true;
        applyGameAccountCache(gameAccount, data);
      }
    }
  }

  if (foundGameAccount) {
    const lp = data.inLowPriority
      ? `LP=${data.lowPriorityGamesRemaining ?? "?"}`
      : "LP=false";
    steps.push(`Dota SO cache parsed (${lp}).`);
  } else {
    steps.push("Dota SO cache did not include CSODOTAGameAccountClient.");
  }
}

export function dotaGcCheck(input: DotaGcInput): Promise<DotaGcCheckResult> {
  return new Promise((resolve) => {
    const steps: string[] = [];
    const data: DotaGcData = {};
    const client = new SteamUser({ autoRelogin: false, ...steamUserProxyOptions(input.proxy) });
    let settled = false;
    let gcReady = false;
    let helloTimer: NodeJS.Timeout | null = null;

    const cleanup = (): void => {
      if (helloTimer) clearInterval(helloTimer);
      helloTimer = null;
      try {
        client.gamesPlayed([]);
      } catch {
        // best-effort cleanup
      }
      try {
        client.logOff();
      } catch {
        // best-effort cleanup
      }
    };

    const finish = (result: Omit<DotaGcCheckResult, "steps" | "data">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(logonTimeout);
      cleanup();
      resolve({ ...result, data, steps });
    };

    const sendHello = (): void => {
      if (!client.steamID || gcReady || settled) return;
      try {
        client.sendToGC(DOTA_APP_ID, EGC_CLIENT_HELLO, {}, encodeMessage(CMsgClientHello));
      } catch (err) {
        steps.push(`Dota GC hello failed: ${(err as Error).message}`);
      }
    };

    const requestGc = <T>(
      requestMsg: number,
      responseMsg: number,
      requestType: protobuf.Type,
      responseType: protobuf.Type,
      body: Record<string, unknown> = {},
    ): Promise<T | null> => {
      return new Promise((requestResolve) => {
        let done = false;
        const cleanupRequest = (): void => {
          done = true;
          clearTimeout(timer);
          client.removeListener("receivedFromGC", onResponse);
        };
        const finishRequest = (payload: Buffer): void => {
          if (done) return;
          cleanupRequest();
          requestResolve(decodeMessage<T>(responseType, payload));
        };
        const onResponse = (appid: number, msgType: number, payload: Buffer): void => {
          if (appid !== DOTA_APP_ID || msgType !== responseMsg) return;
          finishRequest(payload);
        };
        const timer = setTimeout(() => {
          if (done) return;
          cleanupRequest();
          requestResolve(null);
        }, GC_REQUEST_TIMEOUT_MS);

        client.on("receivedFromGC", onResponse);
        try {
          client.sendToGC(
            DOTA_APP_ID,
            requestMsg,
            {},
            encodeMessage(requestType, body),
            (appid, msgType, payload) => {
              if (appid !== DOTA_APP_ID || msgType !== responseMsg) return;
              finishRequest(payload);
            },
          );
        } catch {
          cleanupRequest();
          requestResolve(null);
        }
      });
    };

    const collectGcData = async (): Promise<void> => {
      if (!data.steamId64) {
        finish({ ok: false, error: "Dota GC connected, but SteamID64 was not resolved." });
        return;
      }

      const accountId = steamId64ToAccountId32(data.steamId64);

      const profile = await requestGc<CMsgDOTAProfileCard>(
        EMSG_GET_PROFILE_CARD,
        EMSG_GET_PROFILE_CARD_RESPONSE,
        CMsgClientToGCGetProfileCard,
        CMsgDOTAProfileCard,
        { accountId },
      );
      if (profile) {
        if (profile.rankTier) data.rankTier = profile.rankTier;
        if (profile.leaderboardRank) data.leaderboardRank = profile.leaderboardRank;
        steps.push(
          `Profile card parsed (rank=${profile.rankTier || "?"}, leaderboard=${
            profile.leaderboardRank || "-"
          }).`,
        );
      } else {
        steps.push("Profile card request returned no data.");
      }

      const conduct = await requestGc<CMsgPlayerConductScorecard>(
        EMSG_LATEST_CONDUCT_SCORECARD_REQUEST,
        EMSG_LATEST_CONDUCT_SCORECARD,
        CMsgPlayerConductScorecardRequest,
        CMsgPlayerConductScorecard,
      );
      if (isScore(conduct?.rawBehaviorScore)) {
        data.behaviorScore = conduct.rawBehaviorScore;
        steps.push(`Conduct scorecard parsed (behavior=${conduct.rawBehaviorScore}).`);
      } else {
        steps.push("Conduct scorecard returned no behavior score.");
      }

      const ranked = await requestGc<CMsgGCToClientRankResponse>(
        EMSG_RANK_REQUEST,
        EMSG_RANK_RESPONSE,
        CMsgClientToGCRankRequest,
        CMsgGCToClientRankResponse,
        { rankType: RANK_TYPE_RANKED_GLICKO },
      );
      if (!data.rankTier && ranked?.rankValue && ranked.rankValue < 100) {
        data.rankTier = ranked.rankValue;
      }
      if (ranked) {
        steps.push(
          `Rank response parsed (value=${ranked.rankValue ?? 0}, data=${ranked.rankData1 ?? 0}/${
            ranked.rankData2 ?? 0
          }/${ranked.rankData3 ?? 0}).`,
        );
      }

      const behaviorPrivate = await requestGc<CMsgGCToClientRankResponse>(
        EMSG_RANK_REQUEST,
        EMSG_RANK_RESPONSE,
        CMsgClientToGCRankRequest,
        CMsgGCToClientRankResponse,
        { rankType: RANK_TYPE_BEHAVIOR_PRIVATE },
      );
      if (data.behaviorScore === undefined && isScore(behaviorPrivate?.rankValue)) {
        data.behaviorScore = behaviorPrivate.rankValue;
      }
      if (behaviorPrivate) {
        steps.push(`Behavior private rank response parsed (value=${behaviorPrivate.rankValue ?? 0}).`);
      }

      const behaviorPublic = await requestGc<CMsgGCToClientRankResponse>(
        EMSG_RANK_REQUEST,
        EMSG_RANK_RESPONSE,
        CMsgClientToGCRankRequest,
        CMsgGCToClientRankResponse,
        { rankType: RANK_TYPE_BEHAVIOR_PUBLIC },
      );
      if (behaviorPublic) {
        steps.push(`Behavior public rank response parsed (value=${behaviorPublic.rankValue ?? 0}).`);
      }

      // Current Dota protos expose behavior score, LP and chat restrictions, but
      // not a separate raw communication-score field. Keep it null unless a
      // future protocol field gives us a reliable value.
      if (data.communicationScore === undefined) data.communicationScore = null;

      finish({ ok: true });
    };

    const logonTimeout = setTimeout(() => {
      finish({ ok: false, error: "Steam/Dota GC check timed out (45s)." });
    }, LOGON_TIMEOUT_MS);

    client.on("error", (err: Error) => {
      finish({ ok: false, error: err.message });
    });

    client.on("loggedOn", () => {
      if (!client.steamID) return;
      data.steamId64 = client.steamID.getSteamID64();
      data.friendCode = steamId64ToFriendCode(data.steamId64);
      steps.push(`Steam logon ok (SteamID ${data.steamId64}).`);

      try {
        client.setPersona(SteamUser.EPersonaState.Online);
      } catch {
        // non-fatal
      }

      try {
        client.gamesPlayed(DOTA_APP_ID);
        steps.push("Dota 2 launched in Steam session.");
      } catch (err) {
        finish({ ok: false, error: `Failed to enter Dota 2 session: ${(err as Error).message}` });
      }
    });

    client.on("appLaunched", (appid) => {
      if (appid !== DOTA_APP_ID) return;
      sendHello();
      helloTimer = setInterval(sendHello, GC_HELLO_INTERVAL_MS);
    });

    client.on("receivedFromGC", (appid, msgType, payload) => {
      if (appid !== DOTA_APP_ID || settled) return;
      if (msgType === EGC_CLIENT_WELCOME) {
        gcReady = true;
        steps.push("Dota GC session established.");
        applyWelcome(payload, data, steps);
        void collectGcData();
        return;
      }
      if (msgType === EGC_CLIENT_CONNECTION_STATUS) {
        const status = decodeMessage<{ status?: number }>(CMsgConnectionStatus, payload);
        if (status?.status !== undefined && status.status !== 0) {
          steps.push(`Dota GC connection status=${status.status}.`);
        }
      }
    });

    client.on("user", (sid, persona) => {
      if (!client.steamID || sid.getSteamID64() !== client.steamID.getSteamID64()) return;
      if (persona.player_name) data.personaName = persona.player_name;
      if (persona.avatar_hash) {
        const hex = persona.avatar_hash.toString("hex");
        data.avatarUrl = `https://avatars.cloudflare.steamstatic.com/${hex}_full.jpg`;
      }
    });

    const opts: Record<string, unknown> = {
      accountName: input.login,
      password: input.password,
      rememberPassword: false,
    };
    if (input.sharedSecret) {
      try {
        opts.twoFactorCode = SteamTotp.generateAuthCode(input.sharedSecret);
      } catch (err) {
        finish({ ok: false, error: `Bad shared_secret: ${(err as Error).message}` });
        return;
      }
    }

    try {
      client.logOn(opts);
    } catch (err) {
      finish({ ok: false, error: (err as Error).message });
    }
  });
}
