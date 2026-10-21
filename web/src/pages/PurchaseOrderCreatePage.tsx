import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, apiJson, ApiError } from "../api";
import { PoLineFields, type PoLineDraft } from "../components/PoLineFields";
import type { SkuPickerOption } from "../components/SkuPicker";
import { SourceText } from "../components/SourceText";
import { prefillLineSource } from "../sourceLink";

/**
 * PO create (ticket 07): purpose and sources as free text with suggestions
 * from history (datalists fed by the suggestions endpoint), lines of
 * SKU/quantity/unit price, shipping cost, tracking entries, and the
 * required opening note.
 *
 * The demand prompt lists outstanding Need to Order records (ticket 05);
 * each selected record pre-fills a line — SKU, the record's supplier link
 * as the line source, the SKU price as the offered unit price — and is
 * marked ordered by the server once the PO is created, so it stops
 * appearing as outstanding.
 *
 * Below the demand records, the prompt lists serialized SKUs whose on-hand
 * stock (their Available count) sits below the SKU's minimum on-hand
 * quantity: selecting one adds a line whose quantity is the shortfall, so
 * one click orders the stock back up to the minimum. The row stays listed
 * until receiving lifts the stock — it is a prompt, not a tracked order.
 *
 * Ticket 11: the line's source prefill prefers the SKU's default source
 * link over the demand record's supplier (the SKU is where "where do we buy
 * this" lives); picking a SKU manually pre-fills the source the same way.
 * The default is a convenience — the field stays editable.
 */

interface Suggestions {
  purposes: string[];
  sources: string[];
}

interface DemandGroup {
  /** One row per SKU: the demand records are unit-grain, grouped for display. */
  skuId: number;
  skuName: string;
  /** How many units are needed (the underlying records' count). */
  quantity: number;
  /** The underlying Need to Order record ids — linking a line marks them ALL ordered. */
  demandIds: number[];
  batchIds: number[];
  /** First non-null supplier of the group (line-source prefill fallback). */
  supplier: string | null;
  /** Ticket 11: the SKU's default source link — the preferred line-source prefill. */
  defaultSourceUrl: string | null;
}

/**
 * A serialized SKU whose on-hand stock is below its minimum on-hand quantity
 * (the server's one definition, parts/stock.ts). The shortfall is the
 * suggested line quantity — ordering it lifts the stock back to the minimum.
 */
interface LowStockSku {
  skuId: number;
  skuName: string;
  availableCount: number;
  minOnHand: number;
  shortfall: number;
}

interface TrackingDraft {
  key: string;
  carrier: string;
  trackingNumber: string;
}

let draftCounter = 0;
function nextKey(): string {
  draftCounter += 1;
  return `draft-${draftCounter}`;
}

const emptyForm = {
  purpose: "",
  sources: "",
  shippingCost: "",
  note: "",
};

