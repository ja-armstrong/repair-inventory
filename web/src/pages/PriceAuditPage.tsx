import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth";
import { api, apiJson, ApiError } from "../api";

interface AuditSku {
  id: number;
  name: string;
  kind: "serialized" | "consumable";
  price: string;
  daysStale: number;
  priceUpdatedAt: string;
}

interface AuditQueue {
  priceExpiryDays: number;
  skus: AuditSku[];
}

interface Settings {
  price_expiry_days: number;
  audit_interval_months: number;
}

/**
 * The manager's price-audit queue: every SKU whose price has expired, with
 * a refresh action that re-dates the price (optionally updating it). The
 * app settings that drive expiry (and later, audit cadence) are edited
 * here too. Techs never see this page in the nav.
 */
export function PriceAuditPage() {
  const { user } = useAuth();
  const [queue, setQueue] = useState<AuditQueue | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [refreshPrices, setRefreshPrices] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setQueue(await api<AuditQueue>("/api/price-audit"));
      setSettings(await api<Settings>("/api/settings"));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not load the price-audit queue");
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

  function onRefresh(sku: AuditSku) {
    const price = (refreshPrices[sku.id] ?? "").trim();
    void run(
      () => apiJson(`/api/skus/${sku.id}/price-refresh`, price ? { price } : {}),
      `Refreshed ${sku.name}.`,
    );
  }

  function onSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings) {
      return;
    }
    void run(async () => {
      await apiJson("/api/settings", { key: "price_expiry_days", value: settings.price_expiry_days }, "PATCH");
      await apiJson("/api/settings", { key: "audit_interval_months", value: settings.audit_interval_months }, "PATCH");
    }, "Settings saved.");
  }

  if (user && user.role !== "manager") {
    return (
      <section>
        <h2>Price audit</h2>
        <p className="status-error">The price-audit queue is manager-only.</p>
      </section>
    );
  }

  return (
    <section>
      <h2>Price audit</h2>
      {notice && <p className="status-ok">{notice}</p>}
      {error && <p className="status-error">{error}</p>}
      {queue && (
        <p className="placeholder">
          Prices go stale {queue.priceExpiryDays} days after their last set or refresh.
        </p>
      )}

      <table className="table">
        <thead>
          <tr>
            <th>SKU</th>
            <th>Price</th>
            <th>Days stale</th>
            <th>Last set</th>
            <th>Refresh</th>
          </tr>
        </thead>
        <tbody>
          {queue?.skus.map((sku) => (
            <tr key={sku.id}>
              <td>
                <Link to={`/inventory/skus/${sku.id}`}>{sku.name}</Link>
              </td>
              <td>{sku.price}</td>
              <td>{sku.daysStale}</td>
              <td>{new Date(sku.priceUpdatedAt).toLocaleDateString()}</td>
              <td className="table-actions">
                <input
                  size={8}
                  value={refreshPrices[sku.id] ?? ""}
                  onChange={(event) =>
                    setRefreshPrices((previous) => ({ ...previous, [sku.id]: event.target.value }))
                  }
                  placeholder={sku.price}
                  aria-label={`Refreshed price for ${sku.name}`}
                />
                <button type="button" disabled={busy} onClick={() => onRefresh(sku)}>
                  Refresh
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {queue && queue.skus.length === 0 && (
        <p className="status-ok">No stale prices.</p>
      )}

      {settings && (
        <form className="form" onSubmit={onSettings}>
          <h3>Settings</h3>
          <label>
            Price expiry (days)
            <input
              type="number"
              min={1}
              value={settings.price_expiry_days}
              onChange={(event) =>
                setSettings({ ...settings, price_expiry_days: Number(event.target.value) })
              }
              required
            />
          </label>
          <label>
            Audit interval (months)
            <input
              type="number"
              min={1}
              value={settings.audit_interval_months}
              onChange={(event) =>
                setSettings({ ...settings, audit_interval_months: Number(event.target.value) })
              }
              required
            />
          </label>
          <button type="submit" disabled={busy}>
            Save settings
          </button>
        </form>
      )}
    </section>
  );
}
