/**
 * SDA registration via Steam's *mobile* WebAPI.
 *
 * Steam's anti-fraud often refuses to grant a mobile authenticator over
 * the regular Steam-client connection (the Steam CM accepts a logon, but
 * `ITwoFactorService/AddAuthenticator` then returns a generic
 * `k_EResultFail (2)`). The flow that the official SDA / Steam Mobile App
 * use is different: log into the *mobile* platform via the public auth
 * service, hold the resulting mobile access token, and call
 * `ITwoFactorService` over plain HTTPS using that token.
 *
 * That is what this module implements:
 *
 *   1. `startSdaRegistration(accountId)`
 *      - log in via `steam-session` with `EAuthTokenPlatformType.MobileApp`
 *      - call `refreshAccessToken` to materialize the access token
 *      - POST `ITwoFactorService/AddAuthenticator/v1/` with that token
 *      - hold the access token + protobuf-derived secrets in
 *        `pendingSessions` and return the masked phone hint and
 *        revocation code to the renderer
 *   2. `submitSdaActivationCode(sessionId, code)`
 *      - POST `ITwoFactorService/FinalizeAddAuthenticator/v1/`
 *      - on `success`, persist the `.maFile` row to the encrypted vault
 *        and bind it to the account
 *      - on `want_more`, regenerate the TOTP and retry (Steam's natural
 *        backoff after the user's phone clock drifts)
 *
 * If `AddAuthenticator` still fails on the mobile platform we surface
 * the raw Steam EResult to the user along with a checklist of the most
 * common reasons (account never logged into Steam mobile app, recent
 * phone attach, no $5 purchase, recent 2FA removal).
 */
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import * as protobuf from "protobufjs";
import {
  LoginSession,
  EAuthTokenPlatformType,
  EAuthSessionGuardType,
} from "steam-session";
import * as SteamTotp from "steam-totp";
import { getAccount, setMaFile } from "../database/accounts.repo";
import type { MaFileSecrets } from "@shared/types";
// Minimal subset of the proto definitions in
// `node_modules/steam-user/protobufs/generated/steammessages_twofactor.steamclient.json`
// — duplicated here so we don't depend on steam-user's bundle layout.
import twofactorProtoJson from "./twofactor-proto.json";

const LOGON_TIMEOUT_MS = 30_000;
const SESSION_TTL_MS = 5 * 60_000;
const STEAM_API_HOST = "https://api.steampowered.com";

const protoRoot = protobuf.Root.fromJSON(
  twofactorProtoJson as unknown as protobuf.INamespace,
);
const AddAuthReq = protoRoot.lookupType("CTwoFactor_AddAuthenticator_Request");
const AddAuthResp = protoRoot.lookupType("CTwoFactor_AddAuthenticator_Response");
const FinalizeReq = protoRoot.lookupType("CTwoFactor_FinalizeAddAuthenticator_Request");
const FinalizeResp = protoRoot.lookupType("CTwoFactor_FinalizeAddAuthenticator_Response");

