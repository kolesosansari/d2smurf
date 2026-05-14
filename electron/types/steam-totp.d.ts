// Minimal ambient types for DoctorMcKay's `steam-totp` — only the
// helpers we actually call from gc-login.ts.
declare module "steam-totp" {
  export function generateAuthCode(secret: string, timeOffset?: number): string;
  export function time(timeOffset?: number): number;
}
