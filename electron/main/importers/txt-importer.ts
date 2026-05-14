import type { ImportTxtParsed } from "@shared/types";

/**
 * Parse a `.txt` accounts file. Accepts lines in any of these formats:
 *   login:password
 *   login:password:email
 *   login:password:email:emailPassword
 *   login;password
 *   login,password
 *   login password
 *
 * Lines starting with `#` or empty lines are ignored.
 * Returns the list of parsed entries plus any line-level errors.
 */
export function parseAccountsTxt(content: string): {
  entries: ImportTxtParsed[];
  errors: string[];
} {
  const entries: ImportTxtParsed[] = [];
  const errors: string[] = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    let parts: string[];
    if (trimmed.includes(":")) parts = trimmed.split(":");
    else if (trimmed.includes(";")) parts = trimmed.split(";");
    else if (trimmed.includes(",")) parts = trimmed.split(",");
    else parts = trimmed.split(/\s+/);
    parts = parts.map((p) => p.trim());
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      errors.push(`Line ${idx + 1}: cannot parse "${trimmed}"`);
      return;
    }
    const [login, password, email, emailPassword] = parts;
    entries.push({
      login,
      password,
      email: email || undefined,
      emailPassword: emailPassword || undefined,
    });
  });
  return { entries, errors };
}
