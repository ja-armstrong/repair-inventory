import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../api";
import { isSandbox } from "../sandbox";
import { adminApi, adminJson, type EnvState, type RestartGate } from "./api";

/**
 * The Environment page (ticket 22): edits the server's .env file through the
 * admin API. Secrets are masked by the server and an empty secret input means
 * "no change". Every saved value takes effect only after a server restart —
 * the page states this plainly and carries the restart button, with the
 * supervision gate state (dev / supervised / refused) shown as-is. The page
 * also names, read-only, the database file THIS panel governs and the mount
 * it lives under (sandbox ticket 04): the trainer must see exactly which
 * file the sandbox is.
 */
const RESTART_PHRASE = "RESTART";

export function AdminEnvPage() {
  const [state, setState] = useState<EnvState | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Restart section
  const [gate, setGate] = useState<RestartGate | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [restartError, setRestartError] = useState<string | null>(null);
  const [restartNotice, setRestartNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const body = await adminApi<EnvState>("/api/admin/env");
      setState(body);
      setDrafts(Object.fromEntries(body.entries.map((entry) => [entry.key, ""])));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not load the .env state");
    }
  }, []);

  useEffect(() => {
    void reload();
    adminApi<RestartGate>("/api/admin/restart")
      .then(setGate)
      .catch(() => setGate(null));
  }, [reload]);

  async function save(entryKey: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = await adminJson<EnvState & { changed: boolean; message?: string }>(
        "/api/admin/env",
        { key: entryKey, value: drafts[entryKey] ?? "" },
        "PUT"
      );
      setState(body);
      setDrafts(Object.fromEntries(body.entries.map((entry) => [entry.key, ""])));
      setNotice(body.message ?? `${entryKey} saved.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
    } finally {
      setBusy(false);
    }
  }

  async function restart() {
    setBusy(true);
    setRestartError(null);
    setRestartNotice(null);
    try {
      const body = await adminJson<{ ok: boolean; message: string }>("/api/admin/restart", {
        confirmation,
      });
      setRestartNotice(body.message);
      setConfirmation("");
    } catch (err) {
      setRestartError(err instanceof ApiError ? err.message : "the request failed");
    } finally {
      setBusy(false);
    }
  }

  if (!state) {
    return (
      <section>
        <h2>Environment</h2>
        {error && <p className="status-error">{error}</p>}
      </section>
    );
  }

  return (
    <section>
      <h2>Environment</h2>
      <p className="status-warn">
        Changes saved here are written to the server's .env file and take effect ONLY when the
        server is restarted. {!state.file.exists && "The .env file does not exist yet — the first save creates it."}
      </p>
      {state.restartRequired && (
        <p className="status-warn">Some values differ from what the running server loaded — restart to apply them.</p>
      )}
      <table className="table">
        <tbody>
          <tr>
            <th>This panel's database</th>
            <td>{state.instance.dbPath}</td>
          </tr>
          <tr>
            <th>Mounted at</th>
            <td>{state.instance.mountPrefix === "" ? "/ (the main app)" : state.instance.mountPrefix}</td>
          </tr>
        </tbody>
      </table>
      <p className="status-warn">
        These two values are read-only: they are how THIS instance is wired, resolved by the
        server at startup. The .env keys below are shared by both instances.
      </p>
      {notice && <p className="status-ok">{notice}</p>}
      {error && <p className="status-error">{error}</p>}

      <table className="table">
        <thead>
          <tr>
            <th>Key</th>
            <th>Value</th>
            <th>Description</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {state.entries.map((entry) => (
            <tr key={entry.key}>
              <td>
                {entry.key}
                {entry.pendingRestart && (
                  <div className="status-warn">restart required</div>
                )}
              </td>
              <td>
                {entry.editable ? (
                  <input
                    type={entry.secret ? "password" : "text"}
                    value={drafts[entry.key] ?? ""}
                    onChange={(event) =>
                      setDrafts((current) => ({ ...current, [entry.key]: event.target.value }))
                    }
                    placeholder={entry.value}
                    aria-label={entry.key}
                    autoComplete="off"
                  />
                ) : (
                  entry.value
                )}
              </td>
              <td>{entry.editable ? entry.description : `${entry.description} — ${entry.reason}`}</td>
              <td className="table-actions">
                {entry.editable && (
                  <button type="button" disabled={busy} onClick={() => void save(entry.key)}>
                    Save
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="admin-write-mode">
        <h3>Restart the server</h3>
        {gate ? (
          <>
            <span className={gate.allowed ? "status-ok" : "status-error"}>
              {gate.allowed
                ? `Restart is allowed (${gate.mode === "dev" ? "dev supervision: tsx watch restarts the server on exit" : "supervised: ALLOW_RESTART=true"}).`
                : "Restart is refused by the server."}
            </span>
            <p>{gate.explanation}</p>
          </>
        ) : (
          <span>Restart state could not be loaded.</span>
        )}
        <p className="status-warn">
          A restart ends every admin session — you must re-enter the admin key. Main-app sessions
          live in the database and survive.
          {isSandbox
            ? " This restarts the WHOLE server process: the sandbox and production run in one process, so BOTH environments stop and come back together."
            : ""}
        </p>
        {restartNotice && <p className="status-ok">{restartNotice}</p>}
        {restartError && <p className="status-error">{restartError}</p>}
        <label className="admin-inline">
          <input
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder={`type ${RESTART_PHRASE}`}
            autoComplete="off"
          />
          <button
            type="button"
            disabled={busy || confirmation.trim() !== RESTART_PHRASE || !(gate?.allowed ?? false)}
            onClick={() => void restart()}
          >
            Restart server
          </button>
        </label>
      </div>
    </section>
  );
}
