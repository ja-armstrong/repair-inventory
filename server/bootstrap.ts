import type { Express } from "express";
import type { AppContext, Domain } from "./domain.js";
import { healthDomain } from "./domains/health/index.js";
import { authDomain } from "./domains/auth/index.js";
import { batchesDomain } from "./domains/batches/index.js";
import { partsDomain } from "./domains/parts/index.js";
import { purchaseOrdersDomain } from "./domains/purchaseorders/index.js";
import { rmaDomain } from "./domains/rma/index.js";
import { buybacksDomain } from "./domains/buybacks/index.js";
import { returnsDomain } from "./domains/returns/index.js";
import { batchPartsDomain } from "./domains/batchparts/index.js";
import { auditsDomain } from "./domains/audits/index.js";
import { searchDomain } from "./domains/search/index.js";
import { reportsDomain } from "./domains/reports/index.js";
import { adminDomain } from "./domains/admin/index.js";

/**
 * The explicit domain registry. Each domain lives in its own folder under
 * `server/domains/<name>/` and is registered here by name. Later tickets
 * append their domain to this list — that one-line addition is the only
 * accepted shared-file touch. No filesystem scanning on purpose: an explicit
 * list is boring, greppable, and keeps route order deterministic.
 */
export const domains: ReadonlyArray<Domain> = [
  // Admin first (ticket 18): its /api/admin prefix must be matched BEFORE the
  // auth domain's /api router, whose requireSession middleware runs on every
  // /api/* path — main-app sessions must never even reach the admin gate. The
  // admin domain deliberately does NOT use getApiRouter.
  adminDomain, // /api/admin — the owner's separate surface: settings, backups, danger zone (ticket 18)
  healthDomain, // GET /health — intentionally unauthenticated; the only exception
  authDomain, // /api — sessions, users, roles; mounts the session-gated /api router later domains reuse
  batchesDomain, // /api/batches — batches, device rows, models, and the batch timeline
  partsDomain, // /api/skus, /api/parts — the catalog, serialized stock, price expiry (ticket 03)
  purchaseOrdersDomain, // /api/purchase-orders — PO create, approve, track, demand prompt (ticket 07)
  rmaDomain, // /api/rma-orders, /api/rma-parts, /api/rma-credits — RMA lifecycle and settlement (ticket 09)
  buybacksDomain, // /api/buyback-orders, /api/buyback-parts — the buyback sell-back flow (ticket 27)
  returnsDomain, // /api/return-orders — return orders: Available parts shipped back, revenue booked at completion (ticket 29)
  batchPartsDomain, // /api/batches/…/parts, /api/demand, /api/parts/:serial/attachments — reservations, swaps, demand (ticket 05)
  auditsDomain, // /api/audits, /api/cycle-counts — audit windows, due-ness, scan-wins, cycle counts (ticket 10)
  searchDomain, // /api/search — one read-only box over SKUs, serials, device identifiers, and batch/PO/RMA numbers (ticket 11)
  reportsDomain, // /api/reports — the five manager CSV downloads over date ranges (ticket 12)
];

export function registerDomains(app: Express, ctx: AppContext): void {
  for (const domain of domains) {
    domain.register(app, ctx);
  }
}
