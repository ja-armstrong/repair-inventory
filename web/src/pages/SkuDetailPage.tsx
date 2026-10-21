import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth";
import { api, apiJson, ApiError } from "../api";
import { SourceText } from "../components/SourceText";
import { Timeline, type TimelineEntry } from "../components/Timeline";

interface PartSummary {
  id: number;
  serial: string;
  status: string;
  statusLabel: string;
  lastCountedAt: string | null;
  createdAt: string;
  intakeSource: string | null;
}

interface SkuDetail {
  id: number;
  name: string;
  kind: "serialized" | "consumable";
  buybackable: boolean;
  price: string;
  priceStale: boolean;
  priceUpdatedAt: string;
  priceExpiresAt: string;
  defaultSourceUrl: string | null;
  /** Minimum on-hand quantity; 0 = no minimum (serialized SKUs only). */
  minOnHand: number;
  parts: PartSummary[];
  events: TimelineEntry[];
}

/**
 * A SKU in detail: price and its expiry state, edits (rename / re-price /
 * kind correction with a required note), deletion for mis-entered SKUs (only
 * while nothing references them — the server refuses otherwise), the
 * manager's price refresh, a link into the intake screen (ticket 13 —
 * one intake flow lives there, not a second form here), the serialized
 * stock list with each part's intake source, and the SKU's own timeline.
 *
 * Ticket 11: the edit form also carries the default source link — a plain
 * field (no note required); the saved value renders clickable on the PO
 * pages when it parses as a web URL.
 */
