/**
 * SDA registration via Steam's CM (TCP) protocol — Node equivalent of
 * Jessecar96's SteamDesktopAuthenticator 1.0.15 flow.
 *
 * Why CM and not WebAPI:
 *   The official SDA explicitly switched to SteamKit2 3.0.0-Beta.4 in 1.0.15
 *   to "fix logging into Steam" — i.e. to authenticate via the Steam CM
 *   protocol (TCP) instead of HTTPS-only `IAuthenticationService`. Valve's
 *   anti-fraud treats the WebAPI route more strictly than CM-routed login,
 *   and `ITwoFactorService/AddAuthenticator` over HTTPS routinely returns
 *   `EResult.Fail (2)` even when the account is eligible. The Node
 *   equivalent of SteamKit2 is DoctorMcKay's `steam-user`, which keeps a
 *   real CM TCP connection open and sends `TwoFactor.AddAuthenticator#1`
 *   as a CM unified message — exactly what SteamKit2 does.
 *
 * The flow is intentionally stateful. Steam can require several user
 * actions before it allows adding a mobile authenticator:
 *
 *   1. Logging in can require an email/device Steam Guard code.
 *   2. Accounts without a verified phone need a phone-attach flow.
 *   3. Adding the authenticator sends an SMS activation code.
 *
 * We keep the same `SteamUser` (and its CM connection + tokens) across
 * those steps so the same session is reused for every call.
 */
import { randomUUID } from "node:crypto";
import SteamUser from "steam-user";
import * as SteamTotp from "steam-totp";
import { getAccount, setMaFile } from "../database/accounts.repo";
import type {
  MaFileSecrets,
  SdaRegistrationResult,
  SdaStartOptions,
} from "@shared/types";

const LOGON_TIMEOUT_MS = 45_000;
const SESSION_TTL_MS = 10 * 60_000;
const STEAM_API_HOST = "https://api.steampowered.com";

const EResult = SteamUser.EResult as Record<string, number>;
const EOSType = SteamUser.EOSType as Record<string, number>;

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
  client: SteamUser;
  accountId: string;
  steamId64?: string;
  refreshToken?: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
  secrets?: MaFileSecrets;
  state: PendingState;
  expiresAt: number;
  timer: NodeJS.Timeout;
  pendingPhone?: PhoneAttachInput;
  phoneWasAttached?: boolean;
  phoneVerificationCodeSent?: boolean;
  steamGuardCallback?: (code: string) => void;
  steamGuardDomain?: string | null;
  lastGuardCodeWrong?: boolean;
  logonSettled?: boolean;
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

function getPendingSession(sessionId: string): PendingSession | null {
  return pendingSessions.get(sessionId) ?? null;
}

function killSession(sessionId: string): void {
  const session = pendingSessions.get(sessionId);
  if (!session) return;
  clearTimeout(session.timer);
  try {
    session.client.logOff();
  } catch {
    // best-effort
  }
  try {
    session.client.removeAllListeners();
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

/**
 * Promise that resolves once steam-user has either logged on, errored out,
 * or emitted `steamGuard` (which means CM is asking the user for a 2FA /
 * email code).
 */
function waitForLogonSettled(
  pending: PendingSession,
): Promise<
  | { kind: "loggedOn" }
  | { kind: "steamGuard"; domain: string | null; lastCodeWrong: boolean; callback: (code: string) => void }
  | { kind: "error"; message: string }
> {
  const client = pending.client;
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      client.removeListener("loggedOn", onLoggedOn);
      client.removeListener("error", onError);
      client.removeListener("steamGuard", onSteamGuard);
      client.removeListener("disconnected", onDisconnected);
    };
    const finish = (
      value:
        | { kind: "loggedOn" }
        | {
            kind: "steamGuard";
            domain: string | null;
            lastCodeWrong: boolean;
            callback: (code: string) => void;
          }
        | { kind: "error"; message: string },
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const onLoggedOn = () => finish({ kind: "loggedOn" });
    const onError = (err: Error) => finish({ kind: "error", message: err.message });
    const onDisconnected = (eresult: number, msg?: string) =>
      finish({
        kind: "error",
        message: msg
          ? `Steam disconnected: ${msg} (${formatEResult(eresult)})`
          : `Steam disconnected (${formatEResult(eresult)}).`,
      });
    const onSteamGuard = (
      domain: string | null,
      callback: (code: string) => void,
      lastCodeWrong: boolean,
    ) =>
      finish({
        kind: "steamGuard",
        domain,
        lastCodeWrong,
        callback,
      });
    const timer = setTimeout(
      () => finish({ kind: "error", message: "Steam logon timed out (45s)." }),
      LOGON_TIMEOUT_MS,
    );

    client.once("loggedOn", onLoggedOn);
    client.once("error", onError);
    client.once("disconnected", onDisconnected);
    client.once("steamGuard", onSteamGuard);
  });
}

