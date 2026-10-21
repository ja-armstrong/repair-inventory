import type { Express, Response } from "express";
import type Database from "better-sqlite3";
import type { AppContext, Domain } from "../../domain.js";
import { getApiRouter } from "../auth/index.js";
import { formatCents } from "../parts/prices.js";
import { partStatusLabel } from "../parts/status.js";

/**
 * The search domain (ticket 11): one box over everything, read-only.
 *
 * Match semantics, one rule per entity type (each rule's why):
 * - SKU: case-insensitive SUBSTRING on the name — the catalog's only human
 *   key; a tech rarely remembers a full part name.
 * - Serialized part: EXACT serial, case-insensitive — serials are the
 *   barcode key, and a partial serial is never a scan.
 * - Device: EXACT IMEI / Asset ID / serial number, case-insensitive — an
 *   identifier identifies one device history; partials would drown it.
 *   Loc/Bin (ticket 08) is the exception: SUBSTRING, like SKUs — it is free
 *   text the tech typed, not an identifier, so partial recall is the norm.
 * - Batch / PO / RMA order / Buyback order: EXACT number — "29" and "#29"
 *   both mean #29 (the "#" is the UI's display prefix, not data). The number
 *   spaces are independent, so one bare number can hit several at once.
 *
 * The user filter narrows batches/POs/RMA orders/buyback orders by creator
 * and devices by Assigned Tech ("what did J touch"). It never applies to
 * SKUs or parts: neither carries a creator on its row.
 *
 * Scan-first is a server-side rule, not client guesswork: when the query
 * is an exact serial, the response's `directHit` says so and the client
 * lands on the part's page (spec story 67's scan flow).
 */

const RMA_STATUS_LABELS: Record<string, string> = {
  in_transit: "In-Transit",
  complete: "Complete",
};

// The buyback order lifecycle is the RMA shape (ticket 27) — same labels.
// The return order lifecycle is the RMA shape too (ticket 29).
const BUYBACK_STATUS_LABELS: Record<string, string> = RMA_STATUS_LABELS;
const RETURN_STATUS_LABELS: Record<string, string> = RMA_STATUS_LABELS;

interface SkuRow {
  id: number;
  name: string;
  kind: "serialized" | "consumable";
  price_cents: number;
}

interface PartRow {
  id: number;
  serial: string;
  status: string;
  sku_id: number;
  sku_name: string;
}

interface DeviceRow {
  id: number;
  batch_id: number;
  batch_number: number;
  model_name: string;
  imei: string | null;
  asset_id: string | null;
  serial_number: string | null;
  loc_bin: string | null;
  repair_status: string;
  assigned_tech_id: number;
  assigned_tech_email: string;
}

interface BatchRow {
  id: number;
  number: number;
  created_at: string;
  created_by_email: string;
  device_total: number;
}

interface PoRow {
  id: number;
  number: number;
  status: string;
  created_at: string;
  created_by_email: string;
}

interface RmaRow extends PoRow {
  status: string;
}

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: message });
}

/** The single query param read: arrays and non-strings are refused, never guessed. */
function singleParam(raw: unknown): string | undefined {
  return typeof raw === "string" ? raw : undefined;
}

/**
 * Escapes LIKE wildcards so a query containing % or _ matches literally
 * (an unescaped "10%" would match "10" followed by anything).
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** "29" / "#29" -> 29; anything else -> undefined (numbers never match by text). */
function parseNumberQuery(query: string): number | undefined {
  const bare = query.startsWith("#") ? query.slice(1) : query;
  return /^\d+$/.test(bare) ? Number(bare) : undefined;
}

function searchSkus(db: Database.Database, query: string): SkuRow[] {
  const like = `%${escapeLike(query.toLowerCase())}%`;
  return db
    .prepare(
      `SELECT id, name, kind, price_cents
         FROM skus
        WHERE LOWER(name) LIKE ? ESCAPE '\\'
        ORDER BY LOWER(name), id`
    )
    .all(like) as SkuRow[];
}

function searchParts(db: Database.Database, query: string): PartRow[] {
  return db
    .prepare(
      `SELECT p.id, p.serial, p.status, p.sku_id, s.name AS sku_name
         FROM serialized_parts p
         JOIN skus s ON s.id = p.sku_id
        WHERE LOWER(p.serial) = ?
        ORDER BY p.id`
    )
    .all(query.toLowerCase()) as PartRow[];
}