export function SkuDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [sku, setSku] = useState<SkuDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [kind, setKind] = useState<"serialized" | "consumable">("serialized");
  const [buybackable, setBuybackable] = useState(false);
  // Ticket 11: the default source link — plain field, no note required.
  const [defaultSourceUrl, setDefaultSourceUrl] = useState("");
  // Minimum on-hand quantity — plain field, no note required (like the
  // price: a replenishment setting, not a lifecycle decision). Serialized
  // SKUs only; kept as text so the input stays editable while typing.
  const [minOnHand, setMinOnHand] = useState("0");
  const [kindNote, setKindNote] = useState("");
  const [deleteNote, setDeleteNote] = useState("");
  const [refreshPrice, setRefreshPrice] = useState("");

  const reload = useCallback(async () => {
    try {
      const loaded = await api<SkuDetail>(`/api/skus/${id}`);
      setSku(loaded);
      setName(loaded.name);
      setPrice(loaded.price);
      setKind(loaded.kind);
      setBuybackable(loaded.buybackable);
      setDefaultSourceUrl(loaded.defaultSourceUrl ?? "");
      setMinOnHand(String(loaded.minOnHand));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not load the SKU");
    }
  }, [id]);

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

  function onEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sku) {
      return;
    }
    const body: Record<string, unknown> = { name, price, defaultSourceUrl };
    // Minimum on-hand is serialized-only server-side, so it is only sent for
    // a serialized SKU — and validated here loudly rather than silently
    // skipped when the input is not a whole number.
    if (kind === "serialized") {
      const parsedMin = Number(minOnHand);
      if (minOnHand.trim() === "" || !Number.isInteger(parsedMin) || parsedMin < 0) {
        setError("minimum on-hand must be a whole number of 0 or more");
        return;
      }
      if (parsedMin !== sku.minOnHand) {
        body.minOnHand = parsedMin;
      }
    }
    const noteNeeded = kind !== sku.kind || buybackable !== sku.buybackable;
    if (noteNeeded) {
      if (!kindNote.trim()) {
        setError("a note is required when changing the kind or the buybackable flag");
        return;
      }
      body.note = kindNote.trim();
    }
    if (kind !== sku.kind) {
      body.kind = kind;
    }
    if (buybackable !== sku.buybackable) {
      body.buybackable = buybackable;
    }
    void run(async () => {
      await apiJson(`/api/skus/${id}`, body, "PATCH");
      setKindNote("");
    }, "Saved.");
  }

  function onDelete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!deleteNote.trim()) {
      setError("a note is required to delete a SKU");
      return;
    }
    // Not `run`: after a successful delete there is nothing to reload — the
    // SKU is gone, so go back to the catalog instead.
    void (async () => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await apiJson(`/api/skus/${id}`, { note: deleteNote.trim() }, "DELETE");
        navigate("/inventory");
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "the request failed");
      } finally {
        setBusy(false);
      }
    })();
  }

  function onRefreshPrice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = refreshPrice.trim() ? { price: refreshPrice.trim() } : {};
    void run(
      () => apiJson(`/api/skus/${id}/price-refresh`, body),
      "Price refreshed",
    );
    setRefreshPrice("");
  }

  if (!sku) {
    return (
      <section>
        <h2>SKU</h2>
        {error && <p className="status-error">{error}</p>}
      </section>
    );
  }

  return (
    <section>
      <h2>{sku.name}</h2>
      {notice && <p className="status-ok">{notice}</p>}
      {error && <p className="status-error">{error}</p>}
      <p>
        <Link to="/inventory">← All SKUs</Link>
      </p>

      <dl className="sku-facts">
        <div>
          <dt>Kind</dt>
          <dd>{sku.kind === "serialized" ? "Serialized" : "Consumable"}</dd>
        </div>
        <div>
          <dt>Buybackable</dt>
          <dd>{sku.buybackable ? "Yes" : "No"}</dd>
        </div>
        <div>
          <dt>Price</dt>
          <dd>{sku.price}</dd>
        </div>
        <div>
          <dt>Price state</dt>
          <dd>
            {sku.priceStale ? (
              <span className="status-error">
                Stale — expired {new Date(sku.priceExpiresAt).toLocaleDateString()}
              </span>
            ) : (
              <>Fresh until {new Date(sku.priceExpiresAt).toLocaleDateString()}</>
            )}
          </dd>
        </div>
        <div>
          <dt>Price last set</dt>
          <dd>{new Date(sku.priceUpdatedAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt>Default source link</dt>
          <dd>
            {/* Ticket 11: clickable when it parses as a web URL, plain text
                otherwise (the shared SourceText / urlHref decision). */}
            <SourceText text={sku.defaultSourceUrl} blank="None" />
          </dd>
        </div>
        {sku.kind === "serialized" && (
          <div>
            <dt>Minimum on-hand</dt>
            <dd>{sku.minOnHand === 0 ? "None" : sku.minOnHand}</dd>
          </div>
        )}
      </dl>

      <form className="form" onSubmit={onEdit}>
        <label>
          Name
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        <label>
          Price (USD)
          <input value={price} onChange={(event) => setPrice(event.target.value)} required />
        </label>
        <label>
          Default source link
          <input
            value={defaultSourceUrl}
            onChange={(event) => setDefaultSourceUrl(event.target.value)}
            placeholder="e.g. source.com/part — pre-fills PO lines and Need to Order"
          />
        </label>
        <label>
          Kind
          <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
            <option value="serialized">Serialized — each unit has a serial</option>
            <option value="consumable">Consumable — tracked by cost only</option>
          </select>
        </label>
        {kind === "serialized" && (
          <>
            <label className="form-checkbox">
              <input
                type="checkbox"
                checked={buybackable}
                onChange={(event) => setBuybackable(event.target.checked)}
              />
              Buybackable
            </label>
            <label>
              Minimum on-hand quantity
              <input
                type="number"
                min={0}
                step={1}
                value={minOnHand}
                onChange={(event) => setMinOnHand(event.target.value)}
              />
              <span className="placeholder">
                When the available stock drops below this, the purchase-order form lists the SKU
                with the shortfall.
              </span>
            </label>
          </>
        )}
        {(sku.kind !== kind || sku.buybackable !== buybackable) && (
          <label>
            Note
            <input
              value={kindNote}
              onChange={(event) => setKindNote(event.target.value)}
              placeholder="entered as consumable by mistake"
              required
            />
          </label>
        )}
        <button type="submit" disabled={busy}>
          Save changes
        </button>
      </form>

      <form className="form" onSubmit={onDelete}>
        <p className="placeholder">
          Deleting is only possible while nothing references the SKU.
        </p>
        <label>
          Note
          <input
            value={deleteNote}
            onChange={(event) => setDeleteNote(event.target.value)}
            placeholder=""
          />
        </label>
        <button type="submit" disabled={busy} className="danger">
          Delete SKU
        </button>
      </form>

      {user?.role === "manager" && sku.priceStale && (
        <form className="form" onSubmit={onRefreshPrice}>
          <p className="status-error">
            This price is stale.
          </p>
          <label>
            Refreshed price (leave blank to keep {sku.price})
            <input
              value={refreshPrice}
              onChange={(event) => setRefreshPrice(event.target.value)}
              placeholder={sku.price}
            />
          </label>
          <button type="submit" disabled={busy}>
            Refresh price
          </button>
        </form>
      )}

      {sku.kind === "serialized" && (
        <>
          <p>
            <Link to={`/inventory/intake?sku=${sku.id}`}>Add serialized parts (intake) →</Link>
          </p>

          <table className="table">
            <thead>
              <tr>
                <th>Serial</th>
                <th>Status</th>
                <th>Last counted</th>
                <th>Added</th>
                <th>Intake source</th>
              </tr>
            </thead>
            <tbody>
              {sku.parts.map((part) => (
                <tr key={part.id}>
                  <td>
                    <Link to={`/inventory/parts/${part.serial}`}>{part.serial}</Link>
                  </td>
                  <td>{part.statusLabel}</td>
                  <td>
                    {part.lastCountedAt
                      ? new Date(part.lastCountedAt).toLocaleDateString()
                      : "Never"}
                  </td>
                  <td>{new Date(part.createdAt).toLocaleDateString()}</td>
                  <td>{part.intakeSource ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3>Timeline</h3>
      <Timeline events={sku.events} />
    </section>
  );
}
