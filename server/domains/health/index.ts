import type { Express } from "express";
import type { AppContext, Domain } from "../../domain.js";

/**
 * The health domain: `GET /health`. Intentionally unauthenticated — it is the
 * liveness probe and the walking skeleton's proof that schema → API works.
 * Every other domain's routes will require a session.
 */
export const healthDomain: Domain = {
  name: "health",
  register(app: Express, ctx: AppContext) {
    app.get("/health", (_req, res) => {
      const row = ctx.db
        .prepare("SELECT COUNT(*) AS migrations FROM migrations")
        .get() as { migrations: number };
      res.json({ status: "ok", migrations: row.migrations });
    });
  },
};
