import { BrowserWindow, ipcMain, dialog, app } from "electron";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createAccount,
  deleteAccount,
  getAccount,
  getMaFile,
  listAccounts,
  removeMaFile,
  reorderAccounts,
  setMaFile,
  updateAccount,
} from "../database/accounts.repo";
import { getSettings, updateSettings } from "../database/settings.repo";
import {
  getStatus,
  initializeVault,
  lockVault,
  unlockVault,
} from "../vault/vault";
import { parseAccountsTxt } from "../importers/txt-importer";
import { parseMaFile, parseMaFileContent, parseMaFolder } from "../importers/mafile-importer";
import { refreshAccountPublic } from "../steam/checker";
import { deepCheckAccount } from "../steam/deep-checker";
import {
  cancelSdaRegistration,
  checkPhoneEmailConfirmation,
  confirmPhoneEmail,
  startSdaRegistration,
  submitPhoneNumber,
  submitSdaActivationCode,
  submitSteamGuardCode,
} from "../steam/sda-register";
import { generateSteamGuardCode, secondsLeftInWindow } from "../steam/totp";
import * as autoCheck from "../scheduler/auto-check";
import { launchSteamWithAccount, startWithOverplus } from "../launcher/steam-launcher";
import type { AccountInput, AccountUpdate, ImportResult, SdaStartOptions } from "@shared/types";

function getMainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null;
}

function broadcast(channel: string, payload: unknown): void {
  const win = getMainWindow();
  if (win) win.webContents.send(channel, payload);
}

