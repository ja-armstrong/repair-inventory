import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api";

/**
 * Search results (ticket 11). The one search box lives in the navigation
 * (AppLayout); this page renders the grouped results it lands on. The
 * server owns the match semantics and the scan-first rule: an exact
 * serial response carries `directHit`, and this page redirects to the
 * part's page instead of showing results — scanning lands on the part.
 */

interface SkuHit {
  id: number;
  name: string;
  kind: "serialized" | "consumable";
  price: string;
  priceCents: number;
}

interface PartHit {
  id: number;
  serial: string;
  status: string;
  skuId: number;
  skuName: string;
}

interface DeviceHit {
  id: number;
  batchId: number;
  batchNumber: number;
  model: string;
  imei: string | null;
  assetId: string | null;
  serialNumber: string | null;
  repairStatus: string;
  assignedTechId: number;
  assignedTechEmail: string;
}

interface BatchHit {
  id: number;
  number: number;
  createdAt: string;
  createdByEmail: string;
  deviceTotal: number;
}

interface OrderHit {
  id: number;
  number: number;
  status: string;
  createdAt: string;
  createdByEmail: string;
}

interface RmaHit extends OrderHit {
  statusLabel: string;
}

interface SearchBody {
  query: string;
  userId: number | null;
  directHit: { type: "part"; id: number; serial: string; skuId: number } | null;
  filterUsers: Array<{ id: number; email: string }>;
  results: {
    skus: SkuHit[];
    parts: PartHit[];
    devices: DeviceHit[];
    batches: BatchHit[];
    purchaseOrders: OrderHit[];
    rmaOrders: RmaHit[];
    buybackOrders: RmaHit[];
    returnOrders: RmaHit[];
  };
}

const PART_STATUS_LABELS: Record<string, string> = {
  available: "Available",
  reserved: "Reserved",
  unavailable: "Unavailable",
  rma: "RMA",
  damaged_by_tech: "Damaged by Tech",
  buyback: "Buyback",
  in_transit: "In-Transit",
};

