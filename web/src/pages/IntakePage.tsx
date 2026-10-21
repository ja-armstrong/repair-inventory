import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, apiJson, ApiError } from "../api";
import { SkuPicker, type SkuPickerOption } from "../components/SkuPicker";

/**
 * The intake screen (ticket 13): parts entering inventory outside a purchase
 * order. Two flows, one endpoint (POST /api/skus/:id/parts with a source):
 * - Migration — bulk-add pre-existing shelf stock. "Physically counted now"
 *   is checked by default: confirming sets each part's last-counted date
 *   through the same mechanism a cycle count uses, so the next audit does
 *   not demand the whole back room. Unchecking leaves them uncounted — the
 *   first audit will demand them.
 * - Salvage — one part with a REQUIRED provenance note (what it came off,
 *   why it exists).
 *
 * Both flows accept an optional per-part price (ticket 23, Part Price): the
 * part's own price when it differs from the SKU's catalog price (e.g. an
 * eBay-sourced unit); left blank, the part follows the SKU price.
 *
 * Ticket 10: an intake is an intake — when the SKU has outstanding Need to
 * Order demand, each part auto-reserves FIFO onto the oldest demand and the
 * result shows where it went ("Reserved to Batch #N — device …"). A refused
 * attachment (e.g. a Closed batch) is surfaced loudly; the part simply stays
 * Available.
 *
 * Both flows end with the print-labels action: the freshly added parts get
 * scannable serials via the shared label sheet. Intake serials are
 * system-assigned, so scanning starts after the labels print — the SKU field
 * is autofocused for keyboard/scan-gun-driven entry.
 */

interface IntakePart {
  id: number;
  serial: string;
  intakeSource: string;
  /** Ticket 10: the arrival record — which demand took the part and where. */
  reserved?: boolean;
  reservationRefusal?: string | null;
  demandId?: number | null;
  batchNumber?: number | null;
  deviceId?: number | null;
  deviceLabel?: string | null;
}

type Flow = "migration" | "salvage";

export function IntakePage() {
  const [searchParams] = useSearchParams();
  const [skus, setSkus] = useState<SkuPickerOption[]>([]);
  const [flow, setFlow] = useState<Flow>("migration");
  const [skuId, setSkuId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [counted, setCounted] = useState(true);
  const [note, setNote] = useState("");
  const [price, setPrice] = useState("");
  const [added, setAdded] = useState<IntakePart[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      // The whole catalog goes to the picker; it filters to serialized SKUs.
      const all = await api<SkuPickerOption[]>("/api/skus");
      setSkus(all);
      const serialized = all.filter((sku) => sku.kind === "serialized");
      // ?sku=<id> deep-links from a SKU page (or a scanner-friendly bookmark).
      const preselect = searchParams.get("sku");
      if (preselect && serialized.some((sku) => String(sku.id) === preselect)) {
        setSkuId(preselect);
      } else if (serialized.length > 0) {
        setSkuId((current) => current || String(serialized[0].id));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not load SKUs");
    }
  }, [searchParams]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function onIntake(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!skuId) {
      setError("create a serialized SKU first. intake adds parts to a SKU");
      return;
    }
    setBusy(true);
    setError(null);
    setAdded(null);
    const body =
      flow === "migration"
        ? {
            source: "migration",
            quantity: Number(quantity),
            counted,
            ...(note.trim() ? { note: note.trim() } : {}),
            ...(price.trim() ? { price: price.trim() } : {}),
          }
        : {
            source: "salvage",
            note: note.trim(),
            ...(price.trim() ? { price: price.trim() } : {}),
          };
    try {
      const response = await apiJson<{ parts: IntakePart[] }>(`/api/skus/${skuId}/parts`, body);
      setAdded(response.parts);
      setNote("");
      setPrice("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
    } finally {
      setBusy(false);
    }
  }

  const labelLink = added ? `/inventory/labels?ids=${added.map((part) => part.id).join(",")}` : null;

  return (
    <section>
      <h2>Intake</h2>
      <p className="placeholder">
        Add serialized parts without a purchase order.
      </p>
      {error && <p className="status-error">{error}</p>}

      <div className="form" style={{ flexDirection: "row", maxWidth: "none", alignItems: "end" }}>
        <label>
          Flow
          <select
            value={flow}
            onChange={(event) => {
              setFlow(event.target.value as Flow);
              setAdded(null);
            }}
          >
            <option value="migration">Migration (bulk shelf stock)</option>
            <option value="salvage">Salvage</option>
          </select>
        </label>
      </div>

      <form className="form" onSubmit={onIntake}>
        <label>
          SKU
          <SkuPicker
            skus={skus}
            kind="serialized"
            value={skuId}
            onChange={setSkuId}
            autoFocus
            allowCreate
            onCreated={(sku) => setSkus((all) => [...all, sku])}
            placeholder="Type to search serialized SKUs…"
            emptyMessage="No serialized SKUs yet"
          />
        </label>

        {flow === "migration" ? (
          <>
            <label>
              Quantity
              <input
                type="number"
                min={1}
                max={200}
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                required
              />
            </label>
            <label className="form-checkbox">
              <input
                type="checkbox"
                checked={counted}
                onChange={(event) => setCounted(event.target.checked)}
              />
              Physically counted now (leaving this off means the first audit will demand these
              parts)
            </label>
          </>
        ) : null}

        <label>
          Price (optional per-unit price, leave blank to use SKU default)
          <input
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            placeholder=""
          />
        </label>

        <label>
          {flow === "salvage" ? "Provenance (required — what did it come off, why does it exist?)" : "Note (optional)"}
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={flow === "salvage" ? "" : "initial stock"}
            required={flow === "salvage"}
          />
        </label>

        <button type="submit" disabled={busy}>
          {flow === "salvage" ? "Add salvaged part" : `Add ${quantity} part${Number(quantity) === 1 ? "" : "s"}`}
        </button>
      </form>

      {added && (
        <div className="status-ok">
          <p>
            Added {added.length} serialized part{added.length === 1 ? "" : "s"} — intake source{" "}
            {added[0].intakeSource}:{" "}
            {added.map((part) => part.serial).join(", ")}
          </p>
          {/* Ticket 10: where each part went. Visible, not blocking — the
              intake result stays a success even when a demand's batch refused
              the attachment. */}
          {added.some((part) => part.reserved) && (
            <p>
              Reserved:{" "}
              {added
                .filter((part) => part.reserved)
                .map((part) => `Reserved to Batch #${part.batchNumber} — device ${part.deviceLabel ?? `#${part.deviceId}`}`)
                .join("; ")}
            </p>
          )}
          {added.some((part) => part.reservationRefusal) && (
            <p className="status-error">
              {added
                .filter((part) => part.reservationRefusal)
                .map((part) => `${part.serial}: ${part.reservationRefusal}`)
                .join("; ")}
            </p>
          )}
          {labelLink && (
            <p>
              <Link to={labelLink}>Print labels for these parts</Link>
            </p>
          )}
        </div>
      )}
    </section>
  );
}
