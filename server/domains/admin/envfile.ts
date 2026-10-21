import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The .env file seam (ticket 22): read, parse, edit, and write the server's
 * `.env` file — the file `server/index.ts` loads with `process.loadEnvFile`
 * at startup. The editor's contract:
 *
 * - **Preservation**: comments, blank lines, and keys outside the catalog are
 *   kept byte-for-byte on every edit — the file belongs to the owner, and the
 *   editor only rewrites the lines of the key being changed.
 * - **Atomic write**: the new content goes to a temp file in the same
 *   directory, then `rename`s over the target. A crash mid-write can leave
 *   the old file or the new one, never a truncated half-file (a truncated
 *   .env silently drops keys — an unacceptable failure for ADMIN_KEY).
 * - **Test seam**: `RMS_ENV_FILE` overrides the file path. It is read at call
 *   time (not import time) so tests can point each request at a throwaway
 *   file; production never sets it and gets `<project root>/.env` — exactly
 *   the file the entrypoint loads.
 *
 * The parser accepts the same line shapes Node's `process.loadEnvFile`
 * accepts (verified against Node 24): `KEY=value`, `export KEY=value`,
 * single-quoted (fully literal), double-quoted (with `\n`-style escapes),
 * `#` comments, blank lines, and multi-line quoted values. Values this
 * editor writes never span lines; a value that cannot be represented in one
 * of the safe quoting forms is REJECTED, not mangled (loud failure per
 * AGENTS.md — a mangled ADMIN_KEY would lock the owner out after restart).
 */

export interface EnvEntry {
  kind: "entry";
  key: string;
  /** The parsed value: quotes resolved, escapes applied, comments stripped. */
  value: string;
  /** The exact raw lines this entry occupies (one, or several when multiline). */
  rawLines: string[];
}

/** A blank line, a comment, or anything this parser does not treat as an entry. */
export interface EnvRawLine {
  kind: "raw";
  line: string;
}

export type EnvLine = EnvEntry | EnvRawLine;

/** The .env file path: `<project root>/.env`, overridable by RMS_ENV_FILE. */
export function envFilePath(): string {
  const override = process.env.RMS_ENV_FILE?.trim();
  if (override) {
    return path.resolve(override);
  }
  // Same file server/index.ts loads: from here (server/domains/admin/) up
  // three levels is the project root.
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env");
}

const ASSIGNMENT = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_]*)(\s*)=(.*)$/;

/** Parses .env text into preserved raw lines plus key entries. */
export function parseEnvLines(text: string): EnvLine[] {
  const lines = text.split("\n");
  const result: EnvLine[] = [];
  let index = 0;
  while (index < lines.length) {
    const match = ASSIGNMENT.exec(lines[index]);
    if (!match) {
      result.push({ kind: "raw", line: lines[index] });
      index += 1;
      continue;
    }
    const key = match[3];
    const valueText = match[5];
    const quote = valueText.trimStart()[0];
    if ((quote === '"' || quote === "'") && !closesOnSameLine(valueText, quote)) {
      // A multi-line quoted value: consume lines until the closing quote.
      const collected = [lines[index]];
      index += 1;
      while (index < lines.length && !lines[index].includes(quote)) {
        collected.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        collected.push(lines[index]);
        index += 1;
      }
      result.push({
        kind: "entry",
        key,
        value: parseQuoted(collected.slice(1).join("\n"), quote),
        rawLines: collected,
      });
      continue;
    }
    result.push({ kind: "entry", key, value: parseSingleLine(valueText), rawLines: [lines[index]] });
    index += 1;
  }
  return result;
}

function closesOnSameLine(valueText: string, quote: '"' | "'"): boolean {
  // The opening quote is the first non-space character; the value closes at
  // the next occurrence of the same quote character.
  return valueText.trimStart().slice(1).includes(quote);
}

/** One-line value: quoted forms are taken between the quotes, else `#` starts a comment. */
function parseSingleLine(valueText: string): string {
  const trimmed = valueText.trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    const raw = end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
    return quote === '"' ? decodeDoubleQuoted(raw) : raw;
  }
  const comment = trimmed.indexOf("#");
  const bare = comment === -1 ? trimmed : trimmed.slice(0, comment);
  return bare.trim();
}

function parseQuoted(text: string, quote: '"' | "'"): string {
  const end = text.indexOf(quote);
  const raw = end === -1 ? text : text.slice(0, end);
  return quote === '"' ? decodeDoubleQuoted(raw) : raw;
}

/**
 * Double-quoted values go through Node's escape decoding (\n, \r, \t, \\,
 * \"). Single-quoted values stay fully literal, so they are returned as-is.
 */
function decodeDoubleQuoted(text: string): string {
  return text
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\")
    .replace(/\\"/g, '"');
}

/** The key → parsed value map of a parsed file. */
export function envValues(lines: EnvLine[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of lines) {
    if (line.kind === "entry") {
      values.set(line.key, line.value);
    }
  }
  return values;
}

/**
 * Renders `KEY=value` in a form Node's parser reads back exactly:
 * unquoted when safe (Node keeps spaces and `$` literally outside quotes and
 * only `#` starts a comment), single-quoted when the value needs protection
 * (single quotes are fully literal — even a backslash), double-quoted when
 * the value itself contains a single quote. A value this cannot represent
 * (a newline, or both quote kinds) throws — it is never mangled into
 * something that parses differently.
 */
export function renderAssignment(key: string, value: string): string {
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error(`the value for ${key} cannot contain a line break`);
  }
  if (value === "") {
    return `${key}=`;
  }
  if (value.includes("'")) {
    if (value.includes('"') || value.includes("\\")) {
      throw new Error(
        `the value for ${key} cannot be stored in the .env file: it contains both a single quote and a double quote or backslash`
      );
    }
    return `${key}="${value}"`;
  }
  const needsQuoting = value.includes("#") || value.includes('"') || value.includes("\\");
  return needsQuoting ? `${key}='${value}'` : `${key}=${value}`;
}