function searchDevices(db: Database.Database, query: string, userId: number | undefined): DeviceRow[] {
  // Devices narrow by Assigned Tech, not by who typed the row in.
  const filter = userId === undefined ? "" : " AND d.assigned_tech_id = ?";
  // Ticket 08: Loc/Bin matches as a SUBSTRING (the SKU rule), not the
  // identifiers' exact rule — it is free text the tech typed ("Shelf 3 /
  // Bin B"), not an identifier, so partial recall is the norm and an exact
  // match would miss. LIKE is wildcard-escaped like every other substring
  // search here.
  const locBinLike = `%${escapeLike(query.toLowerCase())}%`;
  const params: unknown[] = [
    query.toLowerCase(),
    query.toLowerCase(),
    query.toLowerCase(),
    locBinLike,
  ];
  if (userId !== undefined) {
    params.push(userId);
  }
  return db
    .prepare(
      `SELECT d.id, d.batch_id, b.number AS batch_number, m.name AS model_name,
              d.imei, d.asset_id, d.serial_number, d.loc_bin, d.repair_status,
              d.assigned_tech_id, u.email AS assigned_tech_email
         FROM devices d
         JOIN batches b ON b.id = d.batch_id
         JOIN device_models m ON m.id = d.model_id
         JOIN users u ON u.id = d.assigned_tech_id
        WHERE (LOWER(d.imei) = ? OR LOWER(d.asset_id) = ? OR LOWER(d.serial_number) = ?
               OR (d.loc_bin IS NOT NULL AND LOWER(d.loc_bin) LIKE ? ESCAPE '\\'))
          AND d.removed_at IS NULL${filter}
        ORDER BY b.number DESC, d.id`
    )
    .all(...params) as DeviceRow[];
}

function searchBatches(db: Database.Database, number: number, userId: number | undefined): BatchRow[] {
  // Batches narrow by creator. deviceTotal is derived here, never stored.
  const filter = userId === undefined ? "" : " AND b.created_by = ?";
  const params: unknown[] = [number];
  if (userId !== undefined) {
    params.push(userId);
  }
  return db
    .prepare(
      `SELECT b.id, b.number, b.created_at, u.email AS created_by_email,
              COUNT(d.id) AS device_total
         FROM batches b
         JOIN users u ON u.id = b.created_by
         LEFT JOIN devices d ON d.batch_id = b.id AND d.removed_at IS NULL
        WHERE b.number = ?${filter}
        GROUP BY b.id
        ORDER BY b.number`
    )
    .all(...params) as BatchRow[];
}

function searchPurchaseOrders(db: Database.Database, number: number, userId: number | undefined): PoRow[] {
  const filter = userId === undefined ? "" : " AND po.created_by = ?";
  const params: unknown[] = [number];
  if (userId !== undefined) {
    params.push(userId);
  }
  return db
    .prepare(
      `SELECT po.id, po.number, po.status, po.created_at, u.email AS created_by_email
         FROM purchase_orders po
         JOIN users u ON u.id = po.created_by
        WHERE po.number = ?${filter}
        ORDER BY po.number`
    )
    .all(...params) as PoRow[];
}

function searchRmaOrders(db: Database.Database, number: number, userId: number | undefined): RmaRow[] {
  const filter = userId === undefined ? "" : " AND o.created_by = ?";
  const params: unknown[] = [number];
  if (userId !== undefined) {
    params.push(userId);
  }
  return db
    .prepare(
      `SELECT o.id, o.number, o.status, o.created_at, u.email AS created_by_email
         FROM rma_orders o
         JOIN users u ON u.id = o.created_by
        WHERE o.number = ?${filter}
        ORDER BY o.number`
    )
    .all(...params) as RmaRow[];
}

function searchBuybackOrders(db: Database.Database, number: number, userId: number | undefined): RmaRow[] {
  const filter = userId === undefined ? "" : " AND o.created_by = ?";
  const params: unknown[] = [number];
  if (userId !== undefined) {
    params.push(userId);
  }
  return db
    .prepare(
      `SELECT o.id, o.number, o.status, o.created_at, u.email AS created_by_email
         FROM buyback_orders o
         JOIN users u ON u.id = o.created_by
        WHERE o.number = ?${filter}
        ORDER BY o.number`
    )
    .all(...params) as RmaRow[];
}

/** The return orders (ticket 29) share the RMA/buyback search shape exactly. */
function searchReturnOrders(db: Database.Database, number: number, userId: number | undefined): RmaRow[] {
  const filter = userId === undefined ? "" : " AND o.created_by = ?";
  const params: unknown[] = [number];
  if (userId !== undefined) {
    params.push(userId);
  }
  return db
    .prepare(
      `SELECT o.id, o.number, o.status, o.created_at, u.email AS created_by_email
         FROM return_orders o
         JOIN users u ON u.id = o.created_by
        WHERE o.number = ?${filter}
        ORDER BY o.number`
    )
    .all(...params) as RmaRow[];
}

