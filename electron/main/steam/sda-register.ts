/**
 * SDA (Steam Desktop Authenticator) registration / enable-two-factor flow.
 *
 * Flow:
 *   1. `startSdaRegistration(accountId)`:
 *      - log into Steam with stored credentials
 *      - check 2FA / phone status
 *      - call `enableTwoFactor` — Steam returns secrets and sends an
 *        activation SMS to the phone bound to the account
 *      - keep the connected client around in `pendingSessions`
 *   2. `submitSdaActivationCode(sessionId, code)`:
 *      - call `finalizeTwoFactor` with the SMS code
 *      - persist the .maFile to the local vault and bind it to the
 *        account row
 *      - disconnect and clear the pending session
 *   3. `cancelSdaRegistration(sessionId)` cleans up without finalizing.
 *
 * Limitations:
 *   - Adding/verifying a phone number on the Steam account is NOT done
 *     here. If the account has no verified phone, `enableTwoFactor` will
 *     return without secrets and we surface a clear error pointing the
 *     user at Steam's phone-add page. Phone provisioning lives on the
 *     Steam *web* API and needs a separate web-session flow.
 *   - Each Steam account can only have one mobile authenticator at a
 *     time. If 2FA is already enabled we refuse early.
 */
import { randomUUID } from "node:crypto";
import SteamUser from "steam-user";
import * as SteamTotp from "steam-totp";
import { getAccount, setMaFile } from "../database/accounts.repo";
import type { MaFileSecrets } from "@shared/types";

const LOGON_TIMEOUT_MS = 30_000;
const SESSION_TTL_MS = 5 * 60_000;

