import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { api, apiJson, ApiError } from "../api";
import { Timeline, type TimelineEntry } from "../components/Timeline";

interface RmaOrderPart {
  partId: number;
  serial: string;
  skuId: number;
  skuName: string;
  priceCents: number;
  price: string;
  addedAt: string;
  addedByEmail: string;
  disposition: "credited" | "rejected" | null;
  dispositionLabel: string | null;
  creditCents: number | null;
  credit: string | null;
  dispositionNote: string | null;
  settledAt: string | null;
}

interface RmaOrderDetail {
  id: number;
  number: number;
  status: "in_transit" | "complete";
  statusLabel: string;
  createdAt: string;
  createdByEmail: string;
  completedAt: string | null;
  partCount: number;
  creditCents: number;
  partsValueCents: number;
  estimatedValueCents: number;
  parts: RmaOrderPart[];
  events: TimelineEntry[];
}

/**
 * RMA order detail (ticket 09, estimate added ticket 29): the scan-first
 * assembly screen (a keyboard-wedge scanner types the serial and presses
 * Enter — the input stays focused), the merged immutable timeline, and —
 * while In-Transit — the Complete flow with a per-part disposition (credited
 * with a credit value entered by hand, or RMA-rejected) and notes. On
 * Complete every part becomes Unavailable. While open, the header shows the
 * estimated recovery — 50% of the parts' price sum — because the real credit
 * is only known when the vendor accepts.
 */
