import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { api, apiJson, ApiError } from "../api";
import { Timeline, type TimelineEntry } from "../components/Timeline";

interface ReturnOrderPart {
  partId: number;
  serial: string;
  skuId: number;
  skuName: string;
  priceCents: number;
  price: string;
  booked: boolean;
  addedAt: string;
  addedByEmail: string;
  settledAt: string | null;
}

interface ReturnOrderDetail {
  id: number;
  number: number;
  status: "in_transit" | "complete";
  statusLabel: string;
  createdAt: string;
  createdByEmail: string;
  completedAt: string | null;
  partCount: number;
  revenueCents: number;
  estimatedValueCents: number;
  parts: ReturnOrderPart[];
  events: TimelineEntry[];
}

/**
 * Return order detail (ticket 29), under the RMA tab: the same scan-first
 * assembly as an RMA order — but this shipment takes AVAILABLE parts. The
 * scan moves a part to In-Transit; Complete settles every part Unavailable
 * and BOOKS each part's price as revenue automatically — no per-part
 * disposition, no manual value entry (that is the RMA order's and buyback
 * order's shape, where the recovery is entered when the vendor/supplier
 * accepts).
 */
export function ReturnDetailPage() {
  const { id } = useParams();
  const orderId = Number(id);
  const [order, setOrder] = useState<ReturnOrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanInput, setScanInput] = useState("");
  const [noteText, setNoteText] = useState("");
  const scanField = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    if (!Number.isInteger(orderId) || orderId <= 0) {
      setError("invalid return order id");
      return;
    }
    try {
      const detail = await api<ReturnOrderDetail>(`/api/return-orders/${orderId}`);
      setOrder(detail);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not load the return order");
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
      const detail = await apiJson<ReturnOrderDetail>(`/api/return-orders/${orderId}/parts`, {
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
      await apiJson(`/api/return-orders/${orderId}/notes`, { note: noteText });
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
        <h2>Return order</h2>
        <p className="status-error">{error}</p>
        <Link to="/rma">← All RMA &amp; return orders</Link>
      </section>
    );
  }
  if (!order) {
    return (
      <section>
        <h2>Return order #{id}</h2>
        <p className="placeholder">Loading…</p>
      </section>
    );
  }

  const open = order.status === "in_transit";

  return (
    <section>
      <p>
        <Link to="/rma">← All RMA &amp; return orders</Link>
      </p>
      <h2>Return order #{order.number}</h2>
      <p className="placeholder">
        {order.statusLabel} · created {new Date(order.createdAt).toLocaleString()} by{" "}
        {order.createdByEmail}
        {order.completedAt !== null &&
          ` · completed ${new Date(order.completedAt).toLocaleString()}`}
      </p>
      <p className="placeholder">
        {open
          ? `Revenue on completion: ${formatMoney(order.estimatedValueCents)} (${
              order.partCount
            } ${order.partCount === 1 ? "part" : "parts"} at current prices).`
          : `Revenue booked: ${formatMoney(order.revenueCents)}.`}
      </p>
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
              Only Available parts may be added to a return order; completing the order converts
              them to Unavailable and books their prices as revenue.
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
              <th>{open ? "Price (books on completion)" : "Revenue"}</th>
              <th>Added</th>
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
                <td>
                  {part.price}
                  {open ? "" : part.booked ? " ✓" : ""}
                </td>
                <td>
                  {new Date(part.addedAt).toLocaleDateString()} · {part.addedByEmail}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {open && <CompleteForm order={order} busy={busy} onCompleted={reload} />}

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

/** The Complete flow: one note, one transition — the prices book themselves. */
function CompleteForm({
  order,
  busy,
  onCompleted,
}: {
  order: ReturnOrderDetail;
  busy: boolean;
  onCompleted: () => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function onComplete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      await apiJson(`/api/return-orders/${order.id}/complete`, { note });
      await onCompleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
    }
  }

  if (order.parts.length === 0) {
    return null;
  }

  return (
    <form className="form" onSubmit={onComplete}>
      <h3>Complete this order — books {formatMoney(order.estimatedValueCents)} of revenue</h3>
      {error && <p className="status-error">{error}</p>}
      <p className="placeholder">
        On Complete every part becomes Unavailable and each part's current price is snapshotted
        onto the order as booked revenue.
      </p>
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
      <button type="submit" disabled={busy || note.trim() === ""}>
        Complete order
      </button>
    </form>
  );
}

function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
