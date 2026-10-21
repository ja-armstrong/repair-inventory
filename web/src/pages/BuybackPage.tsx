import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, apiJson, ApiError } from "../api";

interface BuybackOrderSummary {
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
}

interface BuybackPartPoolEntry {
  id: number;
  serial: string;
  skuId: number;
  skuName: string;
  buybackOrderId: number | null;
  buybackNumber: number | null;
}

/**
 * Buyback orders home (ticket 27; order-level value since 0027): the create
 * form (required opening note), the order list, and the pool of all
 * Buyback-status parts — the supplier program's assembly list. CONTEXT.md: a
 * Buyback Order is "an RMA order that earns money"; scanning happens on the
 * order's detail screen. An open order shows its estimated recovery (10% of
 * the parts' price sum); the real value is the one amount entered when the
 * supplier pays.
 */
export function BuybackPage() {
  const navigate = useNavigate();
  const [orders, setOrders] = useState<BuybackOrderSummary[]>([]);
  const [buybackParts, setBuybackParts] = useState<BuybackPartPoolEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const reload = useCallback(async () => {
    try {
      const [orderList, partPool] = await Promise.all([
        api<BuybackOrderSummary[]>("/api/buyback-orders"),
        api<BuybackPartPoolEntry[]>("/api/buyback-parts"),
      ]);
      setOrders(orderList);
      setBuybackParts(partPool);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not load buyback orders");
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
      const created = await apiJson<BuybackOrderSummary>("/api/buyback-orders", { note });
      setNote("");
      navigate(`/buyback/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Buyback orders</h2>
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
          A buyback order starts In-Transit; scan parts onto it from its detail screen.
        </p>
        <button type="submit" disabled={busy}>
          Create buyback order
        </button>
      </form>

      <h3>Orders</h3>
      {orders.length === 0 ? (
        <p className="placeholder">No buyback orders yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Status</th>
              <th>Parts</th>
              <th>Value / Est.</th>
              <th>Created</th>
              <th>Completed</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.id}>
                <td>
                  <Link to={`/buyback/${order.id}`}>#{order.number}</Link>
                </td>
                <td>{order.statusLabel}</td>
                <td>{order.partCount}</td>
                <td>
                  {order.status === "complete"
                    ? formatMoney(completedValueCents(order))
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

      <h3>Buyback-status parts (the pool)</h3>
      {buybackParts.length === 0 ? (
        <p className="placeholder">
          Parts become Buyback when removed from a batch with the Buyback
          destination, or set on the part's page.
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
            {buybackParts.map((part) => (
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
                  {part.buybackNumber === null ? (
                    "— available to scan"
                  ) : (
                    <Link to={`/buyback/${part.buybackOrderId}`}>#{part.buybackNumber}</Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * The server throws on a complete buyback order with no value (the
 * loud-failure seam in the buybacks domain), so a NULL here is a contract
 * breach — failed loudly, not rendered as a placeholder.
 */
function completedValueCents(order: BuybackOrderSummary): number {
  if (order.orderValueCents === null) {
    throw new Error(`buyback order #${order.number} is complete but carries no order value`);
  }
  return order.orderValueCents;
}

export function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
