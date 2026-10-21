import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError } from "../api";
import { adminApi, adminJson, type SqlResult } from "./api";

/**
 * The SQL console (spec story 85): read-only SELECTs by default; writes need
 * the per-session write mode, which requires typing a confirmation phrase —
 * and every executed write is automatically backed up first by the server.
 * Errors are shown verbatim on purpose: this console exists to inspect and
 * fix data, so the exact SQLite message matters.
 */
const WRITE_PHRASE = "ALLOW WRITES";

export function AdminSqlPage() {
  const [sql, setSql] = useState("SELECT name FROM sqlite_master WHERE type = 'table'");
  const [writeMode, setWriteMode] = useState(false);
  const [allowWrite, setAllowWrite] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [result, setResult] = useState<SqlResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshMode = useCallback(async () => {
    try {
      const body = await adminApi<{ writeMode: boolean }>("/api/admin/sql/write-mode");
      setWriteMode(body.writeMode);
      if (!body.writeMode) {
        setAllowWrite(false);
      }
    } catch {
      setWriteMode(false);
    }
  }, []);

  useEffect(() => {
    void refreshMode();
  }, [refreshMode]);

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const body = await adminJson<SqlResult>("/api/admin/sql", {
        sql,
        allowWrite: writeMode && allowWrite,
      });
      setResult(body);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggleWriteMode() {
    setBusy(true);
    setError(null);
    try {
      if (writeMode) {
        const body = await adminJson<{ writeMode: boolean }>(
          "/api/admin/sql/write-mode",
          {},
          "DELETE"
        );
        setWriteMode(body.writeMode);
        setAllowWrite(false);
      } else {
        const body = await adminJson<{ writeMode: boolean }>("/api/admin/sql/write-mode", {
          confirmation,
        });
        setWriteMode(body.writeMode);
        setConfirmation("");
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>SQL console</h2>
      {error && <p className="status-error">{error}</p>}

      <div className="admin-write-mode">
        {writeMode ? (
          <>
            <span className="status-warn">Write mode is ON for this session.</span>
            <label className="admin-inline">
              <input
                type="checkbox"
                checked={allowWrite}
                onChange={(event) => setAllowWrite(event.target.checked)}
              />
              allow writes on the next run
            </label>
            <button type="button" disabled={busy} onClick={() => void toggleWriteMode()}>
              Turn write mode off
            </button>
          </>
        ) : (
          <>
            <span>Write mode is off — only SELECT statements run.</span>
            <input
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              placeholder={`type ${WRITE_PHRASE}`}
              autoComplete="off"
            />
            <button
              type="button"
              disabled={busy || confirmation.trim() !== WRITE_PHRASE}
              onClick={() => void toggleWriteMode()}
            >
              Enable write mode
            </button>
          </>
        )}
      </div>

      <form className="form" onSubmit={run}>
        <label>
          SQL (one statement; SELECT only unless write mode + allow writes)
          <textarea
            rows={5}
            value={sql}
            onChange={(event) => setSql(event.target.value)}
            spellCheck={false}
          />
        </label>
        <button type="submit" disabled={busy}>
          Run
        </button>
      </form>

      {result?.backup && (
        <p className="status-ok">
          Pre-write backup saved as {result.backup} in data/backups/.
        </p>
      )}
      {result?.rows && (
        <SqlTable result={result} />
      )}
      {result?.changes !== undefined && <p className="status-ok">{result.changes} row(s) changed.</p>}
      {result?.ok && <p className="status-ok">Executed.</p>}
    </section>
  );
}

function SqlTable({ result }: { result: SqlResult }) {
  return (
    <div>
      <p>{result.rowCount} row(s)</p>
      <table className="table">
        <thead>
          <tr>
            {(result.columns ?? []).map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(result.rows ?? []).map((row, index) => (
            <tr key={index}>
              {(result.columns ?? []).map((column) => (
                <td key={column}>{row[column] === null ? "NULL" : String(row[column])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
