import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Runs the API server (tsx watch, restarts on server/ changes) and the Vite
 * dev server (serves the web client, proxies /health and /api to the API)
 * together in one terminal. Ctrl+C stops both.
 *
 * Spawn `node` plus each package's JS CLI (not npx.cmd): Windows Node 24
 * throws spawn EINVAL on .cmd files unless shell is true, and shell:true
 * hides the API child's logs. Do not clear the screen on API restart —
 * that erases the login-link line.
 */
const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const viteCli = path.join(projectRoot, "node_modules", "vite", "bin", "vite.js");

const commands = [
  {
    name: "api",
    args: [
      tsxCli,
      "watch",
      "--clear-screen=false",
      "--exclude",
      "data",
      "--exclude",
      "web",
      "server/index.ts",
    ],
  },
  { name: "web", args: [viteCli, "web"] },
];

const children = commands.map(({ name, args }) => {
  console.log(`[dev] ${name}: node ${args.join(" ")}`);
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    stdio: "inherit",
    shell: false,
  });
  child.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`[dev] ${name} exited with code ${code}`);
    }
  });
  return child;
});

function shutdown() {
  // Children share the console, so Ctrl+C reaches them too; this just makes
  // the parent exit rather than linger after they're gone.
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

for (const child of children) {
  child.on("exit", () => {
    // If one process dies (e.g. a crash), stop the other and get out.
    shutdown();
  });
}
