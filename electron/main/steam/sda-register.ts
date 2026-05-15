/**
 * SDA registration via Steam's mobile WebAPI.
 *
 * The flow is intentionally stateful. Steam can require several user actions
 * before it allows adding a mobile authenticator:
 *
 *   1. Mobile login can require an email/device Steam Guard code.
 *   2. Accounts without a verified phone need a phone attach flow.
 *   3. Adding the authenticator sends an SMS activation code.
 *
 * We keep the same LoginSession and access token across those steps so Steam
 * does not generate a new email every time the renderer submits a code.
 */
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import * as protobuf from "protobufjs";
import {
  LoginSession,
  EAuthTokenPlatformType,
  EAuthSessionGuardType,
  EResult,
} from "steam-session";
import * as SteamTotp from "steam-totp";
import { getAccount, setMaFile } from "../database/accounts.repo";
import type {
  MaFileSecrets,
  SdaRegistrationResult,
  SdaStartOptions,
  SdaSteamGuardType,
} from "@shared/types";
// Minimal subset of the proto definitions in
// `node_modules/steam-user/protobufs/generated/steammessages_twofactor.steamclient.json`
// — duplicated here so we don't depend on steam-user's bundle layout.
import twofactorProtoJson from "./twofactor-proto.json";

const LOGON_TIMEOUT_MS = 45_000;
const SESSION_TTL_MS = 10 * 60_000;
const STEAM_API_HOST = "https://api.steampowered.com";

const protoRoot = protobuf.Root.fromJSON(
  twofactorProtoJson as unknown as protobuf.INamespace,
);
const AddAuthReq = protoRoot.lookupType("CTwoFactor_AddAuthenticator_Request");
const AddAuthResp = protoRoot.lookupType("CTwoFactor_AddAuthenticator_Response");
const FinalizeReq = protoRoot.lookupType("CTwoFactor_FinalizeAddAuthenticator_Request");
const FinalizeResp = protoRoot.lookupType("CTwoFactor_FinalizeAddAuthenticator_Response");

type PendingState =
  | "starting"
  | "awaiting-steam-guard"
  | "authenticated"
  | "awaiting-phone-number"
  | "awaiting-phone-email"
  | "awaiting-phone-sms"
  | "awaiting-activation";

interface PhoneAttachInput {
  phoneNumber: string;
  phoneCountryCode?: string;
}

interface PendingSession {
  session: LoginSession;
  accountId: string;
  steamId64?: string;
  accessToken?: string;
  secrets?: MaFileSecrets;
  state: PendingState;
  expiresAt: number;
  timer: NodeJS.Timeout;
  pendingPhone?: PhoneAttachInput;
  phoneWasAttached?: boolean;
  phoneVerificationCodeSent?: boolean;
}

const pendingSessions = new Map<string, PendingSession>();

function maskPhone(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const tail = value.replace(/[^0-9]/g, "").slice(-4);
  return tail ? `••• •• ${tail}` : value;
}

function normalizePhoneOptions(options?: SdaStartOptions): PhoneAttachInput | undefined {
  const phoneNumber = options?.phoneNumber?.trim();
  if (!phoneNumber) return undefined;
  const phoneCountryCode = options?.phoneCountryCode?.trim().toUpperCase();
  return {
    phoneNumber,
    phoneCountryCode: phoneCountryCode || undefined,
  };
}

function createPendingSession(input: {
  session: LoginSession;
  accountId: string;
  state: PendingState;
  pendingPhone?: PhoneAttachInput;
}): string {
  const sessionId = randomUUID();
  const timer = setTimeout(() => killSession(sessionId), SESSION_TTL_MS);
  pendingSessions.set(sessionId, {
    ...input,
    expiresAt: Date.now() + SESSION_TTL_MS,
    timer,
  });
  return sessionId;
}

function getPendingSession(sessionId: string): PendingSession | null {
  return pendingSessions.get(sessionId) ?? null;
}

function killSession(sessionId: string): void {
  const session = pendingSessions.get(sessionId);
  if (!session) return;
  clearTimeout(session.timer);
  try {
    session.session.cancelLoginAttempt();
  } catch {
    // ignore
  }
  try {
    session.session.removeAllListeners();
  } catch {
    // ignore
  }
  pendingSessions.delete(sessionId);
}

