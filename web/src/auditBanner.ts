/**
 * The banner's display logic for the automatic window lifecycle (ticket 04,
 * ADR-0002). The lifecycle has two steady states and the banner speaks only
 * them — the old due/one-week/two-weeks nag ladder is gone, because the open
 * window IS the nag:
 *
 * - open window: names the live audit and the boundary that triggered it;
 * - gap (after an early close, before the next scheduled open): counts down
 *   to the next scheduled open.
 *
 * On a system with no audits yet (the bootstrap state) there is no cadence to
 * nag about, so the banner stays silent — the Counting page is where a
 * manager opens the first window.
 */

/** The shape `GET /api/audits/status` returns (server behavior untouched by ticket 04). */
export interface AuditStatusPayload {
  intervalMonths: number;
  lastAuditAt: string | null;
  /**
   * The boundary the last audit was triggered by — its `scheduled_at` — or
   * NULL when no boundary triggered it, which is only ever the bootstrap
   * audit.
   */
  lastScheduledAt: string | null;
  nextAuditAt: string | null;
  openAuditId: number | null;
}

export type BannerState =
  | { kind: "open"; auditId: number; boundaryAt: string | null }
  | { kind: "gap"; nextOpenAt: string }
  | { kind: "bootstrap" };

export function bannerState(status: AuditStatusPayload): BannerState {
  if (status.openAuditId !== null) {
    // Lifecycle invariant (audits/lifecycle.ts): an open window is always the
    // newest audit — the boundary transition closes the open window before it
    // opens the successor, in one transaction, and the bootstrap open is the
    // first audit — so `lastScheduledAt` IS the open window's own boundary
    // (NULL only when the open window is the bootstrap audit).
    return { kind: "open", auditId: status.openAuditId, boundaryAt: status.lastScheduledAt };
  }
  if (status.nextAuditAt !== null) {
    // No window open but a schedule exists: the quiet gap after an early
    // close. The lazy boundary processor runs before every status request, so
    // a boundary that had already passed would have opened a window first —
    // `nextAuditAt` is strictly in the server's future here.
    return { kind: "gap", nextOpenAt: status.nextAuditAt };
  }
  return { kind: "bootstrap" };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The banner line for a state, or NULL for silence. `now` is injected so the
 * countdown is a pure function of the payload.
 */
export function bannerMessage(state: BannerState, now: Date): string | null {
  switch (state.kind) {
    case "open":
      return state.boundaryAt === null
        ? `Audit #${state.auditId} is open — the first window, opened by hand. Parts are being counted.`
        : `Audit #${state.auditId} is open — the window for the ${new Date(
            state.boundaryAt
          ).toLocaleDateString()} boundary. Parts are being counted.`;
    case "gap": {
      // Math.max clamps only client/server clock skew; the lazy processor
      // guarantees the boundary is still ahead when the payload was built.
      const days = Math.max(
        0,
        Math.ceil((new Date(state.nextOpenAt).getTime() - now.getTime()) / DAY_MS)
      );
      return `No audit window is open — the next one opens on ${new Date(
        state.nextOpenAt
      ).toLocaleDateString()}, in ${days} ${days === 1 ? "day" : "days"}.`;
    }
    case "bootstrap":
      // Deliberate silence: with no audits there is no cadence to nag about.
      return null;
  }
}
