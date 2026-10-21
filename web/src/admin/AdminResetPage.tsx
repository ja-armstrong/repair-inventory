import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError } from "../api";
import { adminApi, adminJson, adminUpload, type ResetResponse, type ResetSourcesResponse } from "./api";

/**
 * The sandbox Reset page (sandbox ticket 05, spec decision 5): the trainer's
 * way to put data into the sandbox. Pick any .sqlite from data/backups/
 * (prod copies AND sandbox- snapshots — labeled) or upload a file; both
 * paths run the same validation as a production restore before anything is
 * touched, the current sandbox database is backed up automatically first,
 * and the swap happens at the next server restart. The page states the
 * consequences plainly: everyone in the sandbox is logged out (sessions live
 * in the database) and trainee-created users vanish. Manual only — no
 * schedule, no auto-reset.
 */

function formatBytes(sizeBytes: number): string {
  if (sizeBytes >= 1_048_576) {
    return `${(sizeBytes / 1_048_576).toFixed(1)} MB`;
  }
  if (sizeBytes >= 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${sizeBytes} B`;
}

export function AdminResetPage() {
  const [sources, setSources] = useState<ResetSourcesResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [result, setResult] = useState<ResetResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadSources = useCallback(() => {
    adminApi<ResetSourcesResponse>("/api/admin/reset/sources")
      .then((body) => {
        setSources(body);
        setLoadError(null);
      })
      .catch((err: unknown) =>
        setLoadError(err instanceof ApiError ? err.message : "the request failed")
      );
  }, []);

  useEffect(() => {
    loadSources();
  }, [loadSources]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || (!picked && !file) || !acknowledged) {
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const body = file
        ? await (async () => {
            // The upload path: raw bytes, same route as the picked filename.
            const response = await adminUpload("/api/admin/reset", file.name, await file.arrayBuffer());
            if (!response.ok) {
              const errorBody = (await response.json().catch(() => null)) as { error?: string } | null;
              throw new ApiError(response.status, errorBody?.error ?? `reset failed (${response.status})`);
            }
            return (await response.json()) as ResetResponse;
          })()
        : await adminJson<ResetResponse>("/api/admin/reset", { filename: picked });
      setResult(body);
      setPicked(null);
      setFile(null);
      setAcknowledged(false);
      loadSources();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
    } finally {
      setBusy(false);
    }
  }

  const ready = (picked !== null || file !== null) && acknowledged && !busy;

  return (
    <section>
      <h2>Reset the sandbox</h2>
      <p>
        Replaces the SANDBOX database with a backup: pick any <code>.sqlite</code> file from{" "}
        <code>data/backups/</code> below (production copies and{" "}
        <code>sandbox-</code> snapshots are both listed — snapshots are labeled) or upload a file.
        The chosen file must pass the same validation as a production restore (integrity check and
        migration history) or it is refused. The current sandbox database is backed up
        automatically first; its filename is shown in the response.
      </p>
      <p className="status-warn">
        Resetting logs out everyone in the sandbox — sessions live in the database — and every
        user created for training vanishes. The swap itself happens at the <strong>next server
        restart</strong>; until then the sandbox keeps running on its current data.
      </p>

      {loadError && <p className="status-error">{loadError}</p>}

      {sources?.empty && (
        <p className="status-warn">
          <code>data/backups/</code> holds no <code>.sqlite</code> files. Take a Backup first, or
          upload a file below — uploading still works.
        </p>
      )}

      {sources !== null && !sources.empty && (
        <fieldset className="form">
          <legend>Reset source</legend>
          {sources.sources.map((source) => (
            <label key={source.filename}>
              <input
                type="radio"
                name="reset-source"
                checked={picked === source.filename}
                onChange={() => {
                  setPicked(source.filename);
                  setFile(null);
                }}
              />{" "}
              <code>{source.filename}</code> — {formatBytes(source.sizeBytes)},{" "}
              {new Date(source.modifiedAt).toLocaleString()}
              {source.sandboxSnapshot && " (sandbox snapshot)"}
            </label>
          ))}
        </fieldset>
      )}

      <form className="form" onSubmit={submit}>
        <label>
          …or upload a .sqlite file instead of picking one
          <input
            type="file"
            accept=".sqlite"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setPicked(null);
            }}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />{" "}
          I understand: everyone in the sandbox is logged out, trainee-created users vanish, and
          the swap happens at the next server restart.
        </label>
        <button type="submit" disabled={!ready}>
          Validate and stage reset
        </button>
      </form>

      {result && (
        <p className="status-ok">
          Validated and staged: {result.staged} in data/backups/. The current sandbox database was
          backed up first as {result.backup}. RESTART the server to complete the swap — everyone in
          the sandbox is logged out and trainee-created users are gone once it applies.
        </p>
      )}
      {error && <p className="status-error">{error}</p>}
    </section>
  );
}
