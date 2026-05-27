import type { ImportTxtParsed } from "@shared/types";

type KnownLabel = "login" | "password" | "email";

interface ParsedLabel {
  label: KnownLabel;
  value: string;
  explicit: boolean;
}

function cleanToken(value: string | undefined): string {
  return (value ?? "").trim().replace(/^['"]|['"]$/g, "");
}

function parseLabelLine(line: string): ParsedLabel | null {
  const match = line.match(/^([\p{L}_ -]+)\s*[:：]\s*(.+)$/u);
  if (!match) return null;
  const rawLabel = match[1].trim().toLowerCase();
  const value = cleanToken(match[2]);
  if (!value) return null;

  const explicit = match[1].trim() !== rawLabel;

  if (["login", "log", "account", "steam", "логин", "аккаунт"].includes(rawLabel)) {
    return { label: "login", value, explicit };
  }
  if (["pass", "password", "pwd", "пароль"].includes(rawLabel)) {
    return { label: "password", value, explicit };
  }
  if (["mail", "email", "e-mail", "почта", "мыло"].includes(rawLabel)) {
    return { label: "email", value, explicit };
  }
  return null;
}

function hasNextLabelLine(lines: string[], startIndex: number): boolean {
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed.startsWith("#")) return false;
    return parseLabelLine(trimmed) !== null;
  }
  return false;
}

function parseDelimitedLine(line: string): ImportTxtParsed | null {
  let parts: string[];
  if (line.includes("----")) parts = line.split(/-{3,}/);
  else if (line.includes(":")) parts = line.split(":");
  else if (line.includes(";")) parts = line.split(";");
  else if (line.includes(",")) parts = line.split(",");
  else parts = line.split(/\s+/);

  const [login, password, email, emailPassword] = parts.map(cleanToken);
  if (!login || !password) return null;
  return {
    login,
    password,
    email: email || undefined,
    emailPassword: emailPassword || undefined,
  };
}

function parseLabeledBlock(
  lines: string[],
  startIndex: number,
): { entry?: ImportTxtParsed; error?: string; nextIndex: number } {
  let login = "";
  let password = "";
  let email = "";
  let emailPassword = "";
  let index = startIndex;

  for (; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed.startsWith("#")) break;

    const parsed = parseLabelLine(trimmed);
    if (!parsed) break;

    if (parsed.label === "login") {
      if (login && password) break;
      login = parsed.value;
      continue;
    }

    if (parsed.label === "email") {
      email = parsed.value;
      continue;
    }

    if (parsed.label === "password") {
      if (!password) password = parsed.value;
      else if (email && !emailPassword) emailPassword = parsed.value;
      continue;
    }
  }

  if (!login || !password) {
    return {
      error: `Line ${startIndex + 1}: блок LOGIN/PASS должен содержать логин и пароль`,
      nextIndex: index,
    };
  }
  return {
    entry: {
      login,
      password,
      email: email || undefined,
      emailPassword: emailPassword || undefined,
    },
    nextIndex: index,
  };
}

/**
 * Parse account text from files or FanPay messages. Accepts:
 *   login:password:email:emailPassword
 *   LOGIN: login / PASS: password / MAIL: email / PASS: emailPassword
 *   login----password----email----emailPassword
 *   login password email emailPassword
 *   semicolon/comma-separated variants
 *
 * Lines starting with `#` or empty lines are ignored.
 */
export function parseAccountsTxt(content: string): {
  entries: ImportTxtParsed[];
  errors: string[];
} {
  const entries: ImportTxtParsed[] = [];
  const errors: string[] = [];
  const lines = content.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const label = parseLabelLine(trimmed);
    if (label && (label.explicit || label.label !== "login" || hasNextLabelLine(lines, idx))) {
      const block = parseLabeledBlock(lines, idx);
      if (block.entry) {
        entries.push(block.entry);
        idx = block.nextIndex - 1;
        continue;
      }
      if (block.error) {
        errors.push(block.error);
        idx = block.nextIndex - 1;
        continue;
      }
    }

    const entry = parseDelimitedLine(trimmed);
    if (!entry) {
      errors.push(`Line ${idx + 1}: не удалось распознать "${trimmed}"`);
      continue;
    }
    entries.push(entry);
  }
  return { entries, errors };
}
