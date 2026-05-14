// Minimal ambient types for DoctorMcKay's `steam-user` — covers only
// what gc-login.ts touches. Replace with @types/steam-user if it ever
// ships, or expand here as we use more of the API.
declare module "steam-user" {
  import { EventEmitter } from "events";

  interface SteamUserOptions {
    autoRelogin?: boolean;
    [k: string]: unknown;
  }

  interface LogOnDetails {
    accountName?: string;
    password?: string;
    twoFactorCode?: string;
    rememberPassword?: boolean;
    [k: string]: unknown;
  }

  interface SteamID {
    getSteamID64(): string;
  }

  class SteamUser extends EventEmitter {
    constructor(options?: SteamUserOptions);
    readonly steamID: SteamID | null;
    logOn(details: LogOnDetails): void;
    logOff(): void;
    setPersona(state: number, name?: string): void;
    static EPersonaState: { Online: number; [k: string]: number };
  }

  export = SteamUser;
}
