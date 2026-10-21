import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { api, apiJson, ApiError } from "../api";
import { Timeline, type TimelineEntry } from "../components/Timeline";

interface PartAttachment {
  id: number;
  batch: { id: number; number: number };
  device: { id: number; model: string };
  price: string;
  addedAt: string;
  addedBy: { id: number; email: string };
  removedAt: string | null;
  removedTo: string | null;
  removalNote: string | null;
  removalReason: string | null;
}

interface PartDetail {
  id: number;
  serial: string;
  status: string;
  statusLabel: string;
  lastCountedAt: string | null;
  createdAt: string;
  intakeSource: string | null;
  // Ticket 23 (Part Price): the part's own price — the effective price
  // (override ?? SKU price) plus the override itself when it has one.
  price: string;
  priceCents: number;
  overrideCents: number | null;
  priceOverridden: boolean;
  sku: {
    id: number;
    name: string;
    kind: "serialized" | "consumable";
    price: string;
    priceStale: boolean;
  };
  events: TimelineEntry[];
}

/** Statuses a user can set directly; Reserved is owned by Batches. */
const SETTABLE_STATUSES = [
  { value: "available", label: "Available" },
  { value: "unavailable", label: "Unavailable" },
  { value: "rma", label: "RMA" },
  { value: "damaged_by_tech", label: "Damaged by Tech" },
  // The server refuses Buyback for non-buybackable SKUs — its refusal is
  // the authority, the option stays visible (ticket 27).
  { value: "buyback", label: "Buyback" },
] as const;

/**
 * A serialized part's page: status, its own price (Part Price, ticket 23 —
 * with the SKU price shown beside it when overridden, and a note-required
 * re-price form), and the full immutable timeline — every intake, status
 * change, price change, and cycle count, with who and when.
 */
export function PartDetailPage() {
  const { serial } = useParams();
  const [part, setPart] = useState<PartDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>("available");
  const [note, setNote] = useState("");
  const [price, setPrice] = useState("");
  const [priceNote, setPriceNote] = useState("");
  const [attachments, setAttachments] = useState<PartAttachment[]>([]);

  const reload = useCallback(async () => {
    try {
      const [loaded, attachmentList] = await Promise.all([
        api<PartDetail>(`/api/parts/${encodeURIComponent(serial ?? "")}`),
        api<{ attachments: PartAttachment[] }>(
          `/api/parts/${encodeURIComponent(serial ?? "")}/attachments`,
        ),
      ]);
      setPart(loaded);
      setStatus(loaded.status);
      setAttachments(attachmentList.attachments);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not load the part");
    }
  }, [serial]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function onStatusChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiJson(`/api/parts/${encodeURIComponent(serial ?? "")}/status`, {
        status,
        note: note.trim(),
      });
      setNotice("Status changed.");
      setNote("");
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
    } finally {
      setBusy(false);
    }
  }

  async function onPriceChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiJson(`/api/parts/${encodeURIComponent(serial ?? "")}/price`, {
        price: price.trim(),
        note: priceNote.trim(),
      });
      setNotice("Price changed.");
      setPrice("");
      setPriceNote("");
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
    } finally {
      setBusy(false);
    }
  }

  if (!part) {
    return (
      <section>
        <h2>Serialized part</h2>
        {error && <p className="status-error">{error}</p>}
      </section>
    );
  }

  return (
    <section>
      <h2>
        {part.serial} — {part.statusLabel}
      </h2>
      {notice && <p className="status-ok">{notice}</p>}
      {error && <p className="status-error">{error}</p>}
      <p>
        <Link to="/inventory">← Inventory</Link> ·{" "}
        <Link to={`/inventory/skus/${part.sku.id}`}>{part.sku.name}</Link> (SKU #{part.sku.id},{" "}
        {part.sku.price}) ·{" "}
        <Link to={`/inventory/labels?ids=${part.id}`}>Print label</Link>
      </p>

      {part.sku.priceStale && (
        <p className="status-error">
          Warning: this SKU's price is old and could be incorrect. It still works normally.
        </p>
      )}

      <dl className="sku-facts">
        <div>
          <dt>Status</dt>
          <dd>{part.statusLabel}</dd>
        </div>
        <div>
          <dt>Price</dt>
          <dd>
            {part.price}
            {part.priceOverridden ? ` (SKU price: ${part.sku.price})` : ""}
          </dd>
        </div>
        <div>
          <dt>Last counted</dt>
          <dd>
            {part.lastCountedAt ? new Date(part.lastCountedAt).toLocaleString() : "Never"}
          </dd>
        </div>
        <div>
          <dt>Added</dt>
          <dd>{new Date(part.createdAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt>Intake source</dt>
          <dd>{part.intakeSource ?? "—"}</dd>
        </div>
      </dl>

      {part.status === "reserved" ? (
        <p className="placeholder">
          Reserved for a Batch.
        </p>
      ) : part.status === "in_transit" ? (
        // Ticket 29: the shipment owns the part — the order's Complete
        // settles it. The bare form (and the server behind it) stay closed.
        <p className="placeholder">
          In-Transit on an open RMA, buyback, or return order — the order screen is the only
          place its status changes next.
        </p>
      ) : (
        <form className="form" onSubmit={onStatusChange}>
          <label>
            New status
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              {SETTABLE_STATUSES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Note (required)
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={2}
              placeholder="why is this changing?"
              required
            />
          </label>
          <button type="submit" disabled={busy}>
            Change status
          </button>
        </form>
      )}

      <h3>Price</h3>
      <p className="placeholder">
        The part's own price.
      </p>
      <form className="form" onSubmit={onPriceChange}>
        <label>
          Price
          <input
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            placeholder={part.priceOverridden ? "currently overridden" : "e.g. 109.99"}
            required
          />
        </label>
        <label>
          Note (required)
          <input
            value={priceNote}
            onChange={(event) => setPriceNote(event.target.value)}
            placeholder="why is the price changing?"
            required
          />
        </label>
        <button type="submit" disabled={busy}>
          Change price
        </button>
      </form>

      <h3>Batch attachments</h3>
      <p className="placeholder">
        Every batch and device this part was attached to — past attachments included.
      </p>
      {attachments.length === 0 ? (
        <p className="placeholder">Never attached to a batch.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Batch</th>
              <th>Device</th>
              <th>Price at reservation</th>
              <th>Reserved</th>
              <th>Removed</th>
            </tr>
          </thead>
          <tbody>
            {attachments.map((attachment) => (
              <tr key={attachment.id} className={attachment.removedAt ? "part-removed" : undefined}>
                <td>
                  <Link to={`/batches/${attachment.batch.id}`}>#{attachment.batch.number}</Link>
                </td>
                <td>
                  {attachment.device.model} (#{attachment.device.id})
                </td>
                <td>{attachment.price}</td>
                <td>
                  {new Date(attachment.addedAt).toLocaleDateString()} by{" "}
                  {attachment.addedBy.email}
                </td>
                <td>
                  {attachment.removedAt
                    ? `${new Date(attachment.removedAt).toLocaleDateString()} → ${
                        attachment.removedTo === "available"
                          ? "Available"
                          : attachment.removedTo === "buyback"
                            ? "Buyback"
                            : attachment.removedTo === "rma"
                              ? "RMA"
                              : attachment.removedTo === "unavailable"
                                ? "Unavailable"
                                : "Damaged by Tech"
                      }${attachment.removalNote ? ` (${attachment.removalNote})` : ""}`
                    : "— still attached"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Timeline</h3>      <Timeline events={part.events} />
    </section>
  );
}
