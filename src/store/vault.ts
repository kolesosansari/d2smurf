import { create } from "zustand";
import { api } from "@/lib/api";

interface VaultState {
  isInitialized: boolean;
  isUnlocked: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  initialize: (password: string) => Promise<boolean>;
  unlock: (password: string) => Promise<boolean>;
  lock: () => Promise<void>;
}

export const useVault = create<VaultState>((set) => ({
  isInitialized: false,
  isUnlocked: false,
  loading: false,
  error: null,
  async refresh() {
    const status = await api.vault.status();
    set({
      isInitialized: status.isInitialized,
      isUnlocked: status.isUnlocked,
    });
  },
  async initialize(password) {
    set({ loading: true, error: null });
    const result = await api.vault.initialize(password);
    set({
      loading: false,
      error: result.ok ? null : (result.error ?? "Unknown error"),
      isInitialized: result.ok ? true : false,
      isUnlocked: result.ok,
    });
    return result.ok;
  },
  async unlock(password) {
    set({ loading: true, error: null });
    const result = await api.vault.unlock(password);
    set({
      loading: false,
      error: result.ok ? null : (result.error ?? "Unknown error"),
      isUnlocked: result.ok,
    });
    return result.ok;
  },
  async lock() {
    await api.vault.lock();
    set({ isUnlocked: false });
  },
}));
