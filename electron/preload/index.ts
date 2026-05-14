import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type {
  AccountInput,
  AccountRow,
  AccountUpdate,
  AppSettings,
  ImportResult,
  VaultStatus,
  VaultUnlockResult,
} from "../shared/types";

const api = {
  vault: {
    status: (): Promise<VaultStatus> => ipcRenderer.invoke("vault:status"),
    initialize: (password: string): Promise<VaultUnlockResult> =>
      ipcRenderer.invoke("vault:initialize", password),
    unlock: (password: string): Promise<VaultUnlockResult> =>
      ipcRenderer.invoke("vault:unlock", password),
    lock: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("vault:lock"),
  },
  accounts: {
    list: (): Promise<AccountRow[]> => ipcRenderer.invoke("accounts:list"),
    get: (id: string): Promise<AccountRow | null> => ipcRenderer.invoke("accounts:get", id),
    create: (input: AccountInput): Promise<AccountRow> =>
      ipcRenderer.invoke("accounts:create", input),
    update: (id: string, patch: AccountUpdate): Promise<AccountRow> =>
      ipcRenderer.invoke("accounts:update", id, patch),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke("accounts:delete", id),
    reorder: (ids: string[]): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("accounts:reorder", ids),
    checkOne: (id: string): Promise<{ ok: boolean; account?: AccountRow; error?: string }> =>
      ipcRenderer.invoke("accounts:check-one", id),
    bulkCheck: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("accounts:bulk-check"),
    deepCheck: (
      id: string,
    ): Promise<{ ok: boolean; account?: AccountRow; error?: string; steps: string[] }> =>
      ipcRenderer.invoke("accounts:deep-check", id),
  },
  import: {
    txt: (content: string, tags?: string[]): Promise<ImportResult> =>
      ipcRenderer.invoke("import:txt", { content, tags }),
    mafile: (
      content: string,
      accountId?: string,
    ): Promise<{ ok: boolean; accountId?: string; error?: string }> =>
      ipcRenderer.invoke("import:mafile", { content, accountId }),
    mafileFolder: (folderPath: string): Promise<ImportResult> =>
      ipcRenderer.invoke("import:mafile-folder", folderPath),
    pickMaFile: (): Promise<{ ok: boolean; content?: string; filePath?: string }> =>
      ipcRenderer.invoke("dialog:pick-mafile"),
    pickFolder: (): Promise<{ ok: boolean; path?: string }> =>
      ipcRenderer.invoke("dialog:pick-folder"),
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke("settings:get"),
    update: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke("settings:update", patch),
  },
  launcher: {
    startSteam: (id: string): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke("launcher:start-steam", id),
    startWithOverplus: (id: string): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke("launcher:start-with-overplus", id),
  },
  sda: {
    generateCode: (
      id: string,
    ): Promise<{ ok: boolean; code?: string; secondsLeft?: number; error?: string }> =>
      ipcRenderer.invoke("sda:generate-code", id),
    exportMaFile: (id: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke("sda:export-mafile", id),
    remove: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("sda:remove", id),
  },
  backup: {
    export: (): Promise<{ ok: boolean; path?: string }> => ipcRenderer.invoke("backup:export"),
  },
  events: {
    on: <T = unknown>(channel: string, listener: (payload: T) => void): (() => void) => {
      const wrapped = (_event: IpcRendererEvent, payload: T) => listener(payload);
      ipcRenderer.on(channel, wrapped);
      return () => ipcRenderer.removeListener(channel, wrapped);
    },
  },
};

contextBridge.exposeInMainWorld("d2", api);

export type Api = typeof api;