interface PendingSession {
  client: SteamUser;
  accountId: string;
  secrets: MaFileSecrets;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

const pendingSessions = new Map<string, PendingSession>();

function maskPhone(value: string | undefined): string | undefined {
  if (!value) return value;
  const tail = value.replace(/[^0-9]/g, "").slice(-4);
  return tail ? `••• •• ${tail}` : value;
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
  pendingSessions.delete(sessionId);
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
      error: "У этого аккаунта уже привязан .maFile. Сначала открепи его в Деталях аккаунта.",
    };
  }

  return new Promise((resolve) => {
    const client = new SteamUser({ autoRelogin: false });
    let settled = false;

    const fail = (msg: string): void => {
      if (settled) return;
      settled = true;
      try {
        client.logOff();
      } catch {
        // ignore
      }
      resolve({ ok: false, error: msg });
    };

    const timeout = setTimeout(() => fail("Steam logon timed out (30s)."), LOGON_TIMEOUT_MS);

    client.on("error", (err: Error) => {
      clearTimeout(timeout);
      fail(err.message);
    });

    client.on("loggedOn", async () => {
      clearTimeout(timeout);
      try {
        // Check current Steam Guard / phone state. The client typings here
        // are minimal — fall back to `any`-style indexing where the upstream
        // shim does not expose every method.
        type GuardDetails = {
          isTwoFactorEnabled?: boolean;
          isPhoneVerified?: boolean;
        };
        let guard: GuardDetails | null = null;
        try {
          const result = await (
            client as unknown as {
              getSteamGuardDetails(): Promise<GuardDetails>;
            }
          ).getSteamGuardDetails();
          guard = result;
        } catch {
          // Non-fatal: we'll attempt enableTwoFactor anyway.
        }

        if (guard?.isTwoFactorEnabled) {
          if (settled) return;
          settled = true;
          try {
            client.logOff();
          } catch {
            // ignore
          }
          resolve({
            ok: false,
            alreadyEnabled: true,
            error:
              "На этом Steam-аккаунте уже включён мобильный аутентификатор. Сначала отключи его в Steam (Настройки → Безопасность аккаунта) или через revocation code.",
          });
          return;
        }

        if (guard && guard.isPhoneVerified === false) {
          if (settled) return;
          settled = true;
          try {
            client.logOff();
          } catch {
            // ignore
          }
          resolve({
            ok: false,
            phoneMissing: true,
            error:
              "На аккаунте нет подтверждённого номера телефона. Привяжи его сначала через приложение Steam или https://store.steampowered.com/phone/add — потом запусти SDA-регистрацию снова.",
          });
          return;
        }

        const body = await (
          client as unknown as {
            enableTwoFactor(): Promise<{
              status?: number;
              shared_secret?: string;
              identity_secret?: string;
              revocation_code?: string;
              serial_number?: string | number;
              uri?: string;
              token_gid?: string;
              account_name?: string;
              server_time?: number;
              phone_number_hint?: string;
            }>;
          }
        ).enableTwoFactor();

        if (!body || !body.shared_secret || !body.identity_secret) {
          // Steam refused AddAuthenticator. `status` is a Steam EResult value
          // — 2 (k_EResultFail) is the most common "generic failure" we see.
          // Surface the raw status to the user and a checklist of the real
          // reasons Steam tends to reject the call.
          const status = body?.status;
          const lines: string[] = [
            status
              ? `Steam отверг запрос на привязку SDA (status ${status}).`
              : "Steam отверг запрос на привязку SDA.",
            "",
            "Скорее всего одно из:",
            "• Аккаунт ни разу не логинился через мобильное приложение Steam (Android/iOS). Залогинься в мобилку, выйди и попробуй снова.",
            "• Телефон был привязан меньше 15 дней назад — Valve держит anti-fraud кулдаун.",
            "• На аккаунте ноль покупок/трат на $5+ — Steam в части регионов требует минимальную активность.",
            "• Недавно отключали 2FA — действует 14-дневный кулдаун.",
            "• Менеджер логинится как обычный Steam-клиент, а Steam для AddAuthenticator иногда требует mobile-platform login. Над этим я уже работаю отдельно.",
          ];
          if (settled) return;
          settled = true;
          try {
            client.logOff();
          } catch {
            // ignore
          }
          resolve({
            ok: false,
            error: lines.join("\n"),
          });
          return;
        }

        const secrets: MaFileSecrets = {
          shared_secret: body.shared_secret,
          identity_secret: body.identity_secret,
          revocation_code: body.revocation_code,
          serial_number: body.serial_number ? String(body.serial_number) : undefined,
          uri: body.uri,
          token_gid: body.token_gid,
          account_name: body.account_name ?? account.login,
          server_time: body.server_time,
          device_id: client.steamID
            ? SteamTotp.getDeviceID(client.steamID.getSteamID64())
            : undefined,
          steamid: client.steamID?.getSteamID64(),
        };

        const sessionId = randomUUID();
        const expiresAt = Date.now() + SESSION_TTL_MS;
        const timer = setTimeout(() => killSession(sessionId), SESSION_TTL_MS);
        pendingSessions.set(sessionId, {
          client,
          accountId,
          secrets,
          expiresAt,
          timer,
        });

        if (settled) return;
        settled = true;
        resolve({
          ok: true,
          sessionId,
          revocationCode: secrets.revocation_code,
          maskedPhone: maskPhone(body.phone_number_hint),
        });
      } catch (err) {
        fail((err as Error).message);
      }
    });

    try {
      client.logOn({
        accountName: account.login,
        password: account.password,
        rememberPassword: false,
      });
    } catch (err) {
      clearTimeout(timeout);
      fail((err as Error).message);
    }
  });
}

export async function submitSdaActivationCode(
  sessionId: string,
  activationCode: string,
): Promise<SubmitSdaCodeResult> {
  const session = pendingSessions.get(sessionId);
  if (!session) return { ok: false, error: "Сессия SDA устарела — начни заново." };

  try {
    await (
      session.client as unknown as {
        finalizeTwoFactor(secret: string, activationCode: string): Promise<void>;
      }
    ).finalizeTwoFactor(session.secrets.shared_secret, activationCode.trim());
  } catch (err) {
    return {
      ok: false,
      error: `Steam отверг код: ${(err as Error).message}`,
      revocationCode: session.secrets.revocation_code,
    };
  }

  // Build a SDA-compatible .maFile JSON so it can be exported/imported in
  // the standard SDA app as well.
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
