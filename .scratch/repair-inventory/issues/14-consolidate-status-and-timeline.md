# 14: Consolidate the part-status and timeline seams

**What to build:** The two consolidations the architecture review ranked do-now, closing the code review's holes:

(a) **One part-status module**: the status labels, the guarded transition rules (which transitions are legal from where; "Reserved only through a batch"; "a part attached to an in-transit RMA order cannot flip via the bare status endpoint"; an explicit rule for what audit close does to a Reserved part's active attachment), and `part.status_changed` event recording — every writer routes through it. Today: five write sites, three guard disciplines, two real holes — (1) an RMA-attached part can be flipped to Available via the bare endpoint while RMA complete later forces it Unavailable; (2) an audit-failed Reserved part becomes Unavailable while its device attachment stays active, so the next swap fails with a misleading race message.

(b) **One timeline read module + one event shape**: batches/POs emit `actor: {id, email}` while parts/RMA/audits emit `actor: "<email>"` — unify to one shape, one serializer, one note-endpoint factory; the client's bespoke renderers collapse into one.

Also fold in where the new modules absorb them: the four copies of `PART_STATUS_LABELS` (with their `?? status` silent fallbacks), and the `normalizeSerial`/`parseId`/`badRequest` copies the consolidated modules naturally own.

This is a refactor with the suite kept green throughout; the only behavior changes are the closed holes, and those get their tests written first.

**Blocked by:** 06 (batch lifecycle lands first — its approval gating is a new part-status consumer).

**Status:** ready-for-human

- [x] Single part-status transition module; every write site routes through it; both holes closed with tests written first (RMA-attached part refused on the bare endpoint; audit-failed Reserved part settles its attachment explicitly)
- [x] Single timeline read module and one actor shape across all domains; note endpoints share one factory; the client renders one shape
- [x] Full suite green after the refactor (existing tests updated, not weakened); typecheck and build green
- [x] The diff shows no behavior change beyond the closed holes

## Comments

- New `server/domains/parts/status.ts` owns the part-status seam: `PartStatus`, `PART_STATUS_LABELS`, `partStatusLabel` (loud on unknown — replaces every `?? status` fallback), the guarded primitives `reservePart` / `movePartFromReserved` (moved from batchparts/queries.ts), `openInTransitRmaOrder`, and `changePartStatus(db, clock, actor, {partId, to, note, via, expectedFrom?, payload?})` — guarded, rule-checked, event-recording, transaction-composable (own transaction; nests via savepoints).
- New `server/domains/auth/timeline.ts` owns the timeline read seam: `timelineEvents(db, where, params)` / `timelineFor(db, entityType, entityId)`, `serializeTimelineEvent` (ONE shape: `actor: {id, email} | null` + `entityType`/`entityId`), and `registerNotesRoute` — the single POST /:id/notes used by batches, POs, and RMA orders (per-domain existence checks and messages are options; batches' malformed-id-404 behavior preserved).
- Hole 1: the bare `POST /api/parts/:serial/status` now refuses (409) a part attached to an in-transit RMA order — `"<serial> is attached to in-transit RMA order #N — completing that order settles its status; it cannot be changed here"`. RMA complete still settles every part to Unavailable, now via `changePartStatus` guarded on `expectedFrom: "rma"` (throws loud on inconsistency, rolls the order back).
- Hole 2: audit close settles a Reserved part's attachment explicitly. `settleAttachmentForAuditFailure` (batchparts — the device_parts owner) closes the active attachment via `closeAttachment` with the truthful record (`removed_to: 'unavailable'`, `removal_reason: 'audit'`, note = the failure note) and records `device.part_settled` {attachmentId, serial, sku, auditId, reason: "audit_failed"}; the status flip then goes through `changePartStatus` (guarded). A Reserved part with no active attachment has nothing to settle (tests force-state directly).
- Migration 0012 (unavoidable): SQLite CHECKs cannot be altered, and writing an audit settlement under the old `removed_to`/`removal_reason` values would falsify the immutable removal record. 0012 rebuilds `device_parts` with `removed_to` extended by 'unavailable' and `removal_reason` by 'audit'. Portable SQL; data copied verbatim.
- Write sites routed through the module: parts bare endpoint, batchparts reserve/swap/remove (+ `settleBatchParts` now uses the guarded primitive), RMA complete, audits close, `applyCount` scan-wins. 8 server domain files rewired; 5 read paths + 3 note endpoints collapsed to 1 each; labels ×5 (search's post-review copy included) → 1; web's three bespoke timeline renderers collapsed into `components/Timeline.tsx` (one shape, one `describe`); DeviceParts/PartDetail gained an "Unavailable" removal label for the new truthful settlement value.
- Existing tests updated, not weakened: three actor assertions moved from the email-string shape to the richer object shape (parts ×1, rma ×2 + the rma TimelineEntry type, audits type). All other behavior identical — event payload bytes unchanged everywhere else.
- Surprises: search/domain had a fifth label copy (ticket 11 landed after the review's count of four) — folded in. The audit-failure attachment settlement necessarily drops the settled part from the device's computed Parts Cost (computed from active attachments) — the part is no longer installed, which is the correct ledger.
