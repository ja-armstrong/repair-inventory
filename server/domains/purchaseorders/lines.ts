import type Database from "better-sqlite3";
import { z } from "zod";
import { parsePriceToCents } from "../parts/prices.js";
import { openDemandExists } from "./demand.js";

/**
 * The ONE per-line validation behind PO creation AND pre-approval line
 * revision (spec: .scratch/po-pre-approval-edits/spec.md): prices parse,
 * SKUs exist, and demand references are open records on Open batches. Both
 * routes call `resolveLines`, so the two wire contracts cannot drift — a
 * line accepted at creation is exactly a line accepted at revision.
 */

export const priceInput = z.union([z.string(), z.number()]);

export const PRICE_MESSAGE =
  "unit price must be a non-negative amount with at most two decimal places";

export const lineSchema = z.object({
  skuId: z.coerce.number().int().positive(),
  quantity: z.coerce.number().int().min(1).max(100000),
  unitPrice: priceInput,
  source: z.string().trim().max(300).optional(),
  // The demand record(s) this line covers: a line may cover SEVERAL open
  // Need to Order records of the same SKU at once (the outstanding-demand
  // list is grouped per SKU with a total quantity — one line orders the
  // lot). The first id rides the line's demand_id column (receipt priority);
  // every id lands in the purchase_order_demand link table, so receipt
  // fulfills them one per received unit.
  demandId: z.coerce.number().int().positive().optional(),
  demandIds: z.array(z.coerce.number().int().positive()).optional(),
});

export type LineInput = z.infer<typeof lineSchema>;

/** A PO line's demand references, in one shape: the singular field and the
 * array field are two spellings of the same concept (the singular rides the
 * line's demand_id column; every id lands in the link table). */
export function demandRefs(line: LineInput): number[] {
  return [
    ...(line.demandIds ?? []),
    ...(line.demandId !== undefined ? [line.demandId] : []),
  ];
}

/** One PO line as recorded on a `po.lines_changed` event: sku name, quantity,
 * resolved unit price, and the line's source. The NEW line set lives on each
 * event; the previous set lives on the prior event in the chain. */
export interface LineSnapshot {
  sku: string;
  quantity: number;
  unitPriceCents: number;
  source: string | null;
}

/** A per-line refusal carries the line's index so the error names the row. */
export class LineError extends Error {}

/**
 * Validate a full line set and resolve each line's unit price to integer
 * cents. Throws LineError on the first offending line. Read-only: callers
 * run it inside their transaction, before any write.
 */
export function resolveLines(
  db: Database.Database,
  lines: LineInput[]
): { pricesCents: number[] } {
  const pricesCents: number[] = [];
  for (const [index, line] of lines.entries()) {
    const cents = parsePriceToCents(line.unitPrice);
    if (cents === null) {
      throw new LineError(`line ${index + 1}: ${PRICE_MESSAGE}`);
    }
    pricesCents.push(cents);

    if (!db.prepare("SELECT 1 FROM skus WHERE id = ?").get(line.skuId)) {
      throw new LineError(`line ${index + 1}: no SKU with id ${line.skuId}`);
    }
    const demandRefsOfLine = demandRefs(line);
    for (const demandId of demandRefsOfLine) {
      if (!openDemandExists(db, demandId)) {
        throw new LineError(
          `line ${index + 1}: no open demand record with id ${demandId} — only open Need to Order records can be marked ordered`,
        );
      }
      const batch = db
        .prepare(
          `SELECT b.id, b.number, b.status
             FROM demand_records r JOIN batches b ON b.id = r.batch_id
            WHERE r.id = ?`,
        )
        .get(demandId) as { id: number; number: number; status: string } | undefined;
      if (!batch || batch.status !== "Open") {
        throw new LineError(
          `line ${index + 1}: demand record ${demandId} belongs to batch #${batch?.number ?? "?"}, ` +
            `which is not approved${batch ? ` (${batch.status})` : ""} — ` +
            `Need to Order records can only be ordered from approved (Open) batches`,
        );
      }
    }
  }
  return { pricesCents };
}
