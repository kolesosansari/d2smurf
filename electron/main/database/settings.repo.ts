import { getDb } from "./db";
import type { AppSettings } from "@shared/types";

const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark",
  autoCheckEnabled: false,
  autoCheckIntervalHours: 12,
  steamPath: "C:\\Program Files (x86)\\Steam\\steam.exe",
  overplusPath: "C:\\Program Files\\Overplus\\Overplus.exe",
  dotaLaunchOptions: "",
  steamWebApiKey: null,
  stratzApiKey: null,
};

export function getSettings(): AppSettings {
  const db = getDb();
  const rows = db.prepare("SELECT key, value FROM app_settings").all() as Array<{
    key: string;
    value: string;
  }>;
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const merged: AppSettings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(merged) as Array<keyof AppSettings>) {
    const raw = map.get(key);
    if (raw === undefined) continue;
    try {
      const parsed = JSON.parse(raw);
      (merged as unknown as Record<string, unknown>)[key] = parsed;
    } catch {
      (merged as unknown as Record<string, unknown>)[key] = raw;
    }
  }
  return merged;
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const db = getDb();
  const upsert = db.prepare(
    "INSERT INTO app_settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const tx = db.transaction((entries: Array<[string, unknown]>) => {
    for (const [k, v] of entries) {
      upsert.run(k, JSON.stringify(v));
    }
  });
  tx(Object.entries(patch));
  return getSettings();
}

export function getDefaults(): AppSettings {
  return { ...DEFAULT_SETTINGS };
}
