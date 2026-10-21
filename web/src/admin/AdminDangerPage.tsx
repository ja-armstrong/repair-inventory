import { useState, type FormEvent } from "react";
import { ApiError } from "../api";
import { isSandbox } from "../sandbox";
import { adminJson, adminUpload } from "./api";

/**
 * The danger zone (spec stories 83–84): clear the database (typed phrase,
 * automatic pre-wipe backup, console-logged) and restore from a backup file
 * (validated, current database backed up, swap happens at the next restart).
 * Every response names the backup it made — that filename is the undo path.
 *
 * The stock restore route exists ONLY on the production instance: in the
 * sandbox it is superseded by the Reset page (sandbox ticket 05), whose
 * routes stage into the sandbox's own slot — so the sandbox panel does not
 * render a card whose button would only answer 404.
 */

const CLEAR_PHRASE = "ERASE ALL DATA";

interface ClearResponse {
  ok: true;
  backup: string;
}

interface RestoreResponse {
  ok: true;
  backup: string;
  staged: string;
  restartRequired: true;
}

export function AdminDangerPage() {
  return (
    <section>
      <h2>Danger zone</h2>
      <ClearCard />
      {!isSandbox && <RestoreCard />}
    </section>
  );
}

function ClearCard() {
  const [phrase, setPhrase] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const body = await adminJson<ClearResponse>("/api/admin/clear", { confirmation: phrase });
      setResult(
        `Database cleared. A backup of everything that was just erased was saved as ` +
          `${body.backup} in data/backups/ — download or copy it now. Everyone has been ` +
          `logged out of the main app; the bootstrap manager can request a fresh login link.`
      );
      setPhrase("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-danger">
      <h3>Clear the database</h3>
      <p>
        Drops every table and rebuilds the empty schema from the migrations. All batches, parts,
        orders, audits, and users are gone. A backup is taken automatically first.
      </p>
      <form className="form" onSubmit={submit}>
        <label>
          Type {CLEAR_PHRASE} to confirm
          <input
            value={phrase}
            onChange={(event) => setPhrase(event.target.value)}
            autoComplete="off"
          />
        </label>
        <button type="submit" disabled={busy || phrase.trim() !== CLEAR_PHRASE}>
          Clear the database
        </button>
      </form>
      {result && <p className="status-ok">{result}</p>}
      {error && <p className="status-error">{error}</p>}
    </div>
  );
}

function RestoreCard() {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) {
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const bytes = await file.arrayBuffer();
      const response = await adminUpload("/api/admin/restore", file.name, bytes);
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new ApiError(response.status, body?.error ?? `restore failed (${response.status})`);
      }
      const body = (await response.json()) as RestoreResponse;
      setResult(
        `Validated and staged: ${body.staged} in data/backups/. The current database was ` +
          `backed up first as ${body.backup}. RESTART the server to complete the swap — ` +
          `writes made between now and the restart are discarded.`
      );
      setFile(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-danger">
      <h3>Restore from backup</h3>
      <p>
        Upload a .sqlite backup. It must pass an integrity check and carry a recognizable
        migration history, or it is refused. The current database is backed up automatically
        before anything is staged. The swap itself happens when the server next starts.
      </p>
      <form className="form" onSubmit={submit}>
        <label>
          Backup file (.sqlite)
          <input
            type="file"
            accept=".sqlite"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </label>
        <button type="submit" disabled={busy || file === null}>
          Validate and stage restore
        </button>
      </form>
      {result && <p className="status-ok">{result}</p>}
      {error && <p className="status-error">{error}</p>}
    </div>
  );
}
