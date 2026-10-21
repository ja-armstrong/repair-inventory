import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, apiJson, ApiError } from "../api";
import { hasManagerPowers, useAuth } from "../auth";
import { pastAuditLabel } from "../auditLabels";
import { Timeline, type TimelineEntry } from "../components/Timeline";

interface AuditStatus {
  intervalMonths: number;
  lastAuditAt: string | null;
  /** The boundary the last audit was triggered by (NULL only on the bootstrap audit). */
  lastScheduledAt: string | null;
  nextAuditAt: string | null;
  openAuditId: number | null;
}

interface PartView {
  id: number;
  serial: string;
  skuId: number;
  skuName: string;
  status: string;
  statusLabel: string;
  lastCountedAt: string | null;
}

interface ExemptPart extends PartView {
  reason: string;
}

interface AuditDetail {
  id: number;
  scheduledAt: string | null;
  openedAt: string;
  closedAt: string | null;
  openedBy: { id: number; email: string } | null;
  closedBy: { id: number; email: string } | null;
  previousAuditId: number | null;
  anchorAt: string | null;
  intervalMonths: number;
  open: boolean;
  summary: { demanded: number; counted: number; failed: number; moved: number };
  parts: {
    due: PartView[];
    counted: PartView[];
    scanned: PartView[];
    failed: PartView[];
    moved: PartView[];
    exempt: ExemptPart[];
  };
  events: TimelineEntry[];
}

interface AuditSummary {
  id: number;
  scheduledAt: string | null;
  openedAt: string;
  closedAt: string | null;
  openedBy: { id: number; email: string };
  closedBy: { id: number; email: string } | null;
  closeKind: string | null;
  summary: { demanded: number; counted: number; failed: number; moved: number };
}

const REASON_LABELS: Record<string, string> = {
  "in-transit": "In-Transit — on an open RMA, buyback, or return order",
  rma: "RMA — slated for return",
  buyback: "Buyback — slated for supplier sale",
  unavailable: "Unavailable — out of circulation",
  damaged_by_tech: "Damaged by Tech — out of circulation",
  "recently-counted": "Counted since the previous audit",
  "added-since-open": "Added after this audit opened",
};

function formatTime(iso: string | null): string {
  return iso === null ? "—" : new Date(iso).toLocaleString();
}

/**
 * Audits (spec stories 58–64): the automatic counting discipline (ADR-0002).
 * Windows open and close themselves on the `audit_interval_months` boundary;
 * the only manual open left is the manager's one-time bootstrap of the very
 * first window, and closing early is a manager's decision — the button is
 * visible to everyone but enabled only for manager powers (ticket 03's gate).
 * Techs scan serials against the due list, and closing settles with no
 * grace — due-but-unscanned parts become Unavailable. Exemptions (RMA in
 * transit, out of circulation, counted-since) are visible per part.
 */