export function registerIpcHandlers(): void {
  // ---- vault ----
  ipcMain.handle("vault:status", () => getStatus());
  ipcMain.handle("vault:initialize", (_e, password: string) => {
    const r = initializeVault(password);
    if (r.ok) autoCheck.start();
    return r;
  });
  ipcMain.handle("vault:unlock", (_e, password: string) => {
    const r = unlockVault(password);
    if (r.ok) autoCheck.start();
    return r;
  });
  ipcMain.handle("vault:lock", () => {
    autoCheck.stop();
    lockVault();
    return { ok: true };
  });

  // ---- accounts ----
  ipcMain.handle("accounts:list", () => listAccounts());
  ipcMain.handle("accounts:get", (_e, id: string) => getAccount(id));
  ipcMain.handle("accounts:create", (_e, input: AccountInput) => createAccount(input));
  ipcMain.handle("accounts:update", (_e, id: string, patch: AccountUpdate) =>
    updateAccount(id, patch),
  );
  ipcMain.handle("accounts:delete", (_e, id: string) => deleteAccount(id));
  ipcMain.handle("accounts:reorder", (_e, ids: string[]) => {
    reorderAccounts(ids);
    return { ok: true };
  });
  ipcMain.handle("accounts:check-one", async (_e, id: string) => {
    const account = getAccount(id);
    if (!account) return { ok: false, error: "Not found" };
    const refreshed = await refreshAccountPublic(account);
    return { ok: true, account: refreshed };
  });
  ipcMain.handle("accounts:bulk-check", async () => {
    void autoCheck.runCheckAll();
    return { ok: true };
  });
  ipcMain.handle("accounts:deep-check", async (_e, id: string) => {
    const account = getAccount(id);
    if (!account) return { ok: false, error: "Not found", steps: [] };
    return deepCheckAccount(account);
  });

  // ---- import ----
  ipcMain.handle("import:txt", async (_e, payload: { content: string; tags?: string[] }) => {
    const { entries, errors } = parseAccountsTxt(payload.content);
    let added = 0;
    let skipped = 0;
    const errorList = [...errors];
    for (const e of entries) {
      try {
        createAccount({
          login: e.login,
          password: e.password,
          email: e.email ?? null,
          emailPassword: e.emailPassword ?? null,
          tags: payload.tags,
        });
        added += 1;
      } catch (err) {
        skipped += 1;
        errorList.push(`${e.login}: ${(err as Error).message}`);
      }
    }
    const result: ImportResult = { added, skipped, errors: errorList };
    return result;
  });

  ipcMain.handle(
    "import:mafile",
    async (_e, payload: { content: string; accountId?: string }) => {
      const parsed = parseMaFileContent(payload.content);
      let accountId = payload.accountId;
      if (!accountId) {
        const accountName = parsed.secrets.account_name;
        if (!accountName) {
          return { ok: false, error: "Cannot match .maFile without account_name. Pick an account." };
        }
        const all = listAccounts();
        const match = all.find((a) => a.login.toLowerCase() === accountName.toLowerCase());
        if (!match) {
          return {
            ok: false,
            error: `No account with login "${accountName}" — create it first or pick an account manually.`,
          };
        }
        accountId = match.id;
      }
      setMaFile({
        accountId,
        sharedSecret: parsed.secrets.shared_secret,
        identitySecret: parsed.secrets.identity_secret,
        serialNumber: parsed.secrets.serial_number ?? null,
        revocationCode: parsed.secrets.revocation_code ?? null,
        deviceId: parsed.secrets.device_id ?? null,
        rawJson: parsed.rawJson,
      });
      if (parsed.secrets.steamid) {
        updateAccount(accountId, { steamId64: parsed.secrets.steamid });
      }
      return { ok: true, accountId };
    },
  );

  ipcMain.handle("import:mafile-folder", async (_e, folderPath: string) => {
    const parsed = await parseMaFolder(folderPath);
    const all = listAccounts();
    const result: ImportResult = { added: 0, skipped: 0, errors: [] };
    for (const ma of parsed) {
      const name = ma.secrets.account_name;
      if (!name) {
        result.skipped += 1;
        result.errors.push(`${ma.filePath}: no account_name in .maFile`);
        continue;
      }
      const match = all.find((a) => a.login.toLowerCase() === name.toLowerCase());
      if (!match) {
        result.skipped += 1;
        result.errors.push(`${ma.filePath}: account ${name} not in vault`);
        continue;
      }
      setMaFile({
        accountId: match.id,
        sharedSecret: ma.secrets.shared_secret,
        identitySecret: ma.secrets.identity_secret,
        serialNumber: ma.secrets.serial_number ?? null,
        revocationCode: ma.secrets.revocation_code ?? null,
        deviceId: ma.secrets.device_id ?? null,
        rawJson: ma.rawJson,
      });
      if (ma.secrets.steamid) {
        updateAccount(match.id, { steamId64: ma.secrets.steamid });
      }
      result.added += 1;
    }
    return result;
  });

  ipcMain.handle("dialog:pick-mafile", async () => {
    const win = getMainWindow();
    if (!win) return { ok: false };
    const result = await dialog.showOpenDialog(win, {
      title: "Pick a .maFile",
      filters: [{ name: ".maFile", extensions: ["maFile", "json"] }],
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false };
    const parsed = await parseMaFile(result.filePaths[0]);
    return { ok: true, content: parsed.rawJson, filePath: parsed.filePath };
  });

  ipcMain.handle("dialog:pick-folder", async () => {
    const win = getMainWindow();
    if (!win) return { ok: false };
    const result = await dialog.showOpenDialog(win, {
      title: "Pick a folder",
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false };
    return { ok: true, path: result.filePaths[0] };
  });

  // ---- settings ----
  ipcMain.handle("settings:get", () => getSettings());
  ipcMain.handle("settings:update", (_e, patch) => {
    const next = updateSettings(patch);
    autoCheck.start();
    return next;
  });

  // ---- launcher ----
  ipcMain.handle("launcher:start-steam", async (_e, id: string) => {
    const account = getAccount(id);
    if (!account) return { ok: false, message: "Not found" };
    return launchSteamWithAccount(account.login, account.password);
  });
  ipcMain.handle("launcher:start-with-overplus", async (_e, id: string) => {
    const account = getAccount(id);
    if (!account) return { ok: false, message: "Not found" };
    return startWithOverplus(account.login);
  });

  // ---- sda / totp ----
  ipcMain.handle("sda:generate-code", (_e, id: string) => {
    const ma = getMaFile(id);
    if (!ma) return { ok: false, error: "No .maFile linked to this account." };
    const code = generateSteamGuardCode(ma.sharedSecret);
    return {
      ok: true,
      code,
      secondsLeft: secondsLeftInWindow(),
    };
  });
  ipcMain.handle("sda:export-mafile", async (_e, id: string) => {
    const account = getAccount(id);
    const ma = getMaFile(id);
    if (!account || !ma) return { ok: false, error: "No .maFile to export." };
    const win = getMainWindow();
    const result = await dialog.showSaveDialog(win!, {
      title: "Save .maFile",
      defaultPath: `${account.login}.maFile`,
      filters: [{ name: ".maFile", extensions: ["maFile"] }],
    });
    if (result.canceled || !result.filePath) return { ok: false };
    await writeFile(result.filePath, ma.rawJson, "utf8");
    return { ok: true, path: result.filePath };
  });
  ipcMain.handle("sda:remove", (_e, id: string) => {
    removeMaFile(id);
    return { ok: true };
  });
  ipcMain.handle(
    "sda:enable-two-factor",
    async (_e, accountId: string, options?: SdaStartOptions) => {
      return startSdaRegistration(accountId, options);
    },
  );
  ipcMain.handle("sda:submit-steam-guard", async (_e, sessionId: string, code: string) => {
    return submitSteamGuardCode(sessionId, code);
  });
  ipcMain.handle(
    "sda:submit-phone-number",
    async (_e, sessionId: string, phoneNumber: string, phoneCountryCode?: string) => {
      return submitPhoneNumber(sessionId, phoneNumber, phoneCountryCode);
    },
  );
  ipcMain.handle("sda:check-phone-email", async (_e, sessionId: string) => {
    return checkPhoneEmailConfirmation(sessionId);
  });
  ipcMain.handle("sda:confirm-phone-email", async (_e, sessionId: string, stokenOrLink: string) => {
    return confirmPhoneEmail(sessionId, stokenOrLink);
  });
  ipcMain.handle(
    "sda:finalize-two-factor",
    async (_e, sessionId: string, activationCode: string) => {
      return submitSdaActivationCode(sessionId, activationCode);
    },
  );
  ipcMain.handle("sda:cancel-registration", async (_e, sessionId: string) => {
    return cancelSdaRegistration(sessionId);
  });

  // ---- backup ----
  ipcMain.handle("backup:export", async () => {
    const win = getMainWindow();
    if (!win) return { ok: false };
    const result = await dialog.showSaveDialog(win, {
      title: "Save encrypted backup",
      defaultPath: `d2smurf-backup-${new Date().toISOString().slice(0, 10)}.db`,
      filters: [{ name: "SQLCipher backup", extensions: ["db"] }],
    });
    if (result.canceled || !result.filePath) return { ok: false };
    const userData = app.getPath("userData");
    const src = join(userData, "vault.db");
    await mkdir(join(result.filePath, "..").replace(/[\\/][^\\/]+$/, ""), { recursive: true }).catch(
      () => undefined,
    );
    const buf = await readFile(src);
    await writeFile(result.filePath, buf);
    return { ok: true, path: result.filePath };
  });
}

export { broadcast };
