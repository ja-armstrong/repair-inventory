import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// The email-domain allowlist is configured once, in the project-root `.env`
// (ALLOWED_EMAIL_DOMAINS — the same key the API server enforces; see
// .env.example). The web client needs it only for the hint text on email
// forms, so it is read here and baked in as a compile-time constant. A
// missing or empty key fails the dev server / build loudly — the client must
// never render a hint for a domain nobody can log in from.
const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
const allowlist = (process.env.ALLOWED_EMAIL_DOMAINS ?? "")
  .split(",")
  .map((part) => part.trim().replace(/^@+/, "").toLowerCase())
  .filter(Boolean);
if (allowlist.length === 0) {
  throw new Error(
    "ALLOWED_EMAIL_DOMAINS is not set: copy .env.example to .env and set it, e.g. ALLOWED_EMAIL_DOMAINS=@acme.co,@acme.com"
  );
}

export default defineConfig({
  plugins: [react()],
  define: {
    __ALLOWED_EMAIL_DOMAINS__: JSON.stringify(allowlist),
  },
  server: {
    // Listen on every interface, on port 80, so another machine on the LAN can
    // open http://rmshost.local (or http://<this-pc-ipv4>) with no port suffix.
    // strictPort: if something else grabs :80, fail loudly rather than silently
    // moving to 5174 and breaking the no-port URL. Proxy targets stay
    // localhost — they are this machine talking to its own API.
    host: true,
    port: 80,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      // The API server (see `npm run dev`). Health stays at /health; future
      // domain endpoints live under /api.
      "/health": "http://localhost:3000",
      "/api": "http://localhost:3000",
      // The sandbox instance (same process, second database) is mounted at
      // /sandbox on the same listener — no second port. Only its API surface
      // is proxied: the sandbox DOCUMENTS must come from Vite itself (the dev
      // client), because a proxied document is Express's built dist HTML,
      // whose absolute /assets/* script URLs resolve back against Vite and
      // 404 — a white screen. Vite's SPA fallback serves the dev client at
      // /sandbox/*, the client derives isSandbox from the path, and every
      // sandbox fetch lands on /sandbox/api/* below.
      "/sandbox/api": "http://localhost:3000",
      "/sandbox/health": "http://localhost:3000",
    },
  },
  build: {
    outDir: "dist",
  },
});