/**
 * Get a fresh short-lived access token via steam-user's internal
 * `LoginSession`. Under the hood this calls
 * `IAuthenticationService.GenerateAccessTokenForApp#1` over the active CM
 * connection (CMAuthTransport), which is the same authenticated channel
 * SteamKit2's `SteamClient.Authentication` uses in Jessecar SDA.
 *
 * The resulting token is a SteamClient-audience JWT. We need it for HTTPS
 * calls to IPhoneService — IPhoneService endpoints accept any
 * client-issued access token as an `access_token` query parameter.
 */
async function ensureAccessToken(pending: PendingSession): Promise<{
  token: string | null;
  error?: string;
}> {
  if (
    pending.accessToken &&
    pending.accessTokenExpiresAt &&
    pending.accessTokenExpiresAt > Date.now() + 30_000
  ) {
    return { token: pending.accessToken };
  }

  const internal = pending.client as unknown as {
    _loginSession?: {
      accessToken?: string;
      refreshToken?: string;
      refreshAccessToken?: () => Promise<void>;
    };
    _logOnDetails?: { access_token?: string };
  };

  const loginSession = internal._loginSession;
  if (loginSession) {
    try {
      // steam-session caches the most recently fetched access token. Force
      // a refresh: GenerateAccessTokenForApp via CMAuthTransport.
      if (typeof loginSession.refreshAccessToken === "function") {
        await loginSession.refreshAccessToken();
      }
      if (loginSession.accessToken) {
        pending.accessToken = loginSession.accessToken;
        // SteamClient JWTs are valid for ~24h; refresh proactively after
        // 30 minutes to keep the multi-step flow healthy.
        pending.accessTokenExpiresAt = Date.now() + 30 * 60_000;
        return { token: pending.accessToken };
      }
    } catch (err) {
      return {
        token: null,
        error: `LoginSession.refreshAccessToken() failed: ${(err as Error).message}`,
      };
    }
  }

  return {
    token: null,
    error: loginSession
      ? "steam-user LoginSession is alive but did not produce an access token."
      : "steam-user did not expose an internal LoginSession after logon.",
  };
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

/**
 * IPhoneService HTTPS helper. We keep this as a plain JSON form-encoded
 * call (matching Jessecar SDA's SteamAuth/AuthenticatorLinker), but the
 * `access_token` we feed in here comes from a CM-routed login session
 * (see `ensureAccessToken`), not from an HTTPS-only LoginSession.
 */
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

/**
 * Called once steam-user emits `loggedOn`. Picks up the access/refresh
 * tokens, decides whether we need to attach a phone first, otherwise goes
 * straight to AddAuthenticator.
 */
async function finishAuthenticated(sessionId: string): Promise<SdaRegistrationResult> {
  const pending = getPendingSession(sessionId);
  if (!pending) return { ok: false, error: "Сессия SDA устарела — начни заново." };

  pending.state = "authenticated";
  pending.steamId64 = pending.client.steamID?.getSteamID64();

  // steam-user emits `refreshToken` and also stores the refresh token in
  // `_logOnDetails.access_token` (it's named `access_token` for historical
  // reasons, but the CM only accepts refresh tokens). Read it directly so
  // we don't have to race the event.
  const internal = pending.client as unknown as {
    _logOnDetails?: { access_token?: string };
  };
  pending.refreshToken = internal._logOnDetails?.access_token;

  if (!pending.steamId64) {
    killSession(sessionId);
    return { ok: false, error: "Steam-сессия не вернула SteamID." };
  }

  // Optional pre-flight check via CM unified message: refuse early if 2FA
  // is already enabled, and skip the phone-attach prompt if Steam already
  // says the phone is verified.
  try {
    const guard = await pending.client.getSteamGuardDetails();
    if (guard.isTwoFactorEnabled) {
      killSession(sessionId);
      return {
        ok: false,
        alreadyEnabled: true,
        error:
          "На этом Steam-аккаунте уже включён мобильный аутентификатор. Сначала отключи его (Steam → Настройки → Безопасность) или через revocation code.",
      };
    }
    if (guard.isPhoneVerified) {
      pending.phoneWasAttached = true;
    }
  } catch {
    // Non-fatal: enableTwoFactor will surface the same condition.
  }

  if (pending.pendingPhone && !pending.phoneWasAttached) {
    const phone = pending.pendingPhone;
    pending.pendingPhone = undefined;
    return beginPhoneAttach(sessionId, phone);
  }

  return requestAuthenticator(sessionId);
}

async function waitForPhoneEmailConfirmation(pending: PendingSession): Promise<boolean | undefined> {
  const { token } = await ensureAccessToken(pending);
  if (!token) return undefined;
  const waiting = await callJsonService<Record<string, unknown>>(
    "IPhoneService/IsAccountWaitingForEmailConfirmation/v1",
    {},
    token,
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
  if (!pending) return { ok: false, error: "Сессия SDA устарела — начни заново." };
  const { token, error: tokenError } = await ensureAccessToken(pending);
  if (!token) {
    return {
      ok: false,
      error: `Не удалось получить access token для IPhoneService${tokenError ? `: ${tokenError}` : "."}`,
      sessionId,
    };
  }

  const setPhone = await callJsonService<Record<string, unknown>>(
    "IPhoneService/SetAccountPhoneNumber/v1",
    {
      phone_number: phone.phoneNumber,
      phone_country_code: phone.phoneCountryCode,
    },
    token,
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
  if (!pending) return { ok: false, error: "Сессия SDA устарела — начни заново." };
  const { token, error: tokenError } = await ensureAccessToken(pending);
  if (!token) {
    return {
      ok: false,
      error: `Не удалось получить access token для IPhoneService${tokenError ? `: ${tokenError}` : "."}`,
      sessionId,
    };
  }

  if (!pending.phoneVerificationCodeSent) {
    const sent = await callJsonService<Record<string, unknown>>(
      "IPhoneService/SendPhoneVerificationCode/v1",
      { language: 0 },
      token,
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
    // Mirror SteamAuth: it explicitly waits 2s here before continuing.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  return requestAuthenticator(sessionId);
}

/**
 * Calls `client.enableTwoFactor()` (which under the hood sends
 * `TwoFactor.AddAuthenticator#1` as a CM unified message — the equivalent
 * of SteamKit2's `UnifiedMessages.SendMessage<ITwoFactor>` in Jessecar's
 * SDA 1.0.15).
 */
async function requestAuthenticator(sessionId: string): Promise<SdaRegistrationResult> {
  const pending = getPendingSession(sessionId);
  if (!pending || !pending.steamId64) {
    return { ok: false, error: "Сессия SDA устарела — начни заново." };
  }

  let addBody;
  try {
    addBody = await pending.client.enableTwoFactor();
  } catch (err) {
    return { ok: false, error: `AddAuthenticator failed: ${(err as Error).message}` };
  }

  const status = addBody.status;
  if (!addBody.shared_secret || !addBody.identity_secret) {
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
      error: diagnosticText(status),
      sessionId,
    };
  }

  const deviceIdentifier = SteamTotp.getDeviceID(pending.steamId64);
  pending.secrets = {
    shared_secret: addBody.shared_secret,
    identity_secret: addBody.identity_secret,
    revocation_code: addBody.revocation_code,
    serial_number: addBody.serial_number ? String(addBody.serial_number) : undefined,
    uri: addBody.uri,
    token_gid: addBody.token_gid,
    account_name: addBody.account_name,
    server_time:
      typeof addBody.server_time === "number"
        ? addBody.server_time
        : addBody.server_time
          ? Number(addBody.server_time)
          : undefined,
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

  const client = new SteamUser({ autoRelogin: false });
  const sessionId = randomUUID();
  const pending: PendingSession = {
    client,
    accountId,
    state: "starting",
    pendingPhone: normalizePhoneOptions(options),
    expiresAt: Date.now() + SESSION_TTL_MS,
    timer: setTimeout(() => killSession(sessionId), SESSION_TTL_MS),
  };
  pendingSessions.set(sessionId, pending);

  try {
    client.logOn({
      accountName: account.login,
      password: account.password,
      rememberPassword: false,
      // Mirror Jessecar SDA's LoginForm.cs: ClientOSType = EOSType.Android9.
      // Steam treats this fingerprint as a real Android device, which is
      // what unlocks the mobile authenticator flow.
      clientOS: EOSType.Android9,
      machineName: "SDA",
    });
  } catch (err) {
    killSession(sessionId);
    return { ok: false, error: `steam-user logOn failed: ${(err as Error).message}` };
  }

  const settled = await waitForLogonSettled(pending);
  if (settled.kind === "error") {
    killSession(sessionId);
    return { ok: false, error: settled.message };
  }
  if (settled.kind === "steamGuard") {
    pending.state = "awaiting-steam-guard";
    pending.steamGuardCallback = settled.callback;
    pending.steamGuardDomain = settled.domain;
    pending.lastGuardCodeWrong = settled.lastCodeWrong;
    return {
      ok: true,
      sessionId,
      nextStep: "steamGuard",
      // domain==null => device 2FA prompt; domain==<email> => email code.
      guardType: settled.domain ? "email" : "device",
      guardDetail: settled.domain ?? undefined,
    };
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
  const callback = pending.steamGuardCallback;
  if (!callback) {
    return { ok: false, error: "Steam Guard prompt is no longer active.", sessionId };
  }

  pending.steamGuardCallback = undefined;
  try {
    callback(code.trim());
  } catch (err) {
    return { ok: false, error: `Failed to submit Steam Guard code: ${(err as Error).message}`, sessionId };
  }

  const settled = await waitForLogonSettled(pending);
  if (settled.kind === "error") {
    killSession(sessionId);
    return { ok: false, error: settled.message };
  }
  if (settled.kind === "steamGuard") {
    // CM rejected the code and re-prompted (or escalated to a different
    // guard type). Save the new callback and bounce the renderer back to
    // the code prompt with a meaningful detail.
    pending.steamGuardCallback = settled.callback;
    pending.steamGuardDomain = settled.domain;
    pending.lastGuardCodeWrong = settled.lastCodeWrong;
    return {
      ok: true,
      sessionId,
      nextStep: "steamGuard",
      guardType: settled.domain ? "email" : "device",
      guardDetail: settled.lastCodeWrong
        ? "Неверный код. Попробуй ещё раз."
        : (settled.domain ?? undefined),
    };
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
  if (!pending || pending.state !== "awaiting-phone-email") {
    return { ok: false, error: "Сессия SDA устарела — начни заново." };
  }
  const { token, error: tokenError } = await ensureAccessToken(pending);
  if (!token) {
    return {
      ok: false,
      error: `Не удалось получить access token для IPhoneService${tokenError ? `: ${tokenError}` : "."}`,
      sessionId,
    };
  }
  const stoken = extractStoken(stokenOrLink);
  if (!stoken) return { ok: false, error: "Вставь ссылку из письма Steam или параметр stoken.", sessionId };
  const confirmed = await callJsonService<Record<string, unknown>>(
    "IPhoneService/ConfirmAddPhoneToAccount/v1",
    {
      steamid: pending.steamId64,
      stoken,
    },
    token,
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
  if (!pending || pending.state !== "awaiting-phone-email") {
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
  if (!pending || pending.state !== "awaiting-phone-sms") {
    return { ok: false, error: "Сессия SDA устарела — начни заново." };
  }
  const { token, error: tokenError } = await ensureAccessToken(pending);
  if (!token) {
    return {
      ok: false,
      error: `Не удалось получить access token для IPhoneService${tokenError ? `: ${tokenError}` : "."}`,
      sessionId,
    };
  }
  const verified = await callJsonService<Record<string, unknown>>(
    "IPhoneService/VerifyAccountPhoneWithCode/v1",
    { code: code.trim() },
    token,
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
  if (
    !session ||
    session.state !== "awaiting-activation" ||
    !session.secrets ||
    !session.steamId64
  ) {
    return {
      ok: false,
      error: "Сессия SDA устарела — закрой окно и начни заново.",
    };
  }

  try {
    // steam-user.finalizeTwoFactor sends `TwoFactor.FinalizeAddAuthenticator#1`
    // as a CM unified message, retries up to 30 times with a 30s server-time
    // step (to handle clock drift), and only resolves once Steam returns
    // success.
    await session.client.finalizeTwoFactor(session.secrets.shared_secret, activationCode.trim());
  } catch (err) {
    const message = (err as Error).message;
    return {
      ok: false,
      error:
        message === "Invalid activation code"
          ? "Steam отверг SMS-код активации. Проверь код и попробуй снова."
          : `Steam отверг код активации: ${message}`,
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
