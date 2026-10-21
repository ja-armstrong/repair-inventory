import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, apiJson, ApiError } from "../api";

interface RmaOrderSummary {
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
}

interface ReturnOrderSummary {
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
}

interface RmaPartPoolEntry {
  id: number;
  serial: string;
  skuId: number;
  skuName: string;
  rmaOrderId: number | null;
  rmaNumber: number | null;
}

/**
 * The RMA tab (ticket 09, extended by ticket 29): RMA orders — the create
 * form (required opening note), the order list, and the pool of all
 * RMA-status parts — PLUS the Return orders that live under this tab: a
 * Return Order ships AVAILABLE parts back and books their price as revenue on
 * completion, so its list shows the committed value (open) or booked revenue
 * (complete). Scanning happens on each order's detail screen.
 *
 * Estimated recovery (ticket 29): an OPEN RMA order shows 50% of its parts'
 * price sum — the value is only known when the vendor accepts, and the credit
 * is entered by hand then. The server computes the estimate; this page only
 * renders it.
 */
export function RmaPage() {
  const navigate = useNavigate();
  const [orders, setOrders] = useState<RmaOrderSummary[]>([]);
  const [returns, setReturns] = useState<ReturnOrderSummary[]>([]);
  const [rmaParts, setRmaParts] = useState<RmaPartPoolEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [returnNote, setReturnNote] = useState("");
  const [returnBusy, setReturnBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [orderList, returnList, partPool] = await Promise.all([
        api<RmaOrderSummary[]>("/api/rma-orders"),
        api<ReturnOrderSummary[]>("/api/return-orders"),
        api<RmaPartPoolEntry[]>("/api/rma-parts"),
      ]);
      setOrders(orderList);
      setReturns(returnList);
      setRmaParts(partPool);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not load RMA orders");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await apiJson<RmaOrderSummary>("/api/rma-orders", { note });
      setNote("");
      navigate(`/rma/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
    } finally {
      setBusy(false);
    }
  }

  async function onCreateReturn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setReturnBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await apiJson<ReturnOrderSummary>("/api/return-orders", { note: returnNote });
      setReturnNote("");
      navigate(`/rma/returns/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
    } finally {
      setReturnBusy(false);
    }
  }

  return (
    <section>
      <h2>RMA &amp; Return Orders</h2>
      {notice && <p className="status-ok">{notice}</p>}
      {error && <p className="status-error">{error}</p>}

      <form className="form" onSubmit={onCreate}>
        <label>
          Opening note (required)
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            placeholder=""
            required
          />
        </label>
        <p className="placeholder">
          An RMA order starts In-Transit; scan RMA-status parts onto it from its detail screen.
          The credit is entered when the vendor accepts — an open order shows an estimate (50% of
          the parts' value).
        </p>
        <button type="submit" disabled={busy}>
          Create RMA order
        </button>
      </form>

      <h3>RMA orders</h3>
      {orders.length === 0 ? (
        <p className="placeholder">No RMA orders yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Status</th>
              <th>Parts</th>
              <th>Credit / Est. recovery</th>
              <th>Created</th>
              <th>Completed</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.id}>
                <td>
                  <Link to={`/rma/${order.id}`}>#{order.number}</Link>
                </td>
                <td>{order.statusLabel}</td>
                <td>{order.partCount}</td>
                <td>
                  {order.status === "complete"
                    ? order.creditCents === 0
                      ? "—"
                      : formatMoney(order.creditCents)
                    : order.partCount === 0
                      ? "—"
                      : `est. ${formatMoney(order.estimatedValueCents)} (of ${formatMoney(
                          order.partsValueCents,
                        )})`}
                </td>
                <td>
                  {new Date(order.createdAt).toLocaleDateString()} · {order.createdByEmail}
                </td>
                <td>
                  {order.completedAt === null
                    ? "—"
                    : new Date(order.completedAt).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>RMA-status parts</h3>
      {rmaParts.length === 0 ? (
        <p className="placeholder">
          Parts become RMA when removed from a batch with the RMA destination, or set on the
          part's page.
        </p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Serial</th>
              <th>SKU</th>
              <th>On an open order</th>
            </tr>
          </thead>
          <tbody>
            {rmaParts.map((part) => (
              <tr key={part.id}>
                <td>
                  <Link to={`/inventory/parts/${encodeURIComponent(part.serial)}`}>
                    {part.serial}
                  </Link>
                </td>
                <td>
                  <Link to={`/inventory/skus/${part.skuId}`}>{part.skuName}</Link>
                </td>
                <td>
                  {part.rmaNumber === null ? (
                    "— available to scan"
                  ) : (
                    <Link to={`/rma/${part.rmaOrderId}`}>#{part.rmaNumber}</Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Return orders</h3>
      <p className="placeholder">
        A Return Order ships <strong>Available</strong> parts back to a vendor and books each
        part's price as revenue when it completes — no manual value entry, unlike an RMA credit.
      </p>
      <form className="form" onSubmit={onCreateReturn}>
        <label>
          Opening note (required)
          <textarea
            value={returnNote}
            onChange={(event) => setReturnNote(event.target.value)}
            rows={2}
            placeholder=""
            required
          />
        </label>
        <p className="placeholder">
          A return order starts In-Transit; scan Available parts onto it from its detail screen.
        </p>
        <button type="submit" disabled={returnBusy}>
          Create return order
        </button>
      </form>
      {returns.length === 0 ? (
        <p className="placeholder">No return orders yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Status</th>
              <th>Parts</th>
              <th>Revenue</th>
              <th>Created</th>
              <th>Completed</th>
            </tr>
          </thead>
          <tbody>
            {returns.map((order) => (
              <tr key={order.id}>
                <td>
                  <Link to={`/rma/returns/${order.id}`}>#{order.number}</Link>
                </td>
                <td>{order.statusLabel}</td>
                <td>{order.partCount}</td>
                <td>
                  {order.status === "complete"
                    ? order.revenueCents === 0
                      ? "—"
                      : formatMoney(order.revenueCents)
                    : order.partCount === 0
                      ? "—"
                      : formatMoney(order.estimatedValueCents)}
                </td>
                <td>
                  {new Date(order.createdAt).toLocaleDateString()} · {order.createdByEmail}
                </td>
                <td>
                  {order.completedAt === null
                    ? "—"
                    : new Date(order.completedAt).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