export function PurchaseOrderCreatePage() {
  const navigate = useNavigate();
  const [skus, setSkus] = useState<SkuPickerOption[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestions>({ purposes: [], sources: [] });
  const [demand, setDemand] = useState<DemandGroup[]>([]);
  const [lowStock, setLowStock] = useState<LowStockSku[]>([]);
  const [selectedDemand, setSelectedDemand] = useState<Set<number>>(new Set());
  const [selectedLowStock, setSelectedLowStock] = useState<Set<number>>(new Set());
  const [lines, setLines] = useState<PoLineDraft[]>([]);
  const [tracking, setTracking] = useState<TrackingDraft[]>([]);
  const [form, setForm] = useState({ ...emptyForm });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [skuList, suggestionList, demandList] = await Promise.all([
        api<SkuPickerOption[]>("/api/skus"),
        api<Suggestions>("/api/purchase-orders/suggestions"),
        api<{ demand: DemandGroup[]; lowStock: LowStockSku[] }>("/api/purchase-orders/demand"),
      ]);
      setSkus(skuList);
      setSuggestions(suggestionList);
      setDemand(demandList.demand);
      setLowStock(demandList.lowStock);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not load the order form inputs");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const skuById = useMemo(() => new Map(skus.map((sku) => [sku.id, sku])), [skus]);
  // A SKU created inline in a line's picker is selected in the same event in
  // which it is created — the memoized catalog map still lags one render, so
  // the created row is kept here for the price prefill (ticket 24).
  const createdSkusRef = useRef(new Map<number, SkuPickerOption>());

  function skuFor(skuId: string): SkuPickerOption | undefined {
    return skuById.get(Number(skuId)) ?? createdSkusRef.current.get(Number(skuId));
  }

  function addLine(): void {
    setLines((current) => [
      ...current,
      { key: nextKey(), skuId: "", quantity: "1", unitPrice: "", source: "", demandIds: [] },
    ]);
  }

  function addTracking(): void {
    setTracking((current) => [
      ...current,
      { key: nextKey(), carrier: "", trackingNumber: "" },
    ]);
  }

  // Selection is per GROUP (one row per SKU, key = skuId). Selecting a group
  // appends ONE pre-filled line covering all its demand records; deselecting
  // removes the lines that carry them.
  function toggleDemand(group: DemandGroup): void {
    const willSelect = !selectedDemand.has(group.skuId);
    const next = new Set(selectedDemand);
    if (willSelect) {
      next.add(group.skuId);
    } else {
      next.delete(group.skuId);
    }
    setSelectedDemand(next);

    if (!willSelect) {
      setLines((rows) =>
        rows.filter((line) => !line.demandIds.some((id) => group.demandIds.includes(id))),
      );
    } else {
      const sku = skuById.get(group.skuId) ?? createdSkusRef.current.get(group.skuId);
      setLines((rows) => [
        ...rows,
        {
          key: nextKey(),
          skuId: String(group.skuId),
          quantity: String(group.quantity),
          unitPrice: sku?.price ?? "",
          // Ticket 11: the SKU's default link is the preferred prefill; the
          // demand record's supplier is the fallback.
          source: prefillLineSource({
            skuDefaultSourceUrl: group.defaultSourceUrl,
            demandSupplier: group.supplier,
          }),
          demandIds: group.demandIds,
        },
      ]);
    }
  }

  // Select-all: every group in one click, so the user need not tick each
  // row. Selecting appends one line per group (same as clicking each
  // checkbox); when everything is already selected, the click clears the
  // selection and removes the demand-linked lines — and only those: lines
  // the user added by hand or from the below-minimum list stay.
  const allDemandSelected =
    demand.length > 0 && demand.every((group) => selectedDemand.has(group.skuId));

  function toggleAllDemand(): void {
    if (allDemandSelected) {
      setSelectedDemand(new Set());
      setLines((rows) =>
        rows.filter((line) => line.demandIds.length === 0 && line.lowStockSkuId === undefined),
      );
      return;
    }
    const next = new Set(selectedDemand);
    const newLines: PoLineDraft[] = [];
    for (const group of demand) {
      if (next.has(group.skuId)) {
        continue;
      }
      next.add(group.skuId);
      const sku = skuById.get(group.skuId) ?? createdSkusRef.current.get(group.skuId);
      newLines.push({
        key: nextKey(),
        skuId: String(group.skuId),
        quantity: String(group.quantity),
        unitPrice: sku?.price ?? "",
        // Ticket 11: SKU default link first, demand supplier as fallback.
        source: prefillLineSource({
          skuDefaultSourceUrl: group.defaultSourceUrl,
          demandSupplier: group.supplier,
        }),
        demandIds: group.demandIds,
      });
    }
    setSelectedDemand(next);
    setLines((rows) => [...rows, ...newLines]);
  }

  // The below-minimum list works like the demand prompt: selecting a row
  // appends ONE line — SKU, the shortfall as the quantity, the SKU price and
  // default source link as the prefills — and selecting again removes it.
  // No demand ids ride along: a minimum is not a Need to Order record, so
  // receipt fulfills nothing beyond the received stock itself.
  function toggleLowStock(entry: LowStockSku): void {
    const willSelect = !selectedLowStock.has(entry.skuId);
    const next = new Set(selectedLowStock);
    if (willSelect) {
      next.add(entry.skuId);
    } else {
      next.delete(entry.skuId);
    }
    setSelectedLowStock(next);

    if (!willSelect) {
      setLines((rows) => rows.filter((line) => line.lowStockSkuId !== entry.skuId));
      return;
    }
    const sku = skuById.get(entry.skuId) ?? createdSkusRef.current.get(entry.skuId);
    setLines((rows) => [
      ...rows,
      {
        key: nextKey(),
        skuId: String(entry.skuId),
        quantity: String(entry.shortfall),
        unitPrice: sku?.price ?? "",
        source: prefillLineSource({ skuDefaultSourceUrl: sku?.defaultSourceUrl, demandSupplier: null }),
        demandIds: [],
        lowStockSkuId: entry.skuId,
      },
    ]);
  }

  const allLowStockSelected =
    lowStock.length > 0 && lowStock.every((entry) => selectedLowStock.has(entry.skuId));

  function toggleAllLowStock(): void {
    if (allLowStockSelected) {
      setSelectedLowStock(new Set());
      setLines((rows) => rows.filter((line) => line.lowStockSkuId === undefined));
      return;
    }
    const next = new Set(selectedLowStock);
    const newLines: PoLineDraft[] = [];
    for (const entry of lowStock) {
      if (next.has(entry.skuId)) {
        continue;
      }
      next.add(entry.skuId);
      const sku = skuById.get(entry.skuId) ?? createdSkusRef.current.get(entry.skuId);
      newLines.push({
        key: nextKey(),
        skuId: String(entry.skuId),
        quantity: String(entry.shortfall),
        unitPrice: sku?.price ?? "",
        source: prefillLineSource({ skuDefaultSourceUrl: sku?.defaultSourceUrl, demandSupplier: null }),
        demandIds: [],
        lowStockSkuId: entry.skuId,
      });
    }
    setSelectedLowStock(next);
    setLines((rows) => [...rows, ...newLines]);
  }

  function updateLine(key: string, patch: Partial<PoLineDraft>): void {
    setLines((rows) => rows.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function updateTracking(key: string, patch: Partial<TrackingDraft>): void {
    setTracking((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const body = {
      purpose: form.purpose,
      note: form.note,
      sources: form.sources.trim() === "" ? undefined : form.sources,
      shippingCost: form.shippingCost.trim() === "" ? undefined : form.shippingCost,
      lines: lines.map((line) => ({
        skuId: Number(line.skuId),
        quantity: Number(line.quantity),
        unitPrice: line.unitPrice.trim() === "" ? "0" : line.unitPrice,
        source: line.source.trim() === "" ? undefined : line.source,
        demandIds: line.demandIds.length > 0 ? line.demandIds : undefined,
      })),
      tracking: tracking
        .filter((row) => row.carrier.trim() !== "" && row.trackingNumber.trim() !== "")
        .map((row) => ({ carrier: row.carrier, trackingNumber: row.trackingNumber })),
    };
    setBusy(true);
    try {
      const created = await apiJson<{ id: number }>("/api/purchase-orders", body);
      navigate(`/orders/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <p>
        <Link to="/orders">← All purchase orders</Link>
      </p>
      <h2>New purchase order</h2>
      {error && <p className="status-error">{error}</p>}

      {demand.length > 0 && (
        <>
          <h3>Outstanding Need to Order demand</h3>
          <p className="placeholder">
            Grouped per SKU — the quantity is how many units are needed across the approved
            batches. Selecting a group adds one line covering all its records; selecting again
            removes it.
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Select all demand"
                    checked={allDemandSelected}
                    onChange={toggleAllDemand}
                  />
                </th>
                <th>SKU</th>
                <th>Quantity</th>
                <th>Supplier link</th>
                <th>Needed by batch</th>
              </tr>
            </thead>
            <tbody>
              {demand.map((group) => (
                <tr key={group.skuId}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selectedDemand.has(group.skuId)}
                      onChange={() => toggleDemand(group)}
                    />
                  </td>
                  <td>{group.skuName ?? `SKU #${group.skuId ?? "?"}`}</td>
                  <td>
                    <strong>{group.quantity}</strong>
                  </td>
                  <td>
                    <SourceText text={group.supplier} />
                  </td>
                  <td>
                    {group.batchIds.map((id) => `#${id}`).join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {lowStock.length > 0 && (
        <>
          <h3>Below minimum on-hand stock</h3>
          <p className="placeholder">
            Serialized SKUs whose available stock sits below their minimum on-hand quantity. The
            shortfall is the quantity that lifts the stock back to the minimum; selecting a row
            adds one line for it.
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Select all below-minimum SKUs"
                    checked={allLowStockSelected}
                    onChange={toggleAllLowStock}
                  />
                </th>
                <th>SKU</th>
                <th>On hand</th>
                <th>Minimum</th>
                <th>Shortfall</th>
              </tr>
            </thead>
            <tbody>
              {lowStock.map((entry) => (
                <tr key={entry.skuId}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selectedLowStock.has(entry.skuId)}
                      onChange={() => toggleLowStock(entry)}
                    />
                  </td>
                  <td>{entry.skuName}</td>
                  <td>{entry.availableCount}</td>
                  <td>{entry.minOnHand}</td>
                  <td>
                    <strong>{entry.shortfall}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <form className="form" onSubmit={onSubmit}>
        <label>
          Purpose
          <input
            list="po-purpose-suggestions"
            value={form.purpose}
            onChange={(event) => setForm({ ...form, purpose: event.target.value })}
            placeholder=""
            required
          />
          <datalist id="po-purpose-suggestions">
            {suggestions.purposes.map((purpose) => (
              <option key={purpose} value={purpose} />
            ))}
          </datalist>
        </label>
        <label>
          Sources
          <input
            list="po-source-suggestions"
            value={form.sources}
            onChange={(event) => setForm({ ...form, sources: event.target.value })}
            placeholder=""
          />
          <datalist id="po-source-suggestions">
            {suggestions.sources.map((source) => (
              <option key={source} value={source} />
            ))}
          </datalist>
        </label>
        <label>
          Shipping cost ($)
          <input
            value={form.shippingCost}
            onChange={(event) => setForm({ ...form, shippingCost: event.target.value })}
            placeholder=""
            inputMode="decimal"
          />
        </label>
        <label>
          Opening note (required)
          <textarea
            rows={3}
            value={form.note}
            onChange={(event) => setForm({ ...form, note: event.target.value })}
            placeholder=""
            required
          />
        </label>

        <h3>Lines</h3>
        {lines.map((line, index) => (
          <PoLineFields
            key={line.key}
            skus={skus}
            line={line}
            index={index}
            onPatch={(patch) => updateLine(line.key, patch)}
            onRemove={() => setLines((rows) => rows.filter((row) => row.key !== line.key))}
            resolveSku={skuFor}
            onSkuCreated={(sku) => {
              createdSkusRef.current.set(sku.id, sku);
              setSkus((all) => [...all, sku]);
            }}
          />
        ))}
        <button type="button" onClick={addLine}>
          Add line
        </button>

        <h3>Tracking</h3>
        {tracking.map((row, index) => (
          <fieldset key={row.key} className="form">
            <legend>Tracking {index + 1}</legend>
            <label>
              Carrier
              <input
                value={row.carrier}
                onChange={(event) => updateTracking(row.key, { carrier: event.target.value })}
                placeholder=""
                required
              />
            </label>
            <label>
              Tracking number
              <input
                value={row.trackingNumber}
                onChange={(event) => updateTracking(row.key, { trackingNumber: event.target.value })}
                placeholder=""
                required
              />
            </label>
            <div className="table-actions">
              <button
                type="button"
                onClick={() => setTracking((rows) => rows.filter((candidate) => candidate.key !== row.key))}
              >
                Remove
              </button>
            </div>
          </fieldset>
        ))}
        <button type="button" onClick={addTracking}>
          Add tracking entry
        </button>

        <button type="submit" disabled={busy || lines.length === 0}>
          Create purchase order
        </button>
        {lines.length === 0 && (
          <p className="placeholder">A purchase order needs at least one line.</p>
        )}
      </form>
    </section>
  );
}
