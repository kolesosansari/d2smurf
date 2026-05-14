import { create } from "zustand";
import { api } from "@/lib/api";
import type { AppSettings } from "@/lib/api";

interface SettingsState {
  settings: AppSettings | null;
  loading: boolean;
  load: () => Promise<void>;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}

export const useSettings = create<SettingsState>((set) => ({
  settings: null,
  loading: false,
  async load() {
    set({ loading: true });
    const settings = await api.settings.get();
    set({ settings, loading: false });
  },
  async update(patch) {
    const settings = await api.settings.update(patch);
    set({ settings });
  },
}));
