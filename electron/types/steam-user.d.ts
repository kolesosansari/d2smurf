// Ambient types for DoctorMcKay's `steam-user`. Covers the subset we use:
//   - gc-login.ts: logon to inspect persona / SteamID
//   - sda-register.ts: CM-routed login + enableTwoFactor / finalizeTwoFactor
//
// Replace with @types/steam-user if upstream ever ships one; expand here as
// we use more of the API.
declare module "steam-user" {
  import { EventEmitter } from "events";

  interface SteamUserOptions {
    autoRelogin?: boolean;
    [k: string]: unknown;
  }

  interface LogOnDetails {
    accountName?: string;
    password?: string;
    authCode?: string;
    twoFactorCode?: string;
    rememberPassword?: boolean;
    machineName?: string;
    clientOS?: number;
    refreshToken?: string;
    anonymous?: boolean;
    [k: string]: unknown;
  }

  interface SteamID {
    type: number;
    getSteamID64(): string;
    toString(): string;
  }

  interface SteamGuardDetails {
    isSteamGuardEnabled: boolean;
    isTwoFactorEnabled: boolean;
    isPhoneVerified: boolean;
    canTrade: boolean;
    timestampSteamGuardEnabled: Date | null;
    timestampTwoFactorEnabled: Date | null;
    timestampMachineSteamGuardEnabled: Date | null;
  }

  interface AddAuthenticatorResponse {
    shared_secret?: string | null;
    identity_secret?: string | null;
    secret_1?: string | null;
    serial_number?: string;
    revocation_code?: string;
    uri?: string;
    server_time?: number | string | null;
    account_name?: string;
    token_gid?: string;
    status?: number;
    phone_number_hint?: string;
  }

  type SteamGuardCallback = (code: string) => void;

  class SteamUser extends EventEmitter {
    constructor(options?: SteamUserOptions);
    readonly steamID: SteamID | null;

    logOn(details: LogOnDetails | true): void;
    logOff(): void;
    setPersona(state: number, name?: string): void;

    enableTwoFactor(): Promise<AddAuthenticatorResponse>;
    finalizeTwoFactor(secret: string | Buffer, activationCode: string): Promise<void>;
    getSteamGuardDetails(): Promise<SteamGuardDetails>;

    on(event: "loggedOn", listener: (details: { eresult: number }, parental: unknown) => void): this;
    on(event: "error", listener: (err: Error & { eresult?: number }) => void): this;
    on(
      event: "steamGuard",
      listener: (domain: string | null, callback: SteamGuardCallback, lastCodeWrong: boolean) => void,
    ): this;
    on(event: "refreshToken", listener: (refreshToken: string) => void): this;
    on(event: "disconnected", listener: (eresult: number, msg?: string) => void): this;
    on(event: "debug", listener: (msg: string) => void): this;
    on(
      event: "user",
      listener: (
        sid: SteamID,
        persona: {
          player_name?: string;
          avatar_hash?: Buffer;
          [k: string]: unknown;
        },
      ) => void,
    ): this;
    on(event: string | symbol, listener: (...args: never[]) => void): this;

    once: SteamUser["on"];

    static EPersonaState: { Online: number; [k: string]: number };
    static EResult: Record<string, number> & Record<number, string>;
    static EOSType: Record<string, number> & Record<number, string>;
  }

  export = SteamUser;
}
