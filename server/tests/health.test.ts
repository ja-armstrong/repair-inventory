import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "./harness.js";

// The example test at the project's single test seam. It exists to demonstrate
// the harness pattern every later ticket copies: fresh temp SQLite database,
// migrations applied, in-process HTTP request, assert on response and
// database-visible outcomes. Replace/extend, don't imitate sparingly.
describe("GET /health", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it("responds 200 with ok status and its applied migration count", async () => {
    const response = await harness.request.get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", migrations: expect.any(Number) });
    expect(response.body.migrations).toBeGreaterThan(0);
  });

  it("applied migration 0001 to the throwaway database", () => {
    const rows = harness.db
      .prepare("SELECT name FROM migrations ORDER BY name")
      .all() as Array<{ name: string }>;

    expect(rows.map((row) => row.name)).toContain("0001-migrations-table.sql");
  });

  it("stamps migration application with the injected clock, not wall time", () => {
    const row = harness.db
      .prepare("SELECT applied_at FROM migrations WHERE name = ?")
      .get("0001-migrations-table.sql") as { applied_at: string };

    expect(row.applied_at).toBe(harness.clock.now().toISOString());
  });
});
