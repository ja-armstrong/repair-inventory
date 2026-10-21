import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, apiJson, ApiError } from "../api";

/**
 * The batch list: create a Batch (required opening note) and see every
 * batch's lifecycle status (stored — the server owns the transitions) and
 * its DERIVED device counts, recomputed from its devices' Repair Statuses
 * on every load.
 */

interface BatchSummary {
  id: number;
  number: number;
  createdAt: string;
  createdBy: { id: number; email: string };
  status: string;
  openingNote: string;
  approvedCost: string | null;
  deviceCounts: Record<string, number>;
  deviceTotal: number;
}

const COUNT_LABELS: [string, string][] = [
  ["awaitingRepair", "Awaiting repair"],
  ["inProgress", "In progress"],
  ["qa", "QA"],
  ["partsNeeded", "Parts needed"],
  ["repaired", "Repaired"],
  ["unrepairable", "Unrepairable"],
  ["additionalIssuesPresent", "Additional issues present"],
  ["deniedRepair", "Denied Repair"],
];

export function BatchesPage() {
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const reload = useCallback(async () => {
    try {
      setBatches(await api<BatchSummary[]>("/api/batches"));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not load batches");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function onCreateBatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await apiJson<BatchSummary>("/api/batches", { note });
      setNotice(`Created batch #${created.number}.`);
      setNote("");
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Batches</h2>
      {notice && <p className="status-ok">{notice}</p>}
      {error && <p className="status-error">{error}</p>}

      <form className="form" onSubmit={onCreateBatch}>
        <label>
          Opening note (required)
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="What kind of batch is this?"
            required
          />
        </label>
        <button type="submit" disabled={busy}>
          Create batch
        </button>
      </form>

      <table className="table">
        <thead>
          <tr>
            <th>Batch</th>
            <th>Opening note</th>
            <th>Status</th>
            <th>Created</th>
            <th>Created by</th>
            <th>Devices</th>
            <th>Device counts (derived)</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((batch) => (
            <tr key={batch.id}>
              <td>
                <Link to={`/batches/${batch.id}`}>#{batch.number}</Link>
              </td>
              {/* The note captured at creation (ticket 01): one line here,
                  the full text on hover. */}
              <td className="opening-note-cell" title={batch.openingNote}>
                {batch.openingNote}
              </td>
              <td>{batch.status}</td>
              <td>{new Date(batch.createdAt).toLocaleDateString()}</td>
              <td>{batch.createdBy.email}</td>
              <td>{batch.deviceTotal}</td>
              <td>
                {batch.deviceTotal === 0
                  ? "—"
                  : COUNT_LABELS.filter(([key]) => (batch.deviceCounts[key] ?? 0) > 0)
                      .map(([key, label]) => `${label}: ${batch.deviceCounts[key]}`)
                      .join(" · ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
