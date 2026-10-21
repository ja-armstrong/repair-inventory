import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, apiJson, ApiError } from "../api";
import { searchSkus } from "../skuSearch";

interface Sku {
  id: number;
  name: string;
  kind: "serialized" | "consumable";
  price: string;
  priceStale: boolean;
  priceExpiresAt: string;
  availableCount: number | null;
}

/**
 * The parts catalog: every SKU with its price and price-expiry state, plus
 * the form that creates new ones (any signed-in user — techs included). A
 * serial lookup box jumps straight to a serialized part's history.
 *
 * Ticket 11: the create form carries the optional default source link —
 * one free-text vendor link per SKU that pre-fills new PO lines and Need
 * to Order suppliers. Free text, never validated here; clickability is
 * decided at read time.
 */
export function InventoryPage() {
  const navigate = useNavigate();
  const [skus, setSkus] = useState<Sku[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [kind, setKind] = useState<"serialized" | "consumable">("serialized");
  const [defaultSourceUrl, setDefaultSourceUrl] = useState("");
  const [serialLookup, setSerialLookup] = useState("");
  // The catalog search: the SAME fuzzy matcher the pickers use (one ranking
  // module), live-filtering the table — both SKU kinds included.
  const [search, setSearch] = useState("");
  const visibleSkus = useMemo(() => searchSkus(search, skus), [search, skus]);

  const reload = useCallback(async () => {
    try {
      setSkus(await api<Sku[]>("/api/skus"));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not load SKUs");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function onCreateSku(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiJson("/api/skus", {
        name,
        price,
        kind,
        defaultSourceUrl: defaultSourceUrl.trim() === "" ? undefined : defaultSourceUrl,
      });
      setNotice(`Created ${name}.`);
      setName("");
      setPrice("");
      setDefaultSourceUrl("");
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
    } finally {
      setBusy(false);
    }
  }

  function onLookupSerial(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const serial = serialLookup.trim().toUpperCase();
    if (serial) {
      navigate(`/inventory/parts/${encodeURIComponent(serial)}`);
    }
  }

  return (
    <section>
      <h2>Inventory</h2>
      {notice && <p className="status-ok">{notice}</p>}
      {error && <p className="status-error">{error}</p>}

      <form className="form" onSubmit={onCreateSku}>
        <label>
          Name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="iPhone 13 Screen"
            required
          />
        </label>
        <label>
          Price (USD)
          <input
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            placeholder="109.99"
            required
          />
        </label>
        <label>
          Kind
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as "serialized" | "consumable")}
          >
            <option value="serialized">Serialized</option>
            <option value="consumable">Consumable</option>
          </select>
        </label>
        <label>
          Default source link (optional)
          <input
            value={defaultSourceUrl}
            onChange={(event) => setDefaultSourceUrl(event.target.value)}
            placeholder="e.g. source.com/part — pre-fills PO lines and Need to Order"
          />
        </label>
        <button type="submit" disabled={busy}>
          Add SKU
        </button>
      </form>

      <form className="form" onSubmit={onLookupSerial}>
        <label>
          Look up a serial
          <input
            value={serialLookup}
            onChange={(event) => setSerialLookup(event.target.value)}
            placeholder="P00001"
          />
        </label>
        <button type="submit">Go to part</button>
      </form>

      <label>
        Search SKUs
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Type to filter the catalog — serialized and consumable alike…"
        />
      </label>

      <table className="table">
        <thead>
          <tr>
            <th>SKU #</th>
            <th>Name</th>
            <th>Kind</th>
            <th>Price</th>
            <th>Price state</th>
            <th>Available</th>
          </tr>
        </thead>
        <tbody>
          {visibleSkus.map((sku) => (
            <tr key={sku.id}>
              <td>#{sku.id}</td>
              <td>
                <Link to={`/inventory/skus/${sku.id}`}>{sku.name}</Link>
              </td>
              <td>{sku.kind === "serialized" ? "Serialized" : "Consumable"}</td>
              <td>{sku.price}</td>
              <td>
                {sku.priceStale ? (
                  <span className="status-error">
                    Stale — expired {new Date(sku.priceExpiresAt).toLocaleDateString()}
                  </span>
                ) : (
                  <span>
                    Fresh until {new Date(sku.priceExpiresAt).toLocaleDateString()}
                  </span>
                )}
              </td>
              <td>{sku.availableCount === null ? "—" : sku.availableCount}</td>
            </tr>
          ))}
          {visibleSkus.length === 0 && skus.length > 0 && (
            <tr>
              <td colSpan={6} className="placeholder">
                No SKU matches “{search.trim()}”.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
