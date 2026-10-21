import type Database from "better-sqlite3";

/**
 * App settings: manager-editable key/value rows in `app_settings`
 * (migration 0003), seeded with the spec defaults. Values are stored as
 * TEXT; every current numeric setting is a positive whole number, validated
 * at the route edge. Ticket 10 reads `audit_interval_months` from here
 * without needing its own settings migration.
 *
 * Ticket 19 adds the first TEXT-typed setting (`dymo_printer_name`): a
 * printer's name is words, not a count, so the definition carries a `type`
 * and each accessor enforces its own type loudly — reading a text setting
 * with getSettingInt (or the reverse) is a caller bug and throws.
 */
export type SettingType = "int" | "string";

export interface SettingDefinition {
  /** The stored key, verbatim in API responses. */
  key: string;
  /** Value kind: a whole number (`int`) or trimmed free text (`string`). */
  type: SettingType;
  /** Minimum accepted whole-number value (int settings only). */
  min?: number;
  /** Seeded default (also the fallback if a row is somehow missing). */
  default: string;
  /** Maximum accepted text length (string settings only). */
  maxLength?: number;
}

export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  { key: "price_expiry_days", type: "int", min: 1, default: "90" },
  { key: "audit_interval_months", type: "int", min: 1, default: "2" },
  // PO label stock in sixteenths of an inch (ticket 08): Dymo stock is
  // fractional-inch, so sixteenths keep the whole-number setting contract.
  // Defaults are the current stock 2-5/16" × 4" (37 × 64); the 2" × 1" target
  // stock is 32 × 16.
  { key: "label_width_sixteenths", type: "int", min: 8, default: "37" },
  { key: "label_height_sixteenths", type: "int", min: 8, default: "64" },
  // The DYMO printer choice (ticket 19): the exact printer NAME as DYMO's
  // discovery reports it. Empty means "not chosen yet" — the print UI must
  // treat empty as unset and refuse to print silently to a guess.
  { key: "dymo_printer_name", type: "string", maxLength: 200, default: "" },
];

interface SettingRow {
  id: number;
  key: string;
  value: string;
}

export function getSettingRow(db: Database.Database, key: string): SettingRow | undefined {
  return db.prepare("SELECT id, key, value FROM app_settings WHERE key = ?").get(key) as
    | SettingRow
    | undefined;
}

/** Label stock dimensions as the API speaks them (sixteenths + inches), per ticket 08. */
export interface LabelSize {
  widthSixteenths: number;
  heightSixteenths: number;
  widthIn: number;
  heightIn: number;
}

/**
 * The one reader of the label-size settings (ticket 13: every label sheet —
 * PO and non-PO alike — derives its print CSS from this, never from a
 * hardcoded stock size).
 */
export function getLabelSize(db: Database.Database): LabelSize {
  const widthSixteenths = getSettingInt(db, "label_width_sixteenths");
  const heightSixteenths = getSettingInt(db, "label_height_sixteenths");
  return {
    widthSixteenths,
    heightSixteenths,
    widthIn: widthSixteenths / 16,
    heightIn: heightSixteenths / 16,
  };
}

/** The stored value of a setting, or its default when no row exists. */
export function getSetting(db: Database.Database, key: string): string {
  const row = getSettingRow(db, key);
  if (row) {
    return row.value;
  }
  return SETTING_DEFINITIONS.find((definition) => definition.key === key)?.default ?? "";
}

/**
 * Integer value of a setting. The seeded default applies ONLY when the row
 * is missing (a database predating the seed). A row holding an unparsable
 * or below-minimum value is a broken database and fails loudly here
 * (review S3): a silent NaN would quietly disable price expiry
 * (`priceStale` always false) and audit scheduling (NaN month arithmetic).
 * The route edge validates on write, so a bad row means someone edited the
 * database directly — surfacing it beats working around it.
 */
export function getSettingInt(db: Database.Database, key: string): number {
  const definition = SETTING_DEFINITIONS.find((candidate) => candidate.key === key);
  if (!definition) {
    throw new Error(`unknown setting: ${key}`);
  }
  if (definition.type !== "int") {
    throw new Error(`setting "${key}" is a ${definition.type} setting — read it with getSettingStr`);
  }
  const row = getSettingRow(db, key);
  const raw = row ? row.value : definition.default;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < (definition.min ?? 1)) {
    throw new Error(
      `setting "${key}" is stored as ${JSON.stringify(raw)} — expected a whole number of at least ${definition.min}; fix the app_settings row`
    );
  }
  return value;
}

/**
 * Text value of a setting (ticket 19). Same loud rules as getSettingInt,
 * mirrored for text-typed definitions: unknown key or an int-typed key read
 * as text is a caller bug and throws. An empty stored value is a legitimate
 * "not chosen yet" state, returned as-is — the caller decides what unset
 * means, the storage never guesses.
 */
export function getSettingStr(db: Database.Database, key: string): string {
  const definition = SETTING_DEFINITIONS.find((candidate) => candidate.key === key);
  if (!definition) {
    throw new Error(`unknown setting: ${key}`);
  }
  if (definition.type !== "string") {
    throw new Error(`setting "${key}" is an int setting — read it with getSettingInt`);
  }
  const row = getSettingRow(db, key);
  return row ? row.value : definition.default;
}

/** All settings as `{ key: value }`, defaults included — numbers for int settings, strings for text settings. */
export function listSettings(db: Database.Database): Record<string, number | string> {
  const settings: Record<string, number | string> = {};
  for (const definition of SETTING_DEFINITIONS) {
    settings[definition.key] =
      definition.type === "int" ? getSettingInt(db, definition.key) : getSettingStr(db, definition.key);
  }
  return settings;
}

/**
 * The one write-edge validation rule for a setting value, shared by the
 * manager settings route (parts domain) and the admin settings route
 * (ticket 18): an int setting is a whole number of at least `definition.min`;
 * a string setting is free text trimmed to `definition.maxLength` (an empty
 * value clears the choice). Returns the validated value or the exact reason
 * it was refused — callers answer 400 with that message verbatim, never a
 * silent coercion.
 */
export function validateSettingValue(
  definition: SettingDefinition,
  raw: string | number
): { value: number | string } | { error: string } {
  if (definition.type === "string") {
    const text = String(raw).trim();
    if (text.length > (definition.maxLength ?? 200)) {
      return { error: `${definition.key} must be at most ${definition.maxLength} characters` };
    }
    return { value: text };
  }
  const numeric = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(numeric) || numeric < (definition.min ?? 1)) {
    return { error: `${definition.key} must be a whole number of at least ${definition.min}` };
  }
  return { value: numeric };
}