function formatEResult(status: number | undefined): string {
  if (status === undefined || Number.isNaN(status)) return "unknown";
  const name = (EResult as unknown as Record<number, string>)[status];
  return name ? `${name} (${status})` : `EResult ${status}`;
}

function diagnosticText(status: number | undefined): string {
  if (status === EResult.NoVerifiedPhone || status === EResult.NoMobileDeviceAvailable) {
    return "На аккаунте нет подтверждённого телефона. Введи номер в менеджере, затем подтверди письмо Steam и SMS-код.";
  }
  if (status === EResult.PhoneActivityLimitExceeded) {
    return "Steam отклонил привязку: на номере/аккаунте превышен лимит телефонных операций. Нужно подождать кулдаун Valve.";
  }
  if (status === EResult.PhoneNumberIsVOIP) {
    return "Steam отклонил номер как VOIP/виртуальный. Нужен обычный мобильный номер.";
  }
  if (status === EResult.RateLimitExceeded || status === EResult.LimitExceeded) {
    return "Steam временно ограничил запросы. Подожди и попробуй снова позже.";
  }
  if (status === EResult.AccessDenied) {
    return "Steam вернул AccessDenied. Обычно это значит, что мобильная сессия недействительна или аккаунту запрещена операция.";
  }

  const head = status
    ? `Steam отверг запрос на привязку SDA (${formatEResult(status)}).`
    : "Steam отверг запрос на привязку SDA.";
  return [
    head,
    "",
    "Скорее всего одно из:",
    "• Телефон был привязан слишком недавно — Valve держит anti-fraud кулдаун.",
    "• На аккаунте ноль покупок/трат на $5+ — Steam может блокировать часть операций.",
    "• Недавно отключали 2FA — действует кулдаун.",
    "• Аккаунт limited/restricted или Steam временно режет операцию по риску.",
  ].join("\n");
}

function phoneServiceError(action: string, status?: number, errorMessage?: string): string {
  if (status === EResult.PhoneActivityLimitExceeded) {
    return "Steam отклонил операцию с телефоном: превышен лимит. Подожди кулдаун Valve.";
  }
  if (status === EResult.PhoneNumberIsVOIP) {
    return "Steam отклонил номер как VOIP/виртуальный. Нужен обычный мобильный номер.";
  }
  if (status === EResult.InvalidParam) {
    return "Steam отклонил номер телефона. Проверь номер и код страны.";
  }
  if (status === EResult.NeedCaptcha) {
    return "Steam потребовал CAPTCHA для операции с телефоном. Этот сценарий пока нельзя пройти внутри менеджера.";
  }
  if (status === EResult.RateLimitExceeded || status === EResult.LimitExceeded) {
    return "Steam временно ограничил телефонные запросы. Подожди и попробуй снова позже.";
  }
  const suffix = status ? ` (${formatEResult(status)})` : "";
  return `${action} failed${suffix}${errorMessage ? `: ${errorMessage}` : ""}`;
}

interface AuthWait {
  promise: Promise<{ ok: true } | { ok: false; error: string }>;
  cancel: () => void;
}

function createAuthWait(session: LoginSession): AuthWait {
  let settled = false;
  let timer: NodeJS.Timeout | null = null;
  let settle: (value: { ok: true } | { ok: false; error: string }) => void = () => undefined;

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    session.removeListener("authenticated", onAuthenticated);
    session.removeListener("error", onError);
    session.removeListener("timeout", onTimeout);
  };
  const finish = (value: { ok: true } | { ok: false; error: string }) => {
    if (settled) return;
    settled = true;
    cleanup();
    settle(value);
  };
  const onAuthenticated = () => finish({ ok: true });
  const onError = (err: Error) => finish({ ok: false, error: err.message });
  const onTimeout = () => finish({ ok: false, error: "Steam logon timed out." });

  const promise = new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
    settle = resolve;
    timer = setTimeout(
      () => finish({ ok: false, error: "Steam logon timed out (45s)." }),
      LOGON_TIMEOUT_MS,
    );
    session.once("authenticated", onAuthenticated);
    session.once("error", onError);
    session.once("timeout", onTimeout);
  });

  return {
    promise,
    cancel: () => finish({ ok: false, error: "cancelled" }),
  };
}

