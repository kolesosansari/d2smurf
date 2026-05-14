/**
 * Steam logon helper. Uses DoctorMcKay's `steam-user` to log into the
 * Steam network with the stored credentials and a Steam Guard code
 * generated from the linked `.maFile` (`shared_secret`). This is
 * enough to capture the account's SteamID64, persona name, and avatar.
 *
 * GC (Game Coordinator) integration — sending CMsgGCClientHello / pulling
 * profile card / behavior score — is intentionally NOT in this module yet.
 * It will be added in a follow-up once we know the messages we care about
 * and can build them as protobuf payloads on top of steam-user's
 * `sendToGC` / `receivedFromGC`.
 */
import SteamUser from "steam-user";
import * as SteamTotp from "steam-totp";

export interface SteamLogonInput {
  login: string;
  password: string;
  sharedSecret?: string | null;
}

export interface SteamLogonResult {
  ok: boolean;
  error?: string;
  steamId64?: string;
  personaName?: string | null;
  avatarUrl?: string | null;
}

const LOGON_TIMEOUT_MS = 30_000;

/**
 * Perform a one-shot Steam logon and disconnect cleanly. The session is
 * very short — just enough to capture the resolved SteamID64 and basic
 * persona info — but Steam will still record this as an active login,
 * which is fine for our use case (the user already logs into this
 * account anyway).
 */
export function steamLogon(input: SteamLogonInput): Promise<SteamLogonResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: SteamLogonResult): void => {
      if (settled) return;
      settled = true;
      try {
        client.logOff();
      } catch {
        // ignore — best-effort cleanup
      }
      resolve(r);
    };

    const client = new SteamUser({ autoRelogin: false });

    const timeout = setTimeout(() => {
      finish({ ok: false, error: "Steam logon timed out (30s)." });
    }, LOGON_TIMEOUT_MS);

    client.on("error", (err: Error) => {
      clearTimeout(timeout);
      finish({ ok: false, error: err.message });
    });

    client.on("loggedOn", () => {
      // After loggedOn the SteamID is available; persona name / avatar
      // arrive asynchronously via subsequent events. Pull them right
      // away by setting persona state to Online which encourages Steam
      // to push the user's profile data.
      try {
        client.setPersona(SteamUser.EPersonaState.Online);
      } catch {
        // non-fatal
      }
    });

    let resolvedPersona: string | null = null;
    let resolvedAvatar: string | null = null;

    type PersonaInfo = { player_name?: string; avatar_hash?: Buffer };

    const flush = (): void => {
      if (!client.steamID) return;
      clearTimeout(timeout);
      finish({
        ok: true,
        steamId64: client.steamID.getSteamID64(),
        personaName: resolvedPersona,
        avatarUrl: resolvedAvatar,
      });
    };

    client.on("user", (sid: { getSteamID64(): string }, persona: PersonaInfo) => {
      if (!client.steamID || sid.getSteamID64() !== client.steamID.getSteamID64()) return;
      if (persona.player_name) resolvedPersona = persona.player_name;
      if (persona.avatar_hash) {
        const hex = persona.avatar_hash.toString("hex");
        resolvedAvatar = `https://avatars.cloudflare.steamstatic.com/${hex}_full.jpg`;
      }
      // Wait one tick to let Steam push more of the persona, then resolve.
      setTimeout(flush, 250);
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
      clearTimeout(timeout);
      finish({ ok: false, error: (err as Error).message });
    }
  });
}
