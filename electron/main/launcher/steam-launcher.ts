import { spawn, exec } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { getSettings } from "../database/settings.repo";

const execAsync = promisify(exec);

export interface LauncherResult {
  ok: boolean;
  message: string;
}

function detectSteamPath(): string | null {
  const configured = getSettings().steamPath;
  if (configured && existsSync(configured)) return configured;

  const candidates: string[] = [];
  if (process.platform === "win32") {
    const programFiles = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    candidates.push(join(programFiles, "Steam", "steam.exe"));
    candidates.push("C:\\Program Files\\Steam\\steam.exe");
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Steam.app/Contents/MacOS/steam_osx");
  } else {
    candidates.push("/usr/bin/steam");
    candidates.push("/usr/games/steam");
  }
  return candidates.find((p) => existsSync(p)) ?? null;
}

async function killSteam(): Promise<void> {
  if (process.platform === "win32") {
    try {
      await execAsync("taskkill /F /IM steam.exe");
    } catch {
      // ignore
    }
  } else {
    try {
      await execAsync("pkill -x steam || true");
    } catch {
      // ignore
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 800));
}

/**
 * Mark a Steam account as the most-recent / auto-login candidate inside
 * `loginusers.vdf`. This is how Steam decides which account to log in to
 * automatically on launch. We only flip flags — we don't store secrets here.
 */
export function setMostRecentAccount(steamPath: string, login: string): boolean {
  const loginUsersPath = join(dirname(steamPath), "config", "loginusers.vdf");
  if (!existsSync(loginUsersPath)) return false;
  const content = readFileSync(loginUsersPath, "utf8");
  const updated = content
    .replace(/"MostRecent"\s+"1"/g, '"MostRecent"\t\t"0"')
    .replace(
      new RegExp(`("AccountName"\\s+"${escapeRegex(login)}"[\\s\\S]*?)"MostRecent"\\s+"0"`, "i"),
      `$1"MostRecent"\t\t"1"`,
    );
  if (updated === content) return false;
  writeFileSync(loginUsersPath, updated, "utf8");
  return true;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function launchSteamWithAccount(
  login: string,
  password: string,
): Promise<LauncherResult> {
  const steamPath = detectSteamPath();
  if (!steamPath) {
    return { ok: false, message: "Steam executable not found. Configure path in settings." };
  }
  await killSteam();
  try {
    spawn(steamPath, ["-login", login, password], {
      detached: true,
      stdio: "ignore",
    }).unref();
    return { ok: true, message: `Launching Steam as ${login}` };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export async function launchSteamSilent(): Promise<LauncherResult> {
  const steamPath = detectSteamPath();
  if (!steamPath) {
    return { ok: false, message: "Steam executable not found." };
  }
  try {
    spawn(steamPath, ["-silent"], { detached: true, stdio: "ignore" }).unref();
    return { ok: true, message: "Steam launched in silent mode." };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export async function launchOverplus(): Promise<LauncherResult> {
  const overplusPath = getSettings().overplusPath;
  if (!overplusPath) {
    return { ok: false, message: "Overplus path not configured." };
  }
  if (!existsSync(overplusPath)) {
    return { ok: false, message: `Overplus executable not found at ${overplusPath}` };
  }
  try {
    spawn(overplusPath, [], { detached: true, stdio: "ignore" }).unref();
    return { ok: true, message: "Overplus launched." };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

/**
 * Orchestrate a "Launch with Overplus" workflow:
 *   1. Mark the chosen account as MostRecent in `loginusers.vdf` so that
 *      when Overplus relaunches Steam, Steam logs into the right one.
 *   2. Kill any running Steam instance so Overplus starts from a clean slate.
 *   3. Spawn Overplus — Overplus itself will then start Steam + Dota 2.
 *
 * The Guard auto-confirm tray service handles the Steam Guard prompt
 * that appears once Steam logs in (it lives in a separate module so it
 * stays running regardless of who actually starts Steam).
 */
export async function startWithOverplus(login: string): Promise<LauncherResult> {
  const steamPath = detectSteamPath();
  if (steamPath) {
    setMostRecentAccount(steamPath, login);
  }
  await killSteam();
  const launched = await launchOverplus();
  if (!launched.ok) {
    if (steamPath) {
      const direct = await launchSteamWithAccount(login, "");
      return direct.ok
        ? { ok: true, message: `${launched.message}; launched Steam directly instead.` }
        : { ok: false, message: launched.message };
    }
    return launched;
  }
  return { ok: true, message: `Overplus started; Steam will auto-login as ${login}.` };
}