interface IServiceResponse<T> {
  body?: T;
  status?: number;
  errorMessage?: string;
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
  )}&format=protobuf_raw`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const raw = Buffer.from(await resp.arrayBuffer());
  const xResult = resp.headers.get("x-eresult");
  const status = xResult ? Number(xResult) : undefined;
  const errorMessage = resp.headers.get("x-error_message") ?? undefined;
  if (!raw.length) {
    return { status, errorMessage, raw };
  }
  try {
    const decoded = respType.decode(raw);
    return {
      status,
      errorMessage,
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

interface JsonServiceResponse<T> {
  ok: boolean;
  body?: T;
  status?: number;
  errorMessage?: string;
}

function numericStatusFromJson(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const response = obj["response"];
  const candidates = [obj["eresult"], obj["result"], obj["status"]];
  if (response && typeof response === "object") {
    const responseObj = response as Record<string, unknown>;
    candidates.push(responseObj["eresult"], responseObj["result"], responseObj["status"]);
  }
  for (const candidate of candidates) {
    if (typeof candidate === "number") return candidate;
    if (typeof candidate === "string" && candidate.trim()) return Number(candidate);
  }
  return undefined;
}

async function callJsonService<T>(
  serviceMethod: string,
  payload: Record<string, string | number | boolean | undefined>,
  accessToken: string,
): Promise<JsonServiceResponse<T>> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined) body.set(key, String(value));
  }
  const url = `${STEAM_API_HOST}/${serviceMethod}/?access_token=${encodeURIComponent(
    accessToken,
  )}&format=json`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (err) {
    return { ok: false, errorMessage: (err as Error).message };
  }

  const text = await resp.text().catch(() => "");
  let json: unknown = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }

  const xResult = resp.headers.get("x-eresult");
  const status = xResult ? Number(xResult) : numericStatusFromJson(json);
  const errorMessage =
    resp.headers.get("x-error_message") ??
    ((json as Record<string, unknown>)["error"] as string | undefined) ??
    ((json as Record<string, unknown>)["error_message"] as string | undefined);
  const response =
    json && typeof json === "object" && "response" in json
      ? ((json as { response?: T }).response as T)
      : (json as T);

  return {
    ok: resp.ok && (status === undefined || status === EResult.OK),
    body: response,
    status,
    errorMessage,
  };
}

function getBooleanField(value: unknown, names: string[]): boolean | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  for (const name of names) {
    const candidate = obj[name];
    if (typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") return candidate !== 0;
    if (typeof candidate === "string") {
      if (candidate === "1" || candidate.toLowerCase() === "true") return true;
      if (candidate === "0" || candidate.toLowerCase() === "false") return false;
    }
  }
  return undefined;
}

function secretToBase64(value: Buffer | Uint8Array | string): string {
  if (typeof value === "string") return value;
  return Buffer.from(value).toString("base64");
}

function steamId64ToLong(steamId64: string): protobuf.Long {
  return protobuf.util.LongBits.from(steamId64).toLong(true);
}

function extractStoken(input: string): string | null {
  const normalized = input.trim().replace(/&amp;/g, "&");
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    const token = url.searchParams.get("stoken") ?? url.searchParams.get("token");
    if (token) return token;
  } catch {
    // Not a URL; try regex/raw token below.
  }
  const match = normalized.match(/(?:^|[?&#])(?:stoken|token)=([^&#]+)/i);
  if (match?.[1]) return decodeURIComponent(match[1]);
  return normalized;
}

function guardTypeFromSteam(type: EAuthSessionGuardType): SdaSteamGuardType | null {
  switch (type) {
    case EAuthSessionGuardType.EmailCode:
      return "email";
    case EAuthSessionGuardType.DeviceCode:
      return "device";
    case EAuthSessionGuardType.EmailConfirmation:
      return "emailConfirmation";
    case EAuthSessionGuardType.DeviceConfirmation:
      return "deviceConfirmation";
    default:
      return null;
  }
}

function pickCodeGuardAction(
  actions: Array<{ type: EAuthSessionGuardType; detail?: string }> | undefined,
): { type: EAuthSessionGuardType; detail?: string } | undefined {
  return actions?.find(
    (a) => a.type === EAuthSessionGuardType.EmailCode || a.type === EAuthSessionGuardType.DeviceCode,
  );
}

function pickRemoteGuardAction(
  actions: Array<{ type: EAuthSessionGuardType; detail?: string }> | undefined,
): { type: EAuthSessionGuardType; detail?: string } | undefined {
  return actions?.find(
    (a) =>
      a.type === EAuthSessionGuardType.EmailConfirmation ||
      a.type === EAuthSessionGuardType.DeviceConfirmation,
  );
}

async function finishAuthenticated(sessionId: string): Promise<SdaRegistrationResult> {
  const pending = getPendingSession(sessionId);
  if (!pending) return { ok: false, error: "Сессия SDA устарела — начни заново." };

  pending.state = "authenticated";
  try {
    await pending.session.refreshAccessToken();
  } catch (err) {
    killSession(sessionId);
    return {
      ok: false,
      error: `Failed to refresh mobile access token: ${(err as Error).message}`,
    };
  }

  const accessToken = pending.session.accessToken;
  const steamId = pending.session.steamID;
  if (!accessToken || !steamId) {
    killSession(sessionId);
    return { ok: false, error: "Mobile session is missing access token or SteamID." };
  }

  pending.accessToken = accessToken;
  pending.steamId64 = steamId.getSteamID64();

  if (pending.pendingPhone) {
    const phone = pending.pendingPhone;
    pending.pendingPhone = undefined;
    return beginPhoneAttach(sessionId, phone);
  }

  return requestAuthenticator(sessionId);
}

async function waitForPhoneEmailConfirmation(pending: PendingSession): Promise<boolean | undefined> {
  if (!pending.accessToken) return undefined;
  const waiting = await callJsonService<Record<string, unknown>>(
    "IPhoneService/IsAccountWaitingForEmailConfirmation/v1",
    {},
    pending.accessToken,
  );
  if (!waiting.ok) return undefined;
  return getBooleanField(waiting.body, [
    "awaiting_email_confirmation",
    "waiting_for_email_confirmation",
    "is_waiting",
    "waiting",
    "is_waiting_for_email_confirmation",
  ]);
}

async function beginPhoneAttach(
  sessionId: string,
  phone: PhoneAttachInput,
): Promise<SdaRegistrationResult> {
  const pending = getPendingSession(sessionId);
  if (!pending?.accessToken) return { ok: false, error: "Сессия SDA устарела — начни заново." };

  const setPhone = await callJsonService<Record<string, unknown>>(
    "IPhoneService/SetAccountPhoneNumber/v1",
    {
      phone_number: phone.phoneNumber,
      phone_country_code: phone.phoneCountryCode,
    },
    pending.accessToken,
  );
  if (!setPhone.ok && setPhone.status !== EResult.Pending) {
    return {
      ok: false,
      error: phoneServiceError("SetAccountPhoneNumber", setPhone.status, setPhone.errorMessage),
      sessionId,
    };
  }

  pending.phoneWasAttached = true;
  const waitingForEmail = await waitForPhoneEmailConfirmation(pending);
  if (waitingForEmail !== false) {
    pending.state = "awaiting-phone-email";
    return { ok: true, sessionId, nextStep: "phoneEmail" };
  }

  return sendPhoneVerificationCodeAndRequestAuthenticator(sessionId);
}

async function sendPhoneVerificationCodeAndRequestAuthenticator(
  sessionId: string,
): Promise<SdaRegistrationResult> {
  const pending = getPendingSession(sessionId);
  if (!pending?.accessToken) return { ok: false, error: "Сессия SDA устарела — начни заново." };

  if (!pending.phoneVerificationCodeSent) {
    const sent = await callJsonService<Record<string, unknown>>(
      "IPhoneService/SendPhoneVerificationCode/v1",
      { language: 0 },
      pending.accessToken,
    );
    if (
      !sent.ok &&
      sent.status !== EResult.InvalidState &&
      sent.status !== EResult.Pending &&
      sent.status !== EResult.Fail
    ) {
      return {
        ok: false,
        error: phoneServiceError("SendPhoneVerificationCode", sent.status, sent.errorMessage),
        sessionId,
      };
    }
    pending.phoneVerificationCodeSent = true;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  return requestAuthenticator(sessionId);
}

async function requestAuthenticator(sessionId: string): Promise<SdaRegistrationResult> {
  const pending = getPendingSession(sessionId);
  if (!pending?.accessToken || !pending.steamId64) {
    return { ok: false, error: "Сессия SDA устарела — начни заново." };
  }

  const deviceIdentifier = SteamTotp.getDeviceID(pending.steamId64);
  let addResp;
  try {
    addResp = await callIService<
      {
        steamid: protobuf.Long;
        authenticator_time: number;
        authenticator_type: number;
        device_identifier: string;
        sms_phone_id: string;
        version: number;
      },
      {
        shared_secret?: Buffer | string;
        serial_number?: string;
        revocation_code?: string;
        uri?: string;
        server_time?: string;
        account_name?: string;
        token_gid?: string;
        identity_secret?: Buffer | string;
        status?: number;
        phone_number_hint?: string;
      }
    >(
      "ITwoFactorService/AddAuthenticator/v1",
      AddAuthReq,
      AddAuthResp,
      {
        steamid: steamId64ToLong(pending.steamId64),
        authenticator_time: SteamTotp.time(),
        authenticator_type: 1,
        device_identifier: deviceIdentifier,
        sms_phone_id: "1",
        version: 2,
      },
      pending.accessToken,
    );
  } catch (err) {
    return { ok: false, error: `AddAuthenticator transport failed: ${(err as Error).message}` };
  }

  const addBody = addResp.body;
  const status = addBody?.status ?? addResp.status;

  if (!addBody?.shared_secret || !addBody.identity_secret) {
    if (
      status === EResult.Fail ||
      status === EResult.NoVerifiedPhone ||
      status === EResult.NoMobileDeviceAvailable
    ) {
      if (pending.phoneWasAttached) {
        if (!pending.phoneVerificationCodeSent) {
          return sendPhoneVerificationCodeAndRequestAuthenticator(sessionId);
        }
        return {
          ok: false,
          error:
            "Steam всё ещё считает телефон неподтверждённым после email-клика и отправки SMS. Проверь, что письмо было подтверждено именно для этого аккаунта, и попробуй начать заново.",
          sessionId,
        };
      }
      pending.state = "awaiting-phone-number";
      return { ok: true, sessionId, nextStep: "phoneNumber", phoneMissing: true };
    }
    if (status === EResult.InvalidState || status === EResult.DuplicateRequest) {
      return {
        ok: false,
        error:
          "На аккаунте уже есть активный или незавершённый мобильный аутентификатор. Сначала отключи/заверши его через Steam.",
        alreadyEnabled: true,
      };
    }
    return {
      ok: false,
      error: addResp.errorMessage ?? diagnosticText(status),
      sessionId,
    };
  }

  const sharedSecret = secretToBase64(addBody.shared_secret);
  const identitySecret = secretToBase64(addBody.identity_secret);
  pending.secrets = {
    shared_secret: sharedSecret,
    identity_secret: identitySecret,
    revocation_code: addBody.revocation_code,
    serial_number: addBody.serial_number ? String(addBody.serial_number) : undefined,
    uri: addBody.uri,
    token_gid: addBody.token_gid,
    account_name: addBody.account_name,
    server_time: addBody.server_time ? Number(addBody.server_time) : undefined,
    device_id: deviceIdentifier,
    steamid: pending.steamId64,
  };
  pending.state = "awaiting-activation";

  return {
    ok: true,
    sessionId,
    nextStep: "activationCode",
    revocationCode: pending.secrets.revocation_code,
    maskedPhone: maskPhone(addBody.phone_number_hint),
  };
}

export async function startSdaRegistration(
  accountId: string,
  options?: SdaStartOptions,
): Promise<SdaRegistrationResult> {
  const account = getAccount(accountId);
  if (!account) return { ok: false, error: "Account not found." };
  if (!account.password) return { ok: false, error: "Account has no stored password." };
  if (account.hasMaFile === 1) {
    return {
      ok: false,
      error: "У этого аккаунта уже привязан .maFile. Сначала открепи его в Деталях аккаунта.",
    };
  }

  let session: LoginSession;
  try {
    session = new LoginSession(EAuthTokenPlatformType.MobileApp);
    session.loginTimeout = LOGON_TIMEOUT_MS;
  } catch (err) {
    return { ok: false, error: `steam-session init failed: ${(err as Error).message}` };
  }

  const sessionId = createPendingSession({
    session,
    accountId,
    state: "starting",
    pendingPhone: normalizePhoneOptions(options),
  });

  let startResp;
  try {
    startResp = await session.startWithCredentials({
      accountName: account.login,
      password: account.password,
    });
  } catch (err) {
    killSession(sessionId);
    return { ok: false, error: (err as Error).message };
  }

  if (startResp.actionRequired) {
    const codeAction = pickCodeGuardAction(startResp.validActions);
    if (codeAction) {
      const guardType = guardTypeFromSteam(codeAction.type);
      pendingSessions.get(sessionId)!.state = "awaiting-steam-guard";
      return {
        ok: true,
        sessionId,
        nextStep: "steamGuard",
        guardType: guardType ?? "email",
        guardDetail: codeAction.detail,
      };
    }

    const remoteAction = pickRemoteGuardAction(startResp.validActions);
    if (remoteAction) {
      const authWait = createAuthWait(session);
      const auth = await authWait.promise;
      if (!auth.ok) {
        killSession(sessionId);
        const guardType = guardTypeFromSteam(remoteAction.type);
        return {
          ok: false,
          error:
            guardType === "emailConfirmation"
              ? "Steam ждёт подтверждение входа по ссылке в email, но подтверждение не пришло за 45 секунд."
              : "Steam ждёт подтверждение входа в мобильном приложении, но подтверждение не пришло за 45 секунд.",
        };
      }
      return finishAuthenticated(sessionId);
    }

    killSession(sessionId);
    return { ok: false, error: "Steam требует неподдерживаемый тип подтверждения входа." };
  }

  const authWait = createAuthWait(session);
  const auth = await authWait.promise;
  if (!auth.ok) {
    killSession(sessionId);
    return { ok: false, error: auth.error };
  }
  return finishAuthenticated(sessionId);
}

export async function submitSteamGuardCode(
  sessionId: string,
  code: string,
): Promise<SdaRegistrationResult> {
  const pending = getPendingSession(sessionId);
  if (!pending || pending.state !== "awaiting-steam-guard") {
    return { ok: false, error: "Сессия SDA устарела — начни заново." };
  }
  const authWait = createAuthWait(pending.session);
  try {
    await pending.session.submitSteamGuardCode(code.trim());
  } catch (err) {
    authWait.cancel();
    return { ok: false, error: (err as Error).message, sessionId };
  }
  const auth = await authWait.promise;
  if (!auth.ok) {
    killSession(sessionId);
    return { ok: false, error: auth.error };
  }
  return finishAuthenticated(sessionId);
}

export async function submitPhoneNumber(
  sessionId: string,
  phoneNumber: string,
  phoneCountryCode?: string,
): Promise<SdaRegistrationResult> {
  const pending = getPendingSession(sessionId);
  if (!pending || pending.state !== "awaiting-phone-number") {
    return { ok: false, error: "Сессия SDA устарела — начни заново." };
  }
  const phone = normalizePhoneOptions({ phoneNumber, phoneCountryCode });
  if (!phone) return { ok: false, error: "Введите номер телефона.", sessionId };
  return beginPhoneAttach(sessionId, phone);
}

export async function confirmPhoneEmail(
  sessionId: string,
  stokenOrLink: string,
): Promise<SdaRegistrationResult> {
  const pending = getPendingSession(sessionId);
  if (!pending || pending.state !== "awaiting-phone-email" || !pending.accessToken) {
    return { ok: false, error: "Сессия SDA устарела — начни заново." };
  }
  const stoken = extractStoken(stokenOrLink);
  if (!stoken) return { ok: false, error: "Вставь ссылку из письма Steam или параметр stoken.", sessionId };
  const confirmed = await callJsonService<Record<string, unknown>>(
    "IPhoneService/ConfirmAddPhoneToAccount/v1",
    {
      steamid: pending.steamId64,
      stoken,
    },
    pending.accessToken,
  );
  if (!confirmed.ok) {
    return {
      ok: false,
      error: phoneServiceError("ConfirmAddPhoneToAccount", confirmed.status, confirmed.errorMessage),
      sessionId,
    };
  }
  pending.phoneWasAttached = true;
  return sendPhoneVerificationCodeAndRequestAuthenticator(sessionId);
}

export async function checkPhoneEmailConfirmation(
  sessionId: string,
): Promise<SdaRegistrationResult> {
  const pending = getPendingSession(sessionId);
  if (!pending || pending.state !== "awaiting-phone-email" || !pending.accessToken) {
    return { ok: false, error: "Сессия SDA устарела — начни заново." };
  }

  const waitingForEmail = await waitForPhoneEmailConfirmation(pending);
  if (waitingForEmail !== false) {
    return { ok: true, sessionId, nextStep: "phoneEmail" };
  }

  pending.phoneWasAttached = true;
  return sendPhoneVerificationCodeAndRequestAuthenticator(sessionId);
}

export async function submitPhoneSmsCode(
  sessionId: string,
  code: string,
): Promise<SdaRegistrationResult> {
  const pending = getPendingSession(sessionId);
  if (!pending || pending.state !== "awaiting-phone-sms" || !pending.accessToken) {
    return { ok: false, error: "Сессия SDA устарела — начни заново." };
  }
  const verified = await callJsonService<Record<string, unknown>>(
    "IPhoneService/VerifyAccountPhoneWithCode/v1",
    { code: code.trim() },
    pending.accessToken,
  );
  if (!verified.ok) {
    return {
      ok: false,
      error: phoneServiceError("VerifyAccountPhoneWithCode", verified.status, verified.errorMessage),
      sessionId,
    };
  }
  pending.phoneWasAttached = true;
  return requestAuthenticator(sessionId);
}

export async function submitSdaActivationCode(
  sessionId: string,
  activationCode: string,
): Promise<SdaRegistrationResult> {
  const session = pendingSessions.get(sessionId);
  if (!session || session.state !== "awaiting-activation" || !session.secrets || !session.steamId64) {
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
    const authenticatorCode = SteamTotp.generateAuthCode(session.secrets!.shared_secret);

    try {
      const resp = await callIService<
        {
          steamid: protobuf.Long;
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
          steamid: steamId64ToLong(session.steamId64!),
          authenticator_code: authenticatorCode,
          authenticator_time: authenticatorTime,
          activation_code: activationCode.trim(),
          validate_sms_code: true,
        },
        session.accessToken!,
      );
      const body = resp.body;
      const status = body?.status ?? resp.status;
      if (body?.success) return { ok: true, success: true };
      if (body?.want_more) return { ok: true, wantMore: true };
      return {
        ok: false,
        error:
          status === EResult.TwoFactorActivationCodeMismatch || status === EResult.SMSCodeFailed
            ? "Steam отверг SMS-код активации. Проверь код и попробуй снова."
            : status
              ? `Steam отверг код активации (${formatEResult(status)}).`
              : "Steam отверг код активации.",
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  };

  let lastErr: string | undefined;
  for (let i = 0; i < 3; i += 1) {
    const r = await tryFinalize();
    if (r.success) {
      lastErr = undefined;
      break;
    }
    if (r.wantMore) {
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
      sessionId,
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

  const revocationCode = session.secrets.revocation_code;
  killSession(sessionId);
  return { ok: true, nextStep: "complete", revocationCode };
}

export function cancelSdaRegistration(sessionId: string): { ok: boolean } {
  killSession(sessionId);
  return { ok: true };
}
