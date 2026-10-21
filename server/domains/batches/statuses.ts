/**
 * The Repair Status vocabulary (CONTEXT.md) and the server-enforced
 * transition graph. Every status change is validated against this graph —
 * the client can offer whatever buttons it likes, the server is the arbiter.
 */

export const REPAIR_STATUSES = [
  "Awaiting repair",
  "In progress",
  "QA",
  "Parts needed",
  "Repaired",
  "Unrepairable",
  "Additional issues present",
  "Denied Repair",
] as const;

export type RepairStatus = (typeof REPAIR_STATUSES)[number];

/**
 * A device's run on its batch ENDS here — the statuses that make a batch
 * closeable (closeBatch's guard) and that freeze its parts (batchparts'
 * terminalResponse). "Terminal" is about the run being over, NOT about
 * being uncorrectable: every terminal status has graph exits, because a
 * terminal status can be set BY ACCIDENT (a wrong click on the device grid)
 * and there must be a way to fix it (any user, through the same status
 * endpoint — the exit is a graph edge like any other, and the
 * device.status_changed event records from → to).
 *
 * What an exit does NOT do is undo the terminal status's side effects:
 * - leaving "Additional issues present" does NOT undo the retriage — the
 *   continuation row (with the moved parts) still exists on the new batch;
 *   the correction removes that accidental device through the normal
 *   device-removal flow (its parts return to stock there);
 * - leaving "Denied Repair" does NOT re-reserve the parts returned to stock
 *   at the denial — they are re-added through the normal part flow.
 * The timeline tells the whole story; nothing is silently reversed.
 *
 * "Denied Repair" is still reachable ONLY through the manager's per-device
 * rejection at batch approval (approveBatch writes it directly: the
 * rejection IS the approval flow, and this module is the one owner of the
 * repair_status column) — no entry in ALLOWED_TRANSITIONS targets it.
 */
export const TERMINAL_STATUSES: ReadonlySet<RepairStatus> = new Set([
  "Repaired",
  "Unrepairable",
  "Additional issues present",
  "Denied Repair",
]);

/**
 * The allowed graph. The main line is
 * Awaiting repair → In progress → QA → Repaired / Unrepairable.
 * Additional rules:
 * - Parts needed is the blocked-on-demand status: reachable from any active
 *   work status (ticket 05 will auto-set it when a part is short). Its exits
 *   are In progress (the demand was fulfilled, work resumes) and — ticket 30
 *   — Awaiting repair, the UNBLOCK exit for a cancelled demand: the device
 *   never started, and "Parts needed" must not become a trap. The lifecycle
 *   refuses the unblock while an open demand remains.
 * - Additional issues present is reachable once real work has happened
 *   (In progress or QA) — never straight from Awaiting repair, so nothing
 *   skips into a terminal status "from nothing".
 * - NO status is a trap: every terminal status carries exits back to where
 *   work actually happens, so an accidental set can be corrected. The exits
 *   return to the statuses the device could only have come from (Denied
 *   Repair is pre-work, so it returns to Awaiting repair); see
 *   TERMINAL_STATUSES for what an exit does and does not undo.
 * - Putting a phone DOWN is not a trap either: a tech who picked a device
 *   up (In progress) — or even recorded it Repaired in error — can set it
 *   back to Awaiting repair, the shelf. Its parts stay attached and
 *   Reserved either way; only the work state rewinds.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<RepairStatus, readonly RepairStatus[]>> = {
  "Awaiting repair": ["In progress", "Parts needed"],
  "In progress": ["Awaiting repair", "QA", "Parts needed", "Repaired", "Unrepairable", "Additional issues present"],
  QA: ["In progress", "Parts needed", "Repaired", "Unrepairable", "Additional issues present"],
  "Parts needed": ["In progress", "Awaiting repair"],
  Repaired: ["Awaiting repair", "In progress", "QA"],
  Unrepairable: ["In progress", "QA"],
  "Additional issues present": ["In progress", "QA"],
  // No status reaches Denied Repair through the graph: it is the outcome of
  // a manager's per-device REJECTION at batch approval (batches/lifecycle.ts
  // approveBatch), never a hand-set status. Its exit is the accident
  // correction (back to Awaiting repair), not an entry.
  "Denied Repair": ["Awaiting repair"],
};

/**
 * The batch lifecycle (CONTEXT.md): Awaiting approval → Open → Closed.
 * Unlike the Repair Status graph this is STORED state (migration 0010) —
 * approval is a manager's cost sign-off and closing is an act, neither of
 * which any device status can express — but it is only ever written by the
 * batches domain's own lifecycle functions (batches/lifecycle.ts).
 */
export const BATCH_STATUSES = ["Awaiting approval", "Open", "Closed"] as const;

export type BatchStatus = (typeof BATCH_STATUSES)[number];

/**
 * The ticket-30 UNBLOCK move: a device leaving Parts needed for Awaiting
 * repair (its need was cancelled, it never started). Named once because the
 * exception is encoded twice: the client-facing transition filter and the
 * lifecycle's approval gate must agree it is not repair work.
 */
export function isPartsNeededUnblock(from: RepairStatus, to: RepairStatus): boolean {
  return from === "Parts needed" && to === "Awaiting repair";
}

/**
 * The allowed device transitions FOR A BATCH IN A GIVEN LIFECYCLE STATE —
 * the one function the client's status options come from (serialized onto
 * every device), so the UI can never drift from what the server accepts.
 * WHY approval gates repair and not reservation: before sign-off a tech
 * edits part lists freely (and a part shortage may park a device in
 * "Parts needed"), but real repair work waits for the manager's approval.
 * Blocking AND unblocking on parts are not repair work — pre-approval the
 * graph still admits → Parts needed and the isPartsNeededUnblock exit.
 */
export function allowedTransitionsFrom(
  from: RepairStatus,
  batchStatus: BatchStatus
): readonly RepairStatus[] {
  if (batchStatus === "Closed") {
    return [];
  }
  const base = ALLOWED_TRANSITIONS[from];
  if (batchStatus === "Awaiting approval") {
    return base.filter(
      (to) => to === "Parts needed" || isPartsNeededUnblock(from, to)
    );
  }
  return base;
}

export function isRepairStatus(value: unknown): value is RepairStatus {
  return typeof value === "string" && (REPAIR_STATUSES as readonly string[]).includes(value);
}

/** Why a transition is refused, or null when it is allowed. */
export function transitionError(from: RepairStatus, to: RepairStatus): string | null {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    // A status with no edges is a dead end by vocabulary, not by history —
    // refused with the terminal wording (none exists today: every terminal
    // status carries accident-correction exits).
    return ALLOWED_TRANSITIONS[from].length === 0
      ? `${from} is terminal on this batch — a device cannot leave a terminal Repair Status`
      : `a device cannot move from ${from} to ${to}`;
  }
  return null;
}

/** JSON keys for the derived per-status device counts on a batch. */
export const DEVICE_COUNT_KEYS: Readonly<Record<RepairStatus, string>> = {
  "Awaiting repair": "awaitingRepair",
  "In progress": "inProgress",
  QA: "qa",
  "Parts needed": "partsNeeded",
  Repaired: "repaired",
  "Unrepairable": "unrepairable",
  "Additional issues present": "additionalIssuesPresent",
  "Denied Repair": "deniedRepair",
};

export function emptyDeviceCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const status of REPAIR_STATUSES) {
    counts[DEVICE_COUNT_KEYS[status]] = 0;
  }
  return counts;
}
