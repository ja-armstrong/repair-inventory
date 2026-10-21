/**
 * Tests for the banner's display logic under the automatic window lifecycle
 * (ticket 04, ADR-0002). The contract: exactly two steady states — the open
 * window naming itself and its boundary, and the gap countdown to the next
 * scheduled open — plus deliberate silence in the bootstrap state. The old
 * due/one-week/two-weeks ladder must not exist anywhere in the derivation.
 */
import { describe, expect, it } from "vitest";
import { bannerMessage, bannerState, type AuditStatusPayload } from "./auditBanner";

function status(overrides: Partial<AuditStatusPayload>): AuditStatusPayload {
  return {
    intervalMonths: 2,
    lastAuditAt: "2026-03-01T12:00:00.000Z",
    lastScheduledAt: "2026-03-01T12:00:00.000Z",
    nextAuditAt: "2026-05-01T12:00:00.000Z",
    openAuditId: null,
    ...overrides,
  };
}

/** The message for a status, at a fixed "now" — the countdown's pure input. */
function message(payload: AuditStatusPayload, now: Date): string | null {
  return bannerMessage(bannerState(payload), now);
}

describe("bannerState — the two steady states", () => {
  it("maps an open window to the open state, with the last audit's boundary as its own", () => {
    // Lifecycle invariant: an open window is always the newest audit, so
    // `lastScheduledAt` IS the open window's boundary.
    const state = bannerState(status({ openAuditId: 7 }));
    expect(state).toEqual({
      kind: "open",
      auditId: 7,
      boundaryAt: "2026-03-01T12:00:00.000Z",
    });
  });

  it("maps the open bootstrap window to the open state with NO boundary", () => {
    // The bootstrap audit is the only audit and no boundary triggered it.
    const state = bannerState(status({ openAuditId: 1, lastScheduledAt: null }));
    expect(state).toEqual({ kind: "open", auditId: 1, boundaryAt: null });
  });

  it("maps no-open-window + a schedule to the gap state", () => {
    const state = bannerState(status({}));
    expect(state).toEqual({ kind: "gap", nextOpenAt: "2026-05-01T12:00:00.000Z" });
  });

  it("maps no audits at all (bootstrap state) to silence", () => {
    const state = bannerState(
      status({ lastAuditAt: null, lastScheduledAt: null, nextAuditAt: null })
    );
    expect(state).toEqual({ kind: "bootstrap" });
    expect(bannerMessage(state, new Date("2026-10-05T12:00:00.000Z"))).toBeNull();
  });

  it("prefers the open window over the gap even when a next boundary exists", () => {
    // While a window is open, the next boundary is its auto-close date — the
    // banner must speak the open window, not count down past it.
    const state = bannerState(status({ openAuditId: 7 }));
    expect(state.kind).toBe("open");
  });
});

describe("bannerMessage — open window", () => {
  const now = new Date("2026-10-05T12:00:00.000Z");

  it("names the live audit and its boundary", () => {
    const text = message(status({ openAuditId: 7 }), now);
    expect(text).toContain("Audit #7 is open");
    expect(text).toContain("boundary");
    expect(text).toContain("Parts are being counted.");
  });

  it("says the bootstrap window was opened by hand instead of inventing a boundary", () => {
    const text = message(status({ openAuditId: 1, lastScheduledAt: null }), now);
    // The full sentence pinned: no boundary exists, so no date may appear in it.
    expect(text).toBe(
      "Audit #1 is open — the first window, opened by hand. Parts are being counted."
    );
  });
});

describe("bannerMessage — gap countdown", () => {
  it("counts down the whole days to the next scheduled open", () => {
    const now = new Date("2026-10-05T12:00:00.000Z");
    const text = message(status({ nextAuditAt: "2026-10-18T12:00:00.000Z" }), now);
    expect(text).toContain("No audit window is open");
    expect(text).toContain("the next one opens on");
    expect(text).toContain("in 13 days");
  });

  it("uses the singular for one day out", () => {
    const text = message(
      status({ nextAuditAt: "2026-10-06T12:00:00.000Z" }),
      new Date("2026-10-05T12:00:00.000Z")
    );
    expect(text).toContain("in 1 day");
    expect(text).not.toContain("in 1 days");
  });

  it("rounds a partial day UP to the next whole day", () => {
    // 25 hours out is "in 2 days" — the countdown never says 1 while a full
    // day remains.
    const text = message(
      status({ nextAuditAt: "2026-10-06T13:00:00.000Z" }),
      new Date("2026-10-05T12:00:00.000Z")
    );
    expect(text).toContain("in 2 days");
  });

  it("still shows the countdown far from the boundary — the old ladder's silence is gone", () => {
    // The pre-lifecycle ladder rendered nothing beyond two weeks out; under
    // the new lifecycle the gap state always speaks.
    const text = message(
      status({ nextAuditAt: "2027-01-03T12:00:00.000Z" }),
      new Date("2026-10-05T12:00:00.000Z")
    );
    expect(text).toContain("in 90 days");
  });
});

describe("the old nag ladder renders nowhere", () => {
  it("has no ladder stage in the state vocabulary", () => {
    // Exhaustiveness guard: the state kinds are exactly the two steady
    // states plus the bootstrap silence — "due", "one-week", and "two-weeks"
    // are not representable.
    const kinds = new Set(
      [
        bannerState(status({})),
        bannerState(status({ openAuditId: 7 })),
        bannerState(status({ lastAuditAt: null, lastScheduledAt: null, nextAuditAt: null })),
      ].map((state) => state.kind)
    );
    expect([...kinds].sort()).toEqual(["bootstrap", "gap", "open"]);
  });

  it("maps what used to be 'due' (boundary at/inside now, no window open) to the gap countdown", () => {
    // A boundary at or inside `now` cannot survive a status request — the
    // lazy processor opens the window first — so the closest reachable
    // "about to open" state is still the gap countdown.
    const text = message(
      status({ nextAuditAt: "2026-10-06T00:00:00.000Z" }),
      new Date("2026-10-05T12:00:00.000Z")
    );
    expect(text).toContain("No audit window is open");
    expect(text).not.toContain("due");
    expect(text).not.toContain("week");
  });
});