function deviceIdentifiers(device: DeviceHit): string {
  return [device.imei, device.assetId, device.serialNumber].filter(Boolean).join(" · ");
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const q = params.get("q") ?? "";
  const userId = params.get("userId") ?? "";
  const [body, setBody] = useState<SearchBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (q === "") {
      setBody(null);
      setError(null);
      return;
    }
    setLoading(true);
    const suffix = userId === "" ? "" : `&userId=${encodeURIComponent(userId)}`;
    api<SearchBody>(`/api/search?q=${encodeURIComponent(q)}${suffix}`)
      .then((result) => {
        if (!cancelled) {
          setBody(result);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setBody(null);
          setError(err instanceof ApiError ? err.message : "the request failed");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [q, userId]);

  // Scan-first (server-decided via directHit): an exact serial lands on the
  // part's page. `replace` keeps the back button on the page before search.
  useEffect(() => {
    if (body?.directHit?.type === "part") {
      navigate(`/inventory/parts/${encodeURIComponent(body.directHit.serial)}`, { replace: true });
    }
  }, [body, navigate]);

  function setUserFilter(next: string) {
    // The query stays; only the filter changes — one URL per search state.
    setParams(next === "" ? { q } : { q, userId: next });
  }

  if (q === "") {
    return (
      <section>
        <h2>Search</h2>
        <p className="placeholder">Search for SKUs, part serials, device identifiers, or batch/PO/RMA/buyback numbers in the box above.</p>
      </section>
    );
  }

  if (body === null) {
    return (
      <section>
        <h2>Search</h2>
        {error ? <p className="status-error">{error}</p> : <p className="placeholder">{loading ? "Searching…" : "Searching…"}</p>}
      </section>
    );
  }

  const { results } = body;
  const empty =
    results.skus.length === 0 &&
    results.parts.length === 0 &&
    results.devices.length === 0 &&
    results.batches.length === 0 &&
    results.purchaseOrders.length === 0 &&
    results.rmaOrders.length === 0 &&
    results.buybackOrders.length === 0 &&
    results.returnOrders.length === 0;

  return (
    <section>
      <h2>Search results</h2>
      <p className="search-summary">
        Results for <strong>{body.query}</strong>
        <label className="search-user-filter">
          {" "}
          by user{" "}
          <select value={userId} onChange={(event) => setUserFilter(event.target.value)}>
            <option value="">All users</option>
            {body.filterUsers.map((user) => (
              <option key={user.id} value={user.id}>
                {user.email}
              </option>
            ))}
          </select>
        </label>
      </p>
      {error && <p className="status-error">{error}</p>}
      {loading && <p className="placeholder">Searching…</p>}

      {empty && !loading && <p className="placeholder">No results.</p>}

      {results.skus.length > 0 && (
        <>
          <h3>SKUs</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Price</th>
              </tr>
            </thead>
            <tbody>
              {results.skus.map((sku) => (
                <tr key={sku.id}>
                  <td>
                    <Link to={`/inventory/skus/${sku.id}`}>{sku.name}</Link>
                  </td>
                  <td>{sku.kind}</td>
                  <td>{sku.price}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {results.parts.length > 0 && (
        <>
          <h3>Parts</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Serial</th>
                <th>SKU</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {results.parts.map((part) => (
                <tr key={part.id}>
                  <td>
                    <Link to={`/inventory/parts/${encodeURIComponent(part.serial)}`}>{part.serial}</Link>
                  </td>
                  <td>
                    <Link to={`/inventory/skus/${part.skuId}`}>{part.skuName}</Link>
                  </td>
                  <td>{PART_STATUS_LABELS[part.status] ?? part.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {results.devices.length > 0 && (
        <>
          <h3>Devices (one row per batch the device appeared on)</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Identifiers</th>
                <th>Model</th>
                <th>Batch</th>
                <th>Repair status</th>
                <th>Assigned tech</th>
              </tr>
            </thead>
            <tbody>
              {results.devices.map((device) => (
                <tr key={device.id}>
                  <td>{deviceIdentifiers(device)}</td>
                  <td>{device.model}</td>
                  <td>
                    <Link to={`/batches/${device.batchId}`}>#{device.batchNumber}</Link>
                  </td>
                  <td>{device.repairStatus}</td>
                  <td>{device.assignedTechEmail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {results.batches.length > 0 && (
        <>
          <h3>Batches</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Batch</th>
                <th>Devices</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {results.batches.map((batch) => (
                <tr key={batch.id}>
                  <td>
                    <Link to={`/batches/${batch.id}`}>#{batch.number}</Link>
                  </td>
                  <td>{batch.deviceTotal}</td>
                  <td>
                    {new Date(batch.createdAt).toLocaleDateString()} · {batch.createdByEmail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {results.purchaseOrders.length > 0 && (
        <>
          <h3>Purchase orders</h3>
          <table className="table">
            <thead>
              <tr>
                <th>PO</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {results.purchaseOrders.map((po) => (
                <tr key={po.id}>
                  <td>
                    <Link to={`/orders/${po.id}`}>#{po.number}</Link>
                  </td>
                  <td>{po.status}</td>
                  <td>
                    {new Date(po.createdAt).toLocaleDateString()} · {po.createdByEmail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {results.rmaOrders.length > 0 && (
        <>
          <h3>RMA orders</h3>
          <table className="table">
            <thead>
              <tr>
                <th>RMA order</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {results.rmaOrders.map((order) => (
                <tr key={order.id}>
                  <td>
                    <Link to={`/rma/${order.id}`}>#{order.number}</Link>
                  </td>
                  <td>{order.statusLabel}</td>
                  <td>
                    {new Date(order.createdAt).toLocaleDateString()} · {order.createdByEmail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {results.buybackOrders.length > 0 && (
        <>
          <h3>Buyback orders</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Buyback order</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {results.buybackOrders.map((order) => (
                <tr key={order.id}>
                  <td>
                    <Link to={`/buyback/${order.id}`}>#{order.number}</Link>
                  </td>
                  <td>{order.statusLabel}</td>
                  <td>
                    {new Date(order.createdAt).toLocaleDateString()} · {order.createdByEmail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {results.returnOrders.length > 0 && (
        <>
          <h3>Return orders</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Return order</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {results.returnOrders.map((order) => (
                <tr key={order.id}>
                  <td>
                    <Link to={`/rma/returns/${order.id}`}>#{order.number}</Link>
                  </td>
                  <td>{order.statusLabel}</td>
                  <td>
                    {new Date(order.createdAt).toLocaleDateString()} · {order.createdByEmail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
