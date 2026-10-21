import { useState, type FormEvent } from "react";
import { ApiError } from "../api";
import { adminJson, type ApiConsoleResult } from "./api";

/**
 * The API console (ticket 22): drives the app's real API from the panel. The
 * server dispatches each request against this same app AS the bootstrap
 * manager (a real session, the normal validation and timeline events), so
 * nothing bypasses the app's own rules. Non-2xx responses are shown, not
 * hidden; huge bodies are truncated for display only.
 */
const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"];

interface HistoryItem {
  method: string;
  path: string;
  status: number;
}

export function AdminApiConsolePage() {
  const [method, setMethod] = useState("GET");
  const [target, setTarget] = useState("/api/skus");
  const [bodyText, setBodyText] = useState("");
  const [result, setResult] = useState<ApiConsoleResult | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    let parsedBody: unknown = undefined;
    if (bodyText.trim() !== "") {
      try {
        parsedBody = JSON.parse(bodyText);
      } catch {
        setError("The body is not valid JSON.");
        setBusy(false);
        return;
      }
    }
    try {
      const response = await adminJson<ApiConsoleResult>("/api/admin/api-console", {
        method,
        path: target,
        ...(parsedBody !== undefined ? { body: parsedBody } : {}),
      });
      setResult(response);
      setHistory((current) =>
        [{ method, path: target, status: response.status }, ...current].slice(0, 10)
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
    } finally {
      setBusy(false);
    }
  }

  const statusClass =
    result && result.status < 400 ? "status-ok" : result ? "status-error" : "";

  return (
    <section>
      <h2>API console</h2>
      <p>
        Requests run against this same server, as the bootstrap manager. Only /api/... paths and
        /health are allowed.
      </p>
      {error && <p className="status-error">{error}</p>}

      <form className="form" onSubmit={run}>
        <label>
          Method
          <select value={method} onChange={(event) => setMethod(event.target.value)}>
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label>
          Path
          <input
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            placeholder="/api/skus"
            spellCheck={false}
          />
        </label>
        <label>
          Body (JSON, optional)
          <textarea
            rows={5}
            value={bodyText}
            onChange={(event) => setBodyText(event.target.value)}
            placeholder='{"name": "Screen", "price": "10.00", "kind": "serialized"}'
            spellCheck={false}
          />
        </label>
        <button type="submit" disabled={busy}>
          Run
        </button>
      </form>

      {result && (
        <div>
          <p className={statusClass}>
            Status: {result.status}
            {result.headers["content-type"] ? ` — ${result.headers["content-type"]}` : ""}
          </p>
          <pre className="table">
            {typeof result.body === "string"
              ? truncate(result.body)
              : truncate(JSON.stringify(result.body, null, 2))}
          </pre>
        </div>
      )}

      {history.length > 0 && (
        <div>
          <h3>Recent calls</h3>
          <table className="table">
            <tbody>
              {history.map((item, index) => (
                <tr key={index}>
                  <td>{item.method}</td>
                  <td>{item.path}</td>
                  <td className={item.status < 400 ? "status-ok" : "status-error"}>{item.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function truncate(text: string): string {
  return text.length > 5000 ? `${text.slice(0, 5000)}\n… (truncated for display)` : text;
}
