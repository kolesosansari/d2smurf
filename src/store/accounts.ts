import { create } from "zustand";
import { api } from "@/lib/api";
import type { AccountInput, AccountRow, AccountUpdate } from "@/lib/api";

interface AccountsState {
  accounts: AccountRow[];
  loading: boolean;
  error: string | null;
  search: string;
  tagFilter: string | null;
  sortKey: "manual" | "mmr" | "behavior" | "comm" | "login" | "lastCheck";
  load: () => Promise<void>;
  create: (input: AccountInput) => Promise<AccountRow>;
  update: (id: string, patch: AccountUpdate) => Promise<AccountRow>;
  remove: (id: string) => Promise<void>;
  reorder: (ids: string[]) => Promise<void>;
  checkOne: (id: string) => Promise<void>;
  checkAll: () => Promise<void>;
  setSearch: (s: string) => void;
  setTagFilter: (tag: string | null) => void;
  setSortKey: (sort: AccountsState["sortKey"]) => void;
}

export const useAccounts = create<AccountsState>((set, get) => ({
  accounts: [],
  loading: false,
  error: null,
  search: "",
  tagFilter: null,
  sortKey: "manual",
  async load() {
    set({ loading: true, error: null });
    try {
      const list = await api.accounts.list();
      set({ accounts: list, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },
  async create(input) {
    const created = await api.accounts.create(input);
    set((s) => ({ accounts: [...s.accounts, created] }));
    return created;
  },
  async update(id, patch) {
    const updated = await api.accounts.update(id, patch);
    set((s) => ({
      accounts: s.accounts.map((a) => (a.id === id ? updated : a)),
    }));
    return updated;
  },
  async remove(id) {
    await api.accounts.delete(id);
    set((s) => ({ accounts: s.accounts.filter((a) => a.id !== id) }));
  },
  async reorder(ids) {
    await api.accounts.reorder(ids);
    const map = new Map(get().accounts.map((a) => [a.id, a]));
    set({
      accounts: ids
        .map((id, idx) => {
          const acc = map.get(id);
          return acc ? { ...acc, sortOrder: idx + 1 } : null;
        })
        .filter((a): a is AccountRow => a !== null),
    });
  },
  async checkOne(id) {
    const result = await api.accounts.checkOne(id);
    if (result.ok && result.account) {
      const updated = result.account;
      set((s) => ({
        accounts: s.accounts.map((a) => (a.id === id ? updated : a)),
      }));
    }
  },
  async checkAll() {
    await api.accounts.bulkCheck();
    // The main process emits events; for now poll after a short delay.
    setTimeout(() => {
      void get().load();
    }, 1500);
  },
  setSearch(s) {
    set({ search: s });
  },
  setTagFilter(tag) {
    set({ tagFilter: tag });
  },
  setSortKey(sort) {
    set({ sortKey: sort });
  },
}));
