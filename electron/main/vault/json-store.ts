import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Minimal synchronous JSON-backed key/value store. Used to persist
 * vault metadata (salt + verifier) outside the encrypted database so
 * the app can check the master password without loading SQLCipher first.
 */
export class JsonStore<T extends Record<string, unknown>> {
  constructor(private readonly path: string) {}

  read(): Partial<T> {
    if (!existsSync(this.path)) return {};
    try {
      const text = readFileSync(this.path, "utf8");
      return JSON.parse(text) as Partial<T>;
    } catch {
      return {};
    }
  }

  write(data: Partial<T>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(data, null, 2), "utf8");
  }

  get<K extends keyof T>(key: K): T[K] | undefined {
    return this.read()[key] as T[K] | undefined;
  }

  set<K extends keyof T>(key: K, value: T[K]): void {
    const current = this.read();
    (current as T)[key] = value;
    this.write(current);
  }

  delete<K extends keyof T>(key: K): void {
    const current = this.read();
    delete current[key];
    this.write(current);
  }
}