/**
 * Returns the lines with `key` set to `value`: the key's existing lines are
 * replaced in place (its position in the file is kept), or the assignment is
 * appended after a blank line when the key is new. Throws when the value
 * cannot be represented — the caller must not write anything in that case.
 */
export function withEnvValue(lines: EnvLine[], key: string, value: string): EnvLine[] {
  const assignment = renderAssignment(key, value);
  const result: EnvLine[] = [];
  let replaced = false;
  for (const line of lines) {
    if (!replaced && line.kind === "entry" && line.key === key) {
      result.push({ kind: "entry", key, value, rawLines: [assignment] });
      replaced = true;
      continue;
    }
    result.push(line);
  }
  if (!replaced) {
    const last = result[result.length - 1];
    if (result.length > 0 && last.kind === "raw" && last.line.trim() !== "") {
      result.push({ kind: "raw", line: "" });
    }
    result.push({ kind: "entry", key, value, rawLines: [assignment] });
  }
  return result;
}

/** Joins parsed lines back to file text. Comments, blanks, and unknown keys survive untouched. */
export function renderEnvLines(lines: EnvLine[]): string {
  const out: string[] = [];
  for (const line of lines) {
    if (line.kind === "entry") {
      out.push(...line.rawLines);
    } else {
      out.push(line.line);
    }
  }
  return out.join("\n");
}

export interface EnvFileRead {
  path: string;
  exists: boolean;
  lines: EnvLine[];
}

/** Reads and parses the .env file (an absent file parses as empty). */
export function readEnvFile(): EnvFileRead {
  const filePath = envFilePath();
  if (!fs.existsSync(filePath)) {
    return { path: filePath, exists: false, lines: [] };
  }
  return { path: filePath, exists: true, lines: parseEnvLines(fs.readFileSync(filePath, "utf8")) };
}

/**
 * Atomically replaces the .env file: write a unique temp file in the same
 * directory (rename is only atomic within one filesystem), fsync it, then
 * rename over the target. A crash leaves either the old or the new file.
 */
export function writeEnvFile(filePath: string, lines: EnvLine[]): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.env.tmp-${process.pid}-${Date.now()}`);
  const handle = fs.openSync(temp, "w");
  try {
    fs.writeFileSync(handle, renderEnvLines(lines), "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temp, filePath);
}

/**
 * The single source of truth for which .env keys the admin panel manages
 * (ticket 22). Editable keys can be saved through the panel; read-only keys
 * are DISPLAYED with the reason they are refused — DB_PATH especially: a
 * wrong value there does not fail loudly, it makes the server start a new,
 * empty database, so it must never be changeable from a web form.
 */
export interface EnvCatalogEntry {
  key: string;
  description: string;
  editable: boolean;
  /** Secrets are masked in every response — the value never leaves the server. */
  secret: boolean;
  /** For read-only entries: why the editor refuses, and what to do instead. */
  reason?: string;
}

export const ENV_CATALOG: ReadonlyArray<EnvCatalogEntry> = [
  {
    key: "APP_ORIGIN",
    description:
      "Fallback web address used to build login links when the browser did not send an Origin header, e.g. http://localhost.",
    editable: true,
    secret: false,
  },
  {
    key: "RESEND_KEY",
    description:
      "Resend API key. Set: login links are sent as real email. Empty: links are printed in the server console only.",
    editable: true,
    secret: true,
  },
  {
    key: "RESEND_FROM",
    description:
      "Sender address for login-link emails, e.g. RMS <no-reply@example.com>. The domain must be verified in Resend for delivery outside your own address.",
    editable: true,
    secret: false,
  },
  {
    key: "ADMIN_KEY",
    description:
      "The admin panel's key. Empty (after a restart) disables the whole admin panel — every /admin page answers 404. This editor refuses to clear a secret: to disable the panel, edit the .env file directly.",
    editable: true,
    secret: true,
  },
  {
    key: "ALLOWED_EMAIL_DOMAINS",
    description:
      "The email domains accounts may belong to, comma-separated, e.g. @acme.co,@acme.com. Checked at every user creation and login-link request.",
    editable: false,
    secret: false,
    reason:
      "read-only here: a bad value would fail the next startup (the server refuses to run without a valid allowlist). Edit the .env file directly.",
  },
  {
    key: "DB_PATH",
    description: "Where the database file lives. Default: data/repair-inventory.sqlite.",
    editable: false,
    secret: false,
    reason:
      "read-only here: a wrong value would not fail loudly — it makes the server start a new, empty database. Edit the .env file directly.",
  },
  {
    key: "PORT",
    description: "The port the API server listens on. Default: 3000.",
    editable: false,
    secret: false,
    reason:
      "read-only here: the value is read once at startup and the web client is set up to reach this address. Edit the .env file directly.",
  },
];

/**
 * A secret's display form: enough to recognize it, never the whole value.
 * Short values (8 characters or fewer) show nothing at all — revealing the
 * last four of a 6-character secret reveals most of it.
 */
export function maskSecret(value: string | undefined): string {
  if (!value) {
    return "(not set)";
  }
  return value.length > 8 ? `(set ····${value.slice(-4)})` : "(set ····)";
}
