/**
 * Tests for the past-audits list's label rule (ticket 04, ADR-0002 spec
 * decision 2): `(manual)` only for the bootstrap audit (`scheduled_at`
 * NULL); every other audit shows its scheduled date instead of the old
 * `(scheduled)` word.
 */
import { describe, expect, it } from "vitest";
import { pastAuditLabel } from "./auditLabels";

describe("pastAuditLabel", () => {
  it("labels only the bootstrap audit — scheduled_at NULL — as (manual)", () => {
    expect(pastAuditLabel(null, () => "never read")).toBe(" (manual)");
  });

  it("shows every other audit's scheduled date instead of the (scheduled) label", () => {
    expect(pastAuditLabel("2026-03-01T12:00:00.000Z", () => "Mar 1, 2026")).toBe(
      " — scheduled Mar 1, 2026"
    );
  });

  it("never renders the old (scheduled) word", () => {
    const label = pastAuditLabel("2026-03-01T12:00:00.000Z", (iso) => iso);
    expect(label).not.toContain("(scheduled)");
  });
});