export function RmaDetailPage() {
  const { id } = useParams();
  const orderId = Number(id);
  const [order, setOrder] = useState<RmaOrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanInput, setScanInput] = useState("");
  const [noteText, setNoteText] = useState("");
  const scanField = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    if (!Number.isInteger(orderId) || orderId <= 0) {
      setError("invalid RMA order id");
      return;
    }
    try {
      const detail = await api<RmaOrderDetail>(`/api/rma-orders/${orderId}`);
      setOrder(detail);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not load the RMA order");
    }
  }, [orderId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (order?.status === "in_transit") {
      scanField.current?.focus();
    }
  }, [order?.status, order?.partCount]);

  async function onScan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const serial = scanInput.trim().toUpperCase();
    if (!serial || !order) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const detail = await apiJson<RmaOrderDetail>(`/api/rma-orders/${orderId}/parts`, {
        serial,
      });
      setOrder(detail);
      setNotice(`${serial} added — ${detail.partCount} ${
        detail.partCount === 1 ? "part" : "parts"
      } on the order.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the scan failed");
    } finally {
      setBusy(false);
      setScanInput("");
      scanField.current?.focus();
    }
  }

  async function onAddNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiJson(`/api/rma-orders/${orderId}/notes`, { note: noteText });
      setNoteText("");
      setNotice("Note added.");
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
    } finally {
      setBusy(false);
    }
  }

  if (error && !order) {
    return (
      <section>
        <h2>RMA order</h2>
        <p className="status-error">{error}</p>
        <Link to="/rma">← All RMA orders</Link>
      </section>
    );
  }
  if (!order) {
    return (
      <section>
        <h2>RMA order #{id}</h2>
        <p className="placeholder">Loading…</p>
      </section>
    );
  }

  const open = order.status === "in_transit";

  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  return (
    <section>
      <p>
        <Link to="/rma">← All RMA &amp; return orders</Link>
      </p>
      <h2>RMA order #{order.number}</h2>
      <p className="placeholder">
        {order.statusLabel} · created {new Date(order.createdAt).toLocaleString()} by{" "}
        {order.createdByEmail}
        {order.completedAt !== null &&
          ` · completed ${new Date(order.completedAt).toLocaleString()}`}
      </p>
      {open && order.partCount > 0 && (
        <p className="placeholder">
          Estimated recovery {money(order.estimatedValueCents)} — 50% of{" "}
          {money(order.partsValueCents)} in parts value; the real credit is entered per part when
          the vendor accepts.
        </p>
      )}
      {!open && (
        <p className="placeholder">
          Credited {money(order.creditCents)} across {order.partCount}{" "}
          {order.partCount === 1 ? "part" : "parts"}.
        </p>
      )}
      {notice && <p className="status-ok">{notice}</p>}
      {error && <p className="status-error">{error}</p>}

      {open && (
        <>
          <h3>Scan parts onto this order</h3>
          <form className="form scan-form" onSubmit={onScan}>
            <label>
              Scan or type a serial
              <input
                ref={scanField}
                value={scanInput}
                onChange={(event) => setScanInput(event.target.value)}
                placeholder="P00001"
                autoFocus
                autoComplete="off"
              />
            </label>
            <button type="submit" disabled={busy}>
              Add part
            </button>
            <p className="placeholder">
              Only RMA-status parts may be added to an RMA order.
            </p>
          </form>
        </>
      )}

      <h3>Parts ({order.partCount})</h3>
      {order.parts.length === 0 ? (
        <p className="placeholder">Nothing scanned onto this order yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Serial</th>
              <th>SKU</th>
              <th>Price</th>
              <th>Added</th>
              <th>Disposition</th>
              <th>Credit</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {order.parts.map((part) => (
              <tr key={part.partId}>
                <td>
                  <Link to={`/inventory/parts/${encodeURIComponent(part.serial)}`}>
                    {part.serial}
                  </Link>
                </td>
                <td>
                  <Link to={`/inventory/skus/${part.skuId}`}>{part.skuName}</Link>
                </td>
                <td>{part.price}</td>
                <td>
                  {new Date(part.addedAt).toLocaleDateString()} · {part.addedByEmail}
                </td>
                <td>{part.dispositionLabel ?? "—"}</td>
                <td>{part.credit ?? "—"}</td>
                <td>{part.dispositionNote ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {open && <CompleteForm order={order} busy={busy} onSetBusy={setBusy} onCompleted={reload} />}

      <h3>Timeline</h3>
      <form className="form" onSubmit={onAddNote}>
        <label>
          Add a note
          <input
            value={noteText}
            onChange={(event) => setNoteText(event.target.value)}
            placeholder="What happened?"
            required
          />
        </label>
        <button type="submit" disabled={busy}>
          Add note
        </button>
      </form>
      {/* The one timeline renderer (components/Timeline.tsx). */}
      <Timeline events={order.events} />
    </section>
  );
}

interface DispositionDraft {
  disposition: "" | "credited" | "rejected";
  credit: string;
  note: string;
}

const emptyDraft = (): DispositionDraft => ({ disposition: "", credit: "", note: "" });

/** The Complete flow: a disposition (and credit) per part, then one note and one transition. */
function CompleteForm({
  order,
  busy,
  onSetBusy,
  onCompleted,
}: {
  order: RmaOrderDetail;
  busy: boolean;
  onSetBusy: (value: boolean) => void;
  onCompleted: () => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<string, DispositionDraft>>({});
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  function draftFor(serial: string): DispositionDraft {
    return drafts[serial] ?? emptyDraft();
  }

  function updateDraft(serial: string, patch: Partial<DispositionDraft>): void {
    setDrafts((current) => ({
      ...current,
      [serial]: { ...emptyDraft(), ...current[serial], ...patch },
    }));
  }

  const ready =
    note.trim() !== "" &&
    order.parts.every((part) => {
      const draft = draftFor(part.serial);
      return (
        (draft.disposition === "credited" && draft.credit.trim() !== "" && draft.note.trim() !== "") ||
        (draft.disposition === "rejected" && draft.note.trim() !== "")
      );
    });

  async function onComplete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSetBusy(true);
    setError(null);
    try {
      await apiJson(`/api/rma-orders/${order.id}/complete`, {
        note,
        parts: order.parts.map((part) => {
          const draft = draftFor(part.serial);
          return {
            serial: part.serial,
            disposition: draft.disposition,
            credit: draft.disposition === "credited" ? draft.credit : undefined,
            note: draft.note,
          };
        }),
      });
      await onCompleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
    } finally {
      onSetBusy(false);
    }
  }

  if (order.parts.length === 0) {
    return null;
  }

  return (
    <form className="form" onSubmit={onComplete}>
      <h3>Complete this order</h3>
      {error && <p className="status-error">{error}</p>}
      <p className="placeholder">
        On Complete every part becomes Unavailable.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Serial</th>
            <th>Disposition</th>
            <th>Credit (USD)</th>
            <th>Note (required)</th>
          </tr>
        </thead>
        <tbody>
          {order.parts.map((part) => {
            const draft = draftFor(part.serial);
            return (
              <tr key={part.partId}>
                <td>{part.serial}</td>
                <td>
                  <select
                    value={draft.disposition}
                    onChange={(event) =>
                      updateDraft(part.serial, {
                        disposition: event.target.value as DispositionDraft["disposition"],
                      })
                    }
                  >
                    <option value="">choose…</option>
                    <option value="credited">Credited</option>
                    <option value="rejected">RMA-rejected</option>
                  </select>
                </td>
                <td>
                  {draft.disposition === "credited" ? (
                    <input
                      value={draft.credit}
                      onChange={(event) =>
                        updateDraft(part.serial, { credit: event.target.value })
                      }
                      placeholder=""
                      required
                    />
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  <input
                    value={draft.note}
                    onChange={(event) => updateDraft(part.serial, { note: event.target.value })}
                    placeholder=""
                    required
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <label>
        Completion note (required)
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={2}
          placeholder=""
          required
        />
      </label>
      <button type="submit" disabled={busy || !ready}>
        Complete order
      </button>
    </form>
  );
}
