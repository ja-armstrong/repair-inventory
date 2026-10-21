import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";

/**
 * Purchase orders list (ticket 07): newest first, one row per PO with its
 * status, size, and total. Creating is a tech's job; approving happens on
 * the detail page (manager-only).
 */

interface PoSummary {
  id: number;
  number: number;
  purpose: string;
  sources: string | null;
  status: string;
  createdAt: string;
  createdBy: { id: number; email: string };
  lineCount: number;
  trackingCount: number;
  totalCents: number;
  total: string;
}

export function OrdersPage() {
  const [orders, setOrders] = useState<PoSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setOrders(await api<PoSummary[]>("/api/purchase-orders"));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not load purchase orders");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <section>
      <h2>Purchase Orders</h2>
      <p>
        <Link to="/orders/new">New purchase order</Link>
      </p>
      {error && <p className="status-error">{error}</p>}
      {orders === null && !error && <p className="placeholder">Loading…</p>}
      {orders !== null && orders.length === 0 && (
        <p className="placeholder">No purchase orders yet.</p>
      )}
      {orders !== null && orders.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>PO #</th>
              <th>Purpose</th>
              <th>Status</th>
              <th>Lines</th>
              <th>Total</th>
              <th>Tracking</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((po) => (
              <tr key={po.id}>
                <td>
                  <Link to={`/orders/${po.id}`}>#{po.number}</Link>
                </td>
                <td>{po.purpose}</td>
                <td>{po.status}</td>
                <td>{po.lineCount}</td>
                <td>${po.total}</td>
                <td>{po.trackingCount === 0 ? "—" : po.trackingCount}</td>
                <td>
                  {new Date(po.createdAt).toLocaleDateString()} · {po.createdBy.email}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