export const searchDomain: Domain = {
  name: "search",
  register(app: Express, ctx: AppContext): void {
    const api = getApiRouter(app);

    api.get("/search", (req, res) => {
      const query = singleParam(req.query.q)?.trim() ?? "";
      if (query === "") {
        badRequest(res, "a search query is required");
        return;
      }

      // The optional user filter must name a real user — loud failure,
      // never a silently ignored parameter.
      let userId: number | undefined;
      const rawUserId = singleParam(req.query.userId);
      if (rawUserId !== undefined && rawUserId !== "") {
        const parsed = Number(rawUserId);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          badRequest(res, "userId must be a positive integer user id");
          return;
        }
        if (!ctx.db.prepare("SELECT id FROM users WHERE id = ?").get(parsed)) {
          res.status(404).json({ error: "no user with that id" });
          return;
        }
        userId = parsed;
      }

      const parts = searchParts(ctx.db, query);
      const numberQuery = parseNumberQuery(query);

      res.json({
        query,
        userId: userId ?? null,
        // Scan-first: an exact serial match lands the client on the part.
        directHit: parts.length > 0 ? { type: "part", id: parts[0].id, serial: parts[0].serial, skuId: parts[0].sku_id } : null,
        // The results page's filter dropdown: /api/users is manager-only,
        // so the user list the filter needs rides on this response.
        filterUsers: ctx.db.prepare("SELECT id, email FROM users ORDER BY id").all(),
        results: {
          skus: searchSkus(ctx.db, query).map((row) => ({
            id: row.id,
            name: row.name,
            kind: row.kind,
            price: formatCents(row.price_cents),
            priceCents: row.price_cents,
          })),
          parts: parts.map((row) => ({
            id: row.id,
            serial: row.serial,
            status: row.status,
            statusLabel: partStatusLabel(row.status),
            skuId: row.sku_id,
            skuName: row.sku_name,
          })),
          devices: searchDevices(ctx.db, query, userId).map((row) => ({
            id: row.id,
            batchId: row.batch_id,
            batchNumber: row.batch_number,
            model: row.model_name,
            imei: row.imei,
            assetId: row.asset_id,
            serialNumber: row.serial_number,
            // Ticket 08: the location rides along so the results row can
            // tell the tech where the found device sits.
            locBin: row.loc_bin,
            repairStatus: row.repair_status,
            assignedTechId: row.assigned_tech_id,
            assignedTechEmail: row.assigned_tech_email,
          })),
          batches:
            numberQuery === undefined
              ? []
              : searchBatches(ctx.db, numberQuery, userId).map((row) => ({
                  id: row.id,
                  number: row.number,
                  createdAt: row.created_at,
                  createdByEmail: row.created_by_email,
                  deviceTotal: row.device_total,
                })),
          purchaseOrders:
            numberQuery === undefined
              ? []
              : searchPurchaseOrders(ctx.db, numberQuery, userId).map((row) => ({
                  id: row.id,
                  number: row.number,
                  status: row.status,
                  createdAt: row.created_at,
                  createdByEmail: row.created_by_email,
                })),
          rmaOrders:
            numberQuery === undefined
              ? []
              : searchRmaOrders(ctx.db, numberQuery, userId).map((row) => ({
                  id: row.id,
                  number: row.number,
                  status: row.status,
                  statusLabel: RMA_STATUS_LABELS[row.status] ?? row.status,
                  createdAt: row.created_at,
                  createdByEmail: row.created_by_email,
                })),
          buybackOrders:
            numberQuery === undefined
              ? []
              : searchBuybackOrders(ctx.db, numberQuery, userId).map((row) => ({
                  id: row.id,
                  number: row.number,
                  status: row.status,
                  statusLabel: BUYBACK_STATUS_LABELS[row.status] ?? row.status,
                  createdAt: row.created_at,
                  createdByEmail: row.created_by_email,
                })),
          returnOrders:
            numberQuery === undefined
              ? []
              : searchReturnOrders(ctx.db, numberQuery, userId).map((row) => ({
                  id: row.id,
                  number: row.number,
                  status: row.status,
                  statusLabel: RETURN_STATUS_LABELS[row.status] ?? row.status,
                  createdAt: row.created_at,
                  createdByEmail: row.created_by_email,
                })),
        },
      });
    });
  },
};
