// Minimal ambient types for DoctorMcKay's `steam-totp`.
declare module "steam-totp" {
  export function generateAuthCode(secret: string, timeOffset?: number): string;
  export function time(timeOffset?: number): number;
  export function getDeviceID(steamID: string | { toString(): string }): string;
}
