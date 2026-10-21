import type Database from "better-sqlite3";

/**
 * System-assigned serials: "P" + zero-padded id — short, typeable, unique.
 * Allocation is the single source of truth for the next id so ad-hoc intake
 * (parts domain) and PO expected-serial pre-assignment (ticket 08) cannot
 * hand out the same barcode. A claimed id lives in `serial_id_claims` until
 * its serialized_parts row exists (receive consumes the claim and inserts
 * the part); intake inserts the part row directly, which occupies the id.
 */

export const SERIAL_PREFIX = "P";
export const SERIAL_PAD = 5;

export function formatSerial(id: number): string {
  return `${SERIAL_PREFIX}${String(id).padStart(SERIAL_PAD, "0")}`;
}

export function normalizeSerial(raw: string | string[]): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return String(value).trim().toUpperCase();
}

/**
 * Next free part id, considering both existing parts and outstanding PO
 * serial claims. Callers that need durable uniqueness must claim (or
 * insert a part) inside the same transaction before releasing the lock.
 */
export function nextPartId(db: Database.Database): number {
  const parts = db
    .prepare("SELECT COALESCE(MAX(id), 0) AS m FROM serialized_parts")
    .get() as { m: number };
  const claims = db
    .prepare("SELECT COALESCE(MAX(id), 0) AS m FROM serial_id_claims")
    .get() as { m: number };
  return Math.max(parts.m, claims.m) + 1;
}

export interface ClaimedSerial {
  id: number;
  serial: string;
}

/**
 * Reserve the next `count` serial ids without creating inventory rows.
 * Inserts `serial_id_claims` so concurrent intake sees them. Must run
 * inside a write transaction.
 */
export function claimSerialIds(
  db: Database.Database,
  count: number,
  claimedAt: string
): ClaimedSerial[] {
  if (count < 1) {
    return [];
  }
  const insert = db.prepare(
    "INSERT INTO serial_id_claims (id, serial, claimed_at) VALUES (?, ?, ?)"
  );
  const claimed: ClaimedSerial[] = [];
  let next = nextPartId(db);
  for (let i = 0; i < count; i += 1) {
    const id = next;
    const serial = formatSerial(id);
    insert.run(id, serial, claimedAt);
    claimed.push({ id, serial });
    next += 1;
  }
  return claimed;
}

/** Drop a claim once the matching serialized_parts row exists. */
export function releaseSerialClaim(db: Database.Database, id: number): void {
  db.prepare("DELETE FROM serial_id_claims WHERE id = ?").run(id);
}
