import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { api, apiJson, ApiError } from "../api";
import { Timeline, type TimelineEntry } from "../components/Timeline";

interface BuybackOrderPart {
  partId: number;
  serial: string;
  skuId: number;
  skuName: string;
  priceCents: number;
  price: string;
  addedAt: string;
  addedByEmail: string;
}

interface BuybackOrderDetail {
  id: number;
  number: number;
  status: "in_transit" | "complete";
  statusLabel: string;
  createdAt: string;
  createdByEmail: string;
  completedAt: string | null;
  partCount: number;
  orderValueCents: number | null;
  partsValueCents: number;
  estimatedValueCents: number;
  parts: BuybackOrderPart[];
  events: TimelineEntry[];
}

/**
 * Buyback order detail (ticket 27; order-level value since 0027) — the RMA
 * order detail shape, earning money: the scan-first assembly screen (a
 * keyboard-wedge scanner types the serial and presses Enter — the input stays
 * focused), the merged immutable timeline, and — while In-Transit — the
 * Complete flow with ONE hand-entered order value (the lump sum the supplier
 * paid) and one note. On Complete every part becomes Unavailable; there are
 * no per-part dispositions or prices. While open, the header shows the
 * estimated recovery — 10% of the parts' price sum — because the real value
 * is only known when the supplier pays.
 */
export function BuybackDetailPage() {
  const { id } = useParams();
  const orderId = Number(id);
  const [order, setOrder] = useState<BuybackOrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanInput, setScanInput] = useState("");
  const [noteText, setNoteText] = useState("");
  const scanField = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    if (!Number.isInteger(orderId) || orderId <= 0) {
      setError("invalid buyback order id");
      return;
    }
    try {
      const detail = await api<BuybackOrderDetail>(`/api/buyback-orders/${orderId}`);
      setOrder(detail);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not load the buyback order");
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
      const detail = await apiJson<BuybackOrderDetail>(`/api/buyback-orders/${orderId}/parts`, {
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
      await apiJson(`/api/buyback-orders/${orderId}/notes`, { note: noteText });
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
        <h2>Buyback order</h2>
        <p className="status-error">{error}</p>
        <Link to="/buyback">← All buyback orders</Link>
      </section>
    );
  }
  if (!order) {
    return (
      <section>
        <h2>Buyback order #{id}</h2>
        <p className="placeholder">Loading…</p>
      </section>
    );
  }

  const open = order.status === "in_transit";

  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  // The server throws on a complete buyback order with no value (the
  // loud-failure seam in the buybacks domain), so a NULL here is a contract
  // breach — failed loudly, not rendered as a placeholder.
  const completedValueCents = (detail: BuybackOrderDetail): number => {
    if (detail.orderValueCents === null) {
      throw new Error(`buyback order #${detail.number} is complete but carries no order value`);
    }
    return detail.orderValueCents;
  };

  return (
    <section>
      <p>
        <Link to="/buyback">← All buyback orders</Link>
      </p>
      <h2>Buyback order #{order.number}</h2>
      <p className="placeholder">
        {order.statusLabel} · created {new Date(order.createdAt).toLocaleString()} by{" "}
        {order.createdByEmail}
        {order.completedAt !== null &&
          ` · completed ${new Date(order.completedAt).toLocaleString()}`}
      </p>
      {open && order.partCount > 0 && (
        <p className="placeholder">
          Estimated recovery {money(order.estimatedValueCents)} — 10% of{" "}
          {money(order.partsValueCents)} in parts value; the real value is the one amount you
          enter when the supplier pays.
        </p>
      )}
      {!open && (
        <p className="placeholder">
          Order value {completedValueCents(order)} across {order.partCount}{" "}
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
              Only Buyback-status parts may be added to a buyback order.
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

/**
 * The Complete flow: ONE hand-entered order value (the lump sum the supplier
 * paid) and one note, then a single transition — no per-part dispositions.
 */
function CompleteForm({
  order,
  busy,
  onSetBusy,
  onCompleted,
}: {
  order: BuybackOrderDetail;
  busy: boolean;
  onSetBusy: (value: boolean) => void;
  onCompleted: () => Promise<void>;
}) {
  const [orderValue, setOrderValue] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const ready = note.trim() !== "" && orderValue.trim() !== "";

  async function onComplete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSetBusy(true);
    setError(null);
    try {
      await apiJson(`/api/buyback-orders/${order.id}/complete`, {
        note,
        orderValue,
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
        On Complete every part becomes Unavailable; the order is settled for the one value you
        enter here.
      </p>
      <label>
        Order value (USD) — the full amount the supplier paid
        <input
          value={orderValue}
          onChange={(event) => setOrderValue(event.target.value)}
          placeholder="45.50"
          required
        />
      </label>
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
