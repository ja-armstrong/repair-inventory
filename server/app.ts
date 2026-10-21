import express, { type ErrorRequestHandler, type Express } from "express";
import { registerDomains } from "./bootstrap.js";
import type { AppContext } from "./domain.js";

/**
 * Builds the Express app. Domains register their own routes through the
 * bootstrap; this factory owns only cross-cutting wiring (JSON body parsing,
 * the JSON error handler).
 */
export function createApp(ctx: AppContext): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  registerDomains(app, ctx);

  // Central error handler: a domain route that throws (synchronously or from
  // an async handler — Express 5 forwards rejected promises) always produces
  // a JSON error, never an HTML error page.
  app.use(errorHandler);

  return app;
}

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = typeof err?.status === "number" ? err.status : 500;
  if (status >= 500) {
    console.error(err);
  }
  res.status(status).json({ error: err?.message ?? "internal server error" });
};