interface PendingSession {
  session: LoginSession;
  accountId: string;
  steamId64: string;
  accessToken: string;
  secrets: MaFileSecrets;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

const pendingSessions = new Map<string, PendingSession>();

function maskPhone(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const tail = value.replace(/[^0-9]/g, "").slice(-4);
  return tail ? `••• •• ${tail}` : value;
}

function killSession(sessionId: string): void {
  const session = pendingSessions.get(sessionId);
  if (!session) return;
  clearTimeout(session.timer);
  try {
    // LoginSession has cancelLoginAttempt() but we're past auth; nothing
    // explicit to disconnect. Best-effort.
    session.session.removeAllListeners();
  } catch {
    // ignore
  }
  pendingSessions.delete(sessionId);
}

function diagnosticText(status: number | undefined): string {
  const head = status
    ? `Steam отверг запрос на привязку SDA (status ${status}).`
    : "Steam отверг запрос на привязку SDA.";
  return [
    head,
    "",
    "Скорее всего одно из:",
    "• Аккаунт ни разу не логинился через мобильное приложение Steam (Android/iOS). Залогинься в мобилку хотя бы раз и попробуй снова.",
    "• Телефон был привязан меньше 15 дней назад — Valve держит anti-fraud кулдаун.",
    "• На аккаунте ноль покупок/трат на $5+ — Steam в части регионов требует минимальную активность.",
    "• Недавно отключали 2FA — действует 14-дневный кулдаун.",
    "• Аккаунт ограничен (limited account) — нужно купить что-то на $5+ или получить гифт.",
  ].join("\n");
}

interface IServiceResponse<T> {
  body?: T;
  status?: number;
  raw?: Buffer;
}

async function callIService<TReq extends object, TResp>(
  serviceMethod: string,
  reqType: protobuf.Type,
  respType: protobuf.Type,
  payload: TReq,
  accessToken: string,
): Promise<IServiceResponse<TResp>> {
  const err = reqType.verify(payload);
  if (err) throw new Error(`Bad protobuf payload for ${serviceMethod}: ${err}`);
  const message = reqType.create(payload);
  const encoded = reqType.encode(message).finish();
  const body = new URLSearchParams();
  body.set("input_protobuf_encoded", Buffer.from(encoded).toString("base64"));

  const url = `${STEAM_API_HOST}/${serviceMethod}/?access_token=${encodeURIComponent(
    accessToken,
  )}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const raw = Buffer.from(await resp.arrayBuffer());
  // The IService responses use a custom non-zero status header rather
  // than HTTP error codes — we still want to read the body even if
  // resp.ok is false.
  const xResult = resp.headers.get("x-eresult");
  const status = xResult ? Number(xResult) : undefined;
  if (!raw.length) {
    return { status, raw };
  }
  try {
    const decoded = respType.decode(raw);
    return {
      status,
      body: respType.toObject(decoded, {
        longs: String,
        bytes: Buffer,
        defaults: false,
      }) as TResp,
      raw,
    };
  } catch (decodeErr) {
    throw new Error(
      `Failed to decode ${serviceMethod} response (${(decodeErr as Error).message}): ${raw.toString("hex")}`,
    );
  }
}

export interface StartSdaResult {
  ok: boolean;
  error?: string;
  sessionId?: string;
  revocationCode?: string;
  maskedPhone?: string;
  alreadyEnabled?: boolean;
  phoneMissing?: boolean;
}

export interface SubmitSdaCodeResult {
  ok: boolean;
  error?: string;
  revocationCode?: string;
}

export async function startSdaRegistration(accountId: string): Promise<StartSdaResult> {
  const account = getAccount(accountId);
  if (!account) return { ok: false, error: "Account not found." };
  if (!account.password) return { ok: false, error: "Account has no stored password." };
  if (account.hasMaFile === 1) {
    return {
      ok: false,
      error:
        "У этого аккаунта уже привязан .maFile. Сначала открепи его в Деталях аккаунта.",
    };
  }

  let session: LoginSession;
  try {
    session = new LoginSession(EAuthTokenPlatformType.MobileApp);
  } catch (err) {
    return { ok: false, error: `steam-session init failed: ${(err as Error).message}` };
  }

  const startResult = await new Promise<{ ok: true } | { ok: false; error: string }>(
    (resolve) => {
      let settled = false;
      const settle = (v: { ok: true } | { ok: false; error: string }) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      const timer = setTimeout(
        () => settle({ ok: false, error: "Steam logon timed out (30s)." }),
        LOGON_TIMEOUT_MS,
      );
      session.on("authenticated", () => {
        clearTimeout(timer);
        settle({ ok: true });
      });
      session.on("error", (err: Error) => {
        clearTimeout(timer);
        settle({ ok: false, error: err.message });
      });
      session.on("timeout", () => {
        clearTimeout(timer);
        settle({ ok: false, error: "Steam logon timed out." });
      });
      session
        .startWithCredentials({
          accountName: account.login,
          password: account.password,
        })
        .then((startResp) => {
          if (!startResp.actionRequired) return;
          const types = (startResp.validActions ?? []).map((a) => a.type);
          if (types.includes(EAuthSessionGuardType.DeviceCode)) {
            clearTimeout(timer);
            settle({
              ok: false,
              error:
                "На этом аккаунте уже включён мобильный аутентификатор. Сначала отключи его через Steam (или revocation code).",
            });
            return;
          }
          if (types.includes(EAuthSessionGuardType.EmailCode)) {
            clearTimeout(timer);
            settle({
              ok: false,
              error:
                "Steam требует email-код подтверждения для входа в этот аккаунт. Введи email-код один раз в обычном Steam-клиенте, чтобы пометить устройство, и попробуй снова.",
            });
            return;
          }
          clearTimeout(timer);
          settle({
            ok: false,
            error: `Steam требует дополнительное подтверждение (${types.join(",")}). SDA-привязка пока не поддерживает этот сценарий.`,
          });
        })
        .catch((err: Error) => {
          clearTimeout(timer);
          settle({ ok: false, error: err.message });
        });
    },
  );

  if (!startResult.ok) {
    return { ok: false, error: startResult.error };
  }

  // After authentication we still need to materialize the access token —
  // steam-session does not return one from startWithCredentials.
  try {
    await session.refreshAccessToken();
  } catch (err) {
    return { ok: false, error: `Failed to refresh mobile access token: ${(err as Error).message}` };
  }

  const accessToken = session.accessToken;
  const steamId = session.steamID;
  if (!accessToken || !steamId) {
    return { ok: false, error: "Mobile session is missing access token or SteamID." };
  }

  const steamId64 = steamId.getSteamID64();
  const deviceIdentifier = SteamTotp.getDeviceID(steamId64);

  let addResp;
  try {
    addResp = await callIService<
      {
        steamid: string;
        authenticator_type: number;
        device_identifier: string;
        sms_phone_id: string;
        version: number;
      },
      {
        shared_secret?: Buffer;
        serial_number?: string;
        revocation_code?: string;
        uri?: string;
        server_time?: string;
        account_name?: string;
        token_gid?: string;
        identity_secret?: Buffer;
        status?: number;
        phone_number_hint?: string;
      }
    >(
      "ITwoFactorService/AddAuthenticator/v1",
      AddAuthReq,
      AddAuthResp,
      {
        steamid: steamId64,
        authenticator_type: 1,
        device_identifier: deviceIdentifier,
        sms_phone_id: "1",
        version: 2,
      },
      accessToken,
    );
  } catch (err) {
    return { ok: false, error: `AddAuthenticator transport failed: ${(err as Error).message}` };
  }

  const addBody = addResp.body;
  const statusFromHeader = addResp.status;

  if (!addBody || !addBody.shared_secret || !addBody.identity_secret) {
    return {
      ok: false,
      error: diagnosticText(addBody?.status ?? statusFromHeader),
    };
  }

  const sharedSecret = Buffer.from(addBody.shared_secret).toString("base64");
  const identitySecret = Buffer.from(addBody.identity_secret).toString("base64");

  const secrets: MaFileSecrets = {
    shared_secret: sharedSecret,
    identity_secret: identitySecret,
    revocation_code: addBody.revocation_code,
    serial_number: addBody.serial_number ? String(addBody.serial_number) : undefined,
    uri: addBody.uri,
    token_gid: addBody.token_gid,
    account_name: addBody.account_name ?? account.login,
    server_time: addBody.server_time ? Number(addBody.server_time) : undefined,
    device_id: deviceIdentifier,
    steamid: steamId64,
  };

  const sessionId = randomUUID();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const timer = setTimeout(() => killSession(sessionId), SESSION_TTL_MS);
  pendingSessions.set(sessionId, {
    session,
    accountId,
    steamId64,
    accessToken,
    secrets,
    expiresAt,
    timer,
  });

  return {
    ok: true,
    sessionId,
    revocationCode: secrets.revocation_code,
    maskedPhone: maskPhone(addBody.phone_number_hint),
  };
}

export async function submitSdaActivationCode(
  sessionId: string,
  activationCode: string,
): Promise<SubmitSdaCodeResult> {
  const session = pendingSessions.get(sessionId);
  if (!session) {
    return {
      ok: false,
      error: "Сессия SDA устарела — закрой окно и начни заново.",
    };
  }

  const tryFinalize = async (): Promise<{
    ok: boolean;
    error?: string;
    success?: boolean;
    wantMore?: boolean;
  }> => {
    const authenticatorTime = SteamTotp.time();
    const authenticatorCode = SteamTotp.generateAuthCode(session.secrets.shared_secret);

    try {
      const resp = await callIService<
        {
          steamid: string;
          authenticator_code: string;
          authenticator_time: number;
          activation_code: string;
          validate_sms_code?: boolean;
        },
        {
          success?: boolean;
          want_more?: boolean;
          server_time?: string;
          status?: number;
        }
      >(
        "ITwoFactorService/FinalizeAddAuthenticator/v1",
        FinalizeReq,
        FinalizeResp,
        {
          steamid: session.steamId64,
          authenticator_code: authenticatorCode,
          authenticator_time: authenticatorTime,
          activation_code: activationCode.trim(),
        },
        session.accessToken,
      );
      const body = resp.body;
      const status = body?.status ?? resp.status;
      if (body?.success) return { ok: true, success: true };
      if (body?.want_more) return { ok: true, wantMore: true };
      return {
        ok: false,
        error: status
          ? `Steam отверг код активации (status ${status}).`
          : "Steam отверг код активации.",
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  };

  // Try up to 3 times in case Steam's clock vs ours is drifting (it
  // emits want_more once the TOTP rolls).
  let lastErr: string | undefined;
  for (let i = 0; i < 3; i++) {
    const r = await tryFinalize();
    if (r.success) {
      lastErr = undefined;
      break;
    }
    if (r.wantMore) {
      // Sleep ~31 seconds so TOTP advances at least one slot, then retry.
      await new Promise((resolve) => setTimeout(resolve, 31_000));
      continue;
    }
    lastErr = r.error ?? "unknown";
    break;
  }

  if (lastErr) {
    return {
      ok: false,
      error: lastErr,
      revocationCode: session.secrets.revocation_code,
    };
  }

  const rawJsonObj: Record<string, unknown> = {
    shared_secret: session.secrets.shared_secret,
    identity_secret: session.secrets.identity_secret,
    revocation_code: session.secrets.revocation_code,
    serial_number: session.secrets.serial_number,
    uri: session.secrets.uri,
    server_time: session.secrets.server_time,
    account_name: session.secrets.account_name,
    token_gid: session.secrets.token_gid,
    device_id: session.secrets.device_id,
    steamid: session.secrets.steamid,
  };
  for (const key of Object.keys(rawJsonObj)) {
    if (rawJsonObj[key] === undefined) delete rawJsonObj[key];
  }
  const rawJson = JSON.stringify(rawJsonObj, null, 2);

  setMaFile({
    accountId: session.accountId,
    sharedSecret: session.secrets.shared_secret,
    identitySecret: session.secrets.identity_secret,
    serialNumber: session.secrets.serial_number ?? null,
    revocationCode: session.secrets.revocation_code ?? null,
    deviceId: session.secrets.device_id ?? null,
    rawJson,
  });

  killSession(sessionId);
  return { ok: true, revocationCode: session.secrets.revocation_code };
}

export function cancelSdaRegistration(sessionId: string): { ok: boolean } {
  killSession(sessionId);
  return { ok: true };
}
