import cron from "node-cron";
import { listAccounts } from "../database/accounts.repo";
import { refreshAccountPublic } from "../steam/checker";
import { getSettings } from "../database/settings.repo";
import { isUnlocked } from "../vault/vault";

let task: cron.ScheduledTask | null = null;
let running = false;

export interface AutoCheckEvent {
  type: "start" | "progress" | "finish";
  total?: number;
  done?: number;
  login?: string;
}

type Listener = (event: AutoCheckEvent) => void;
const listeners = new Set<Listener>();

function emit(event: AutoCheckEvent): void {
  for (const l of listeners) {
    try {
      l(event);
    } catch {
      // ignore listener errors
    }
  }
}

export function onAutoCheckEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function runCheckAll(): Promise<void> {
  if (running) return;
  if (!isUnlocked()) return;
  running = true;
  try {
    const accounts = listAccounts();
    emit({ type: "start", total: accounts.length, done: 0 });
    for (let i = 0; i < accounts.length; i += 1) {
      const account = accounts[i];
      emit({ type: "progress", total: accounts.length, done: i, login: account.login });
      try {
        await refreshAccountPublic(account);
      } catch {
        // best effort
      }
    }
    emit({ type: "finish", total: accounts.length, done: accounts.length });
  } finally {
    running = false;
  }
}

export function start(): void {
  stop();
  if (!isUnlocked()) return;
  const settings = getSettings();
  if (!settings.autoCheckEnabled) return;
  const hours = Math.max(1, settings.autoCheckIntervalHours);
  // cron pattern: every N hours at minute 0
  const expr = `0 */${hours} * * *`;
  if (!cron.validate(expr)) return;
  task = cron.schedule(expr, () => {
    void runCheckAll();
  });
}

export function stop(): void {
  if (task) {
    task.stop();
    task = null;
  }
}

export function isRunning(): boolean {
  return running;
}
