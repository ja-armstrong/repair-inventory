# Spec: Demand only from approved batches; select-all + grouped quantities

1. Outstanding Need to Order demand is orderable only from APPROVED (Open)
   batches — a pre-approval batch's demand is an unsigned-off estimate.
2. Outstanding demand displays GROUPED per SKU with a total quantity (not one
   row per record), and a select-all checkbox covers the list.

# Status: IN PROGRESS — code done, two tests + docs remain

## Done (working, verified by typecheck)

- `batchparts/queries.ts listOutstandingDemand`: now `AND b.status = 'Open'`
  (one definition behind `/api/demand` AND `/api/purchase-orders/demand`).
- `purchaseorders/index.ts`: line schema gains `demandIds: number[]`
  (singular `demandId` still accepted); create validates EVERY referenced
  demand (open + its batch must be Open — loud 400 naming the batch);
  line.demand_id = first ref; all refs land in `purchase_order_demand`;
  `/api/purchase-orders/demand` serves the GROUPED shape.
- `purchaseorders/demand.ts`: new `listOutstandingDemandGrouped` (per-SKU:
  quantity = record count, demandIds, batchIds, suppliers; first supplier
  prefills the line source).
- Web `PurchaseOrderCreatePage`: grouped table (SKU / Quantity / Supplier /
  Needed-by batches), select-all checkbox in the header (select-all adds one
  line per group; clicking again clears and removes demand-linked lines),
  lines carry `demandIds`, submit sends them.

## REMAINING (suite is RED: 470/472, failures below)

1. `server/tests/batchparts.test.ts` "is listable per batch and globally
   outstanding" (~line 383): the two batches are never approved, so the
   global `/api/demand` check gets []. FIX: approve batchOne and batchTwo
   (decide each device approved as the harness manager, then
   `POST /api/batches/:id/approve` with a note) after the `addPart` calls,
   before the global assertions.
2. `server/tests/device-removal.test.ts` "cancelled demand cannot be marked
   ordered on a PO" (~line where a PO links a demand): same cause — the
   demand's batch is not approved. FIX: approve that batch in the test
   (or its seed helper) before the PO link.
3. Docs (NOT yet updated): `docs/logic-map.md` — `listOutstandingDemand`'s
   definition ("open + batch Open + unlinked"), the PO demand route row
   (grouped shape), the create route row (demandIds, approved-only);
   `docs/manual.md` — the PO section (approved-only demand, grouped
   quantities, select-all). `docs/data-model.md` unchanged.
4. Then: full `npx vitest run` + both `tsc --noEmit` green, and append the
   completion comment to this file (Status → ready-for-human).
