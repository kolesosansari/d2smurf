import type { Api } from "../../electron/preload";

declare global {
  interface Window {
    d2: Api;
  }
}

export const api: Api = window.d2;

export type {
  AccountInput,
  AccountRow,
  AccountUpdate,
  AppSettings,
  ImportResult,
  ProxyTestResult,
  VaultStatus,
  VaultUnlockResult,
} from "@shared/types";
