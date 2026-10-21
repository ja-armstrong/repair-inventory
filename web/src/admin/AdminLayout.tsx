import { useEffect, useState, type FormEvent } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { ApiError } from "../api";
import { isSandbox } from "../sandbox";
import { adminApi, adminJson } from "./api";

/**
 * The admin surface's own layout (ticket 18): reached only by typing the URL,
 * never linked from the main app's navigation. It authenticates against the
 * ADMIN_KEY with its own cookie — a main-app session means nothing here, and
 * vice versa. When the panel is disabled (ADMIN_KEY unset server-side), the
 * API answers 404 and this layout says so plainly. In the sandbox (ticket 04)
 * every page also carries an explicit line naming the panel's target
 * database: a trainer must never have to guess which database a tool acts on.
 */
type Gate = "loading" | "locked" | "open" | "unavailable";

const NAV_ITEMS: ReadonlyArray<{ to: string; label: string; end?: boolean; sandboxOnly?: boolean }> = [
  { to: "/admin", label: "Overview", end: true },
  { to: "/admin/users", label: "Users" },
  { to: "/admin/settings", label: "Settings" },
  { to: "/admin/env", label: "Environment" },
  { to: "/admin/backup", label: "Backup" },
  // The reset surface exists only on the sandbox instance (sandbox ticket 05):
  // its routes are not registered in production, so the link is not either.
  { to: "/admin/reset", label: "Reset", sandboxOnly: true },
  { to: "/admin/danger", label: "Danger zone" },
  { to: "/admin/sql", label: "SQL console" },
  { to: "/admin/api-console", label: "API console" },
  { to: "/admin/system", label: "System info" },
];

export function AdminLayout() {
  const [gate, setGate] = useState<Gate>("loading");

  useEffect(() => {
    adminApi("/api/admin/session")
      .then(() => setGate("open"))
      .catch((err: unknown) =>
        setGate(err instanceof ApiError && err.status === 404 ? "unavailable" : "locked")
      );
  }, []);

  if (gate === "loading") {
    return null;
  }
  if (gate === "unavailable") {
    return (
      <main className="app-main">
        <h1>Admin</h1>
        <p className="status-error">
          The admin panel is disabled: ADMIN_KEY is not set on the server. Set it in the server's
          .env file and restart to enable settings, backups, and the danger zone.
        </p>
      </main>
    );
  }
  if (gate === "locked") {
    return <KeyEntry onOpen={() => setGate("open")} />;
  }
  return (
    <div className="app">
      <header className="app-header">
        <h1>RMS — Admin{isSandbox ? " (SANDBOX)" : ""}</h1>
        <nav className="app-nav">
          {NAV_ITEMS.filter((item) => !item.sandboxOnly || isSandbox).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => (isActive ? "nav-link nav-link-active" : "nav-link")}
            >
              {item.label}
            </NavLink>
          ))}
          <span className="nav-user">
            <button
              type="button"
              className="nav-logout"
              onClick={() => {
                void adminJson("/api/admin/session", {}, "DELETE").finally(() => setGate("locked"));
              }}
            >
              Lock admin
            </button>
          </span>
        </nav>
      </header>
      {isSandbox && (
        <p className="status-warn admin-sandbox-note">
          SANDBOX — every tool on these pages acts on the SANDBOX database only (its own file;
          System info and Environment show the exact path). Nothing here touches production data.
        </p>
      )}
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}

function KeyEntry({ onOpen }: { onOpen: () => void }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await adminJson("/api/admin/session", { key });
      onOpen();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app-main">
      <h1>Admin</h1>
      <form className="form" onSubmit={submit}>
        <label>
          Admin key
          <input
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            autoFocus
            required
          />
        </label>
        <button type="submit" disabled={busy}>
          Unlock
        </button>
        {error && <p className="status-error">{error}</p>}
      </form>
    </main>
  );
}
