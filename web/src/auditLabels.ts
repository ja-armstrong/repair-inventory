/**
 * The past-audits list's label rule (ticket 04, ADR-0002 spec decision 2):
 * the `(manual)` label survives ONLY for the bootstrap audit — the one audit
 * no boundary triggered (`scheduled_at` NULL) — and every other audit shows
 * its scheduled date instead of the old `(scheduled)` word, because the date
 * itself is the information the label used to gesture at.
 */
export function pastAuditLabel(scheduledAt: string | null, formatDate: (iso: string) => string): string {
  return scheduledAt === null ? " (manual)" : ` — scheduled ${formatDate(scheduledAt)}`;
}