export function AuditsPage() {
  const { user } = useAuth();
  const manager = user !== null && hasManagerPowers(user.role);
  const [status, setStatus] = useState<AuditStatus | null>(null);
  const [audits, setAudits] = useState<AuditSummary[]>([]);
  const [detail, setDetail] = useState<AuditDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanSerial, setScanSerial] = useState("");
  const [scanNote, setScanNote] = useState("");
  const [openNote, setOpenNote] = useState("");

  const reload = useCallback(async () => {
    try {
      const statusLoaded = await api<AuditStatus>("/api/audits/status");
      const listLoaded = await api<{ audits: AuditSummary[] }>("/api/audits");
      setStatus(statusLoaded);
      setAudits(listLoaded.audits);
      setError(null);
      if (statusLoaded.openAuditId !== null) {
        setDetail(await api<AuditDetail>(`/api/audits/${statusLoaded.openAuditId}`));
      } else {
        setDetail(null);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not load audits");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function run(action: () => Promise<unknown>, done: string): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(done);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
    } finally {
      setBusy(false);
    }
  }

  function onOpen(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(
      () =>
        apiJson("/api/audits", openNote.trim() === "" ? {} : { note: openNote.trim() }).then(() =>
          setOpenNote("")
        ),
      "Audit window opened.",
    );
  }

  function onScan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (scanSerial.trim() === "" || !detail) {
      return;
    }
    const body: Record<string, unknown> = { serial: scanSerial.trim() };
    if (scanNote.trim() !== "") {
      body.note = scanNote.trim();
    }
    void run(
      () => apiJson(`/api/audits/${detail.id}/scan`, body).then(() => setScanSerial("")),
      "Counted.",
    );
  }

  function onClose() {
    if (detail && detail.parts.due.length > 0) {
      const proceed = window.confirm(
        `Close this audit? ${detail.parts.due.length} due-but-unscanned part(s) will become Unavailable.`
      );
      if (!proceed) {
        return;
      }
    }
    void run(() => apiJson(`/api/audits/${detail!.id}/close`, {}), "Audit closed.");
  }

  if (!status) {
    return (
      <section>
        <h2>Counting — audit window</h2>
        {error && <p className="status-error">{error}</p>}
        <p className="placeholder">Loading…</p>
      </section>
    );
  }

  return (
    <section>
      <h2>Counting — audit window</h2>
      {notice && <p className="status-ok">{notice}</p>}
      {error && <p className="status-error">{error}</p>}

      {detail ? (
        <div>
          <h3>
            Audit #{detail.id} — window {detail.open ? "open" : "closed"}
          </h3>
          <p className="placeholder">
            Opened {formatTime(detail.openedAt)} by {detail.openedBy?.email}
            {detail.closedAt && ` · closed ${formatTime(detail.closedAt)} by ${detail.closedBy?.email}`}
            {detail.scheduledAt && ` · scheduled for ${formatTime(detail.scheduledAt)}`}
          </p>
          <p>
            <strong>
              Demanded {detail.summary.demanded} · counted {detail.summary.counted} ·{" "}
              {detail.open
                ? `${detail.parts.due.length} still due`
                : `failed ${detail.summary.failed} · moved ${detail.summary.moved}`}
            </strong>
          </p>
          <p className="placeholder">
            The due list: parts whose last count falls on or before{" "}
            {detail.anchorAt ? `the previous audit (through ${new Date(detail.anchorAt).toLocaleDateString()})` : "the start of tracking."}
            Closing the audit moves unscanned parts to Unavailable.
          </p>

          {detail.open && (
            <>
              <form className="form" onSubmit={onScan}>
                <label>
                  Scan serial
                  <input
                    value={scanSerial}
                    onChange={(event) => setScanSerial(event.target.value)}
                    placeholder="P00001"
                    autoFocus
                    required
                  />
                </label>
                <label>
                  Note (required when the shelf disagrees with the recorded status)
                  <input
                    value={scanNote}
                    onChange={(event) => setScanNote(event.target.value)}
                    placeholder="e.g. found it in the wrong bin"
                  />
                </label>
                <button type="submit" disabled={busy}>
                  Count
                </button>
              </form>
              {/* Visible to everyone, enabled only for manager powers — the
                  client-side mirror of ticket 03's `requireManager` gate; the
                  server stays the enforcer (a stale client cannot close). */}
              <button
                type="button"
                disabled={busy || !manager}
                title={manager ? undefined : "Only a manager (or admin) can close the audit"}
                onClick={onClose}
              >
                Close audit{" "}
                {detail.parts.due.length > 0 ? `— fail ${detail.parts.due.length} uncounted` : ""}
              </button>
              {!manager && (
                <p className="placeholder">
                  Closing is a manager's decision — you can scan and watch the window, but the
                  close itself waits for a manager.
                </p>
              )}
            </>
          )}

          <h4>Due ({detail.parts.due.length})</h4>
          {detail.parts.due.length === 0 ? (
            <p className="placeholder">Nothing left to count in this window.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Serial</th>
                  <th>SKU</th>
                  <th>Status</th>
                  <th>Last counted</th>
                </tr>
              </thead>
              <tbody>
                {detail.parts.due.map((part) => (
                  <tr key={part.id}>
                    <td>
                      <Link to={`/inventory/parts/${part.serial}`}>{part.serial}</Link>
                    </td>
                    <td>{part.skuName}</td>
                    <td>{part.statusLabel}</td>
                    <td>
                      {part.lastCountedAt
                        ? new Date(part.lastCountedAt).toLocaleString()
                        : "Never"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {detail.parts.counted.length > 0 && (
            <>
              <h4>Counted this window ({detail.parts.counted.length})</h4>
              <p className="placeholder">
                {detail.parts.counted.map((part) => part.serial).join(", ")}
              </p>
            </>
          )}

          {detail.parts.scanned.length > 0 && (
            <>
              <h4>Scanned, but not demanded ({detail.parts.scanned.length})</h4>
              <p className="placeholder">
                {detail.parts.scanned.map((part) => part.serial).join(", ")}
              </p>
            </>
          )}

          {detail.parts.failed.length > 0 && (
            <>
              <h4>Failed — now Unavailable ({detail.parts.failed.length})</h4>
              <p className="status-error">
                {detail.parts.failed.map((part) => part.serial).join(", ")}
              </p>
            </>
          )}

          {detail.parts.moved.length > 0 && (
            <>
              <h4>Accounted for mid-window ({detail.parts.moved.length})</h4>
              <p className="placeholder">
                {detail.parts.moved.map((part) => part.serial).join(", ")}
              </p>
            </>
          )}

          <h4>Exempt ({detail.parts.exempt.length})</h4>
          {detail.parts.exempt.length === 0 ? (
            <p className="placeholder">Nothing is exempt — every part in circulation was demanded.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Serial</th>
                  <th>SKU</th>
                  <th>Why exempt</th>
                  <th>Last counted</th>
                </tr>
              </thead>
              <tbody>
                {detail.parts.exempt.map((part) => (
                  <tr key={part.id}>
                    <td>
                      <Link to={`/inventory/parts/${part.serial}`}>{part.serial}</Link>
                    </td>
                    <td>{part.skuName}</td>
                    <td>{REASON_LABELS[part.reason] ?? part.reason}</td>
                    <td>
                      {part.lastCountedAt
                        ? new Date(part.lastCountedAt).toLocaleString()
                        : "Never"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h4>Audit timeline</h4>
          <Timeline events={detail.events} />
        </div>
      ) : (
        <div>
          {status.lastAuditAt === null ? (
            // Bootstrap state (ADR-0002): no audit has ever existed. The Open
            // control exists ONLY here — a manager on a virgin system — and
            // never again: from the second window on, opening is the boundary
            // processor's job and the route refuses it (409).
            <>
              <p>
                No audits yet — the very first counting window is opened by hand, once. After it,
                windows open and close themselves on the schedule.
              </p>
              {manager ? (
                <form className="form" onSubmit={onOpen}>
                  <label>
                    Opening note (optional)
                    <input
                      value={openNote}
                      onChange={(event) => setOpenNote(event.target.value)}
                      placeholder="e.g. quiet week — counting now"
                    />
                  </label>
                  <button type="submit" disabled={busy}>
                    Open audit window
                  </button>
                </form>
              ) : (
                <p className="placeholder">A manager opens the first window.</p>
              )}
            </>
          ) : (
            // The gap: no window is open and the schedule exists. The next
            // window opens itself at the boundary — no Open control exists for
            // anyone, manager included. `nextAuditAt` is non-NULL here by
            // derivation (the schedule is the last audit's boundary + interval,
            // and `lastAuditAt` is non-NULL in this branch), hence the
            // assertion rather than a silent fallback string.
            <p>
              No window is open. The next audit opens itself:{" "}
              {new Date(status.nextAuditAt!).toLocaleString()} (every {status.intervalMonths}{" "}
              months
              {status.lastScheduledAt
                ? `, boundary of the last audit ${new Date(status.lastScheduledAt).toLocaleDateString()}`
                : ""}
              ).
            </p>
          )}
        </div>
      )}

      <p className="placeholder">
        Between audits, cycle count any SKU any time (below) — counted parts are exempt from the
        next audit's demand list.
      </p>

      {audits.length > 0 && (
        <>
          <h3>Past audits</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Audit</th>
                <th>Opened</th>
                <th>Closed</th>
                <th>Result</th>
                <th>Demanded</th>
                <th>Counted</th>
                <th>Failed</th>
                <th>Moved</th>
              </tr>
            </thead>
            <tbody>
              {audits.map((audit) => (
                <tr key={audit.id}>
                  <td>
                    #{audit.id}
                    {pastAuditLabel(audit.scheduledAt, (iso) =>
                      new Date(iso).toLocaleDateString()
                    )}
                  </td>
                  <td>{formatTime(audit.openedAt)}</td>
                  <td>{formatTime(audit.closedAt)}</td>
                  {/* The computed close kind (ticket 02): complete / shortfall, stamped at close —
                      NULL only while a window is still open. */}
                  <td>{audit.closeKind ?? "—"}</td>
                  <td>{audit.summary.demanded}</td>
                  <td>{audit.summary.counted}</td>
                  <td>{audit.summary.failed}</td>
                  <td>{audit.summary.moved}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
