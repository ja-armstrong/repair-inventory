import { SkuPicker, type SkuPickerOption } from "./SkuPicker";

/**
 * The one PO-line editor row (create page and the detail page's
 * pre-approval line editor): SKU picker, quantity, unit price, per-line
 * source, remove button. One implementation, so a line is entered the same
 * way everywhere a PO line is edited.
 *
 * Prefill rules (ticket 11): picking a SKU offers its catalog price and
 * default source link as defaults — EXCEPT on a demand-linked line, whose
 * price/source were resolved at selection time (SKU default vs the demand
 * record's supplier) and stay. Changing a line's SKU clears its demand refs:
 * a Need to Order record belongs to the SKU it was filed for.
 */

export interface PoLineDraft {
  key: string;
  skuId: string;
  quantity: string;
  unitPrice: string;
  source: string;
  demandIds: number[];
  /** Set when the line was created from a below-minimum (low-stock) row. */
  lowStockSkuId?: number;
}

interface PoLineFieldsProps {
  skus: SkuPickerOption[];
  line: PoLineDraft;
  index: number;
  onPatch: (patch: Partial<PoLineDraft>) => void;
  onRemove: () => void;
  /** Resolves a SKU id to its catalog row, including one created inline this session. */
  resolveSku: (skuId: string) => SkuPickerOption | undefined;
  onSkuCreated: (sku: SkuPickerOption) => void;
}

export function PoLineFields({
  skus,
  line,
  index,
  onPatch,
  onRemove,
  resolveSku,
  onSkuCreated,
}: PoLineFieldsProps) {
  return (
    <fieldset className="form">
      <legend>Line {index + 1}</legend>
      <label>
        SKU
        <SkuPicker
          skus={skus}
          value={line.skuId}
          onChange={(skuId) => {
            const sku = resolveSku(skuId);
            const skuChanged = skuId !== line.skuId;
            // A demand ref belongs to the SKU it was filed for — changing
            // the line's SKU releases it (the server re-derives the links).
            // A demand-linked line keeps its resolved price/source; a plain
            // line is pre-filled from the SKU's catalog row (ticket 11).
            const keepsDemand = line.demandIds.length > 0 && !skuChanged;
            onPatch({
              skuId,
              ...(line.demandIds.length > 0 && skuChanged ? { demandIds: [] } : {}),
              unitPrice: keepsDemand ? line.unitPrice : (sku?.price ?? line.unitPrice),
              source: keepsDemand ? line.source : (sku?.defaultSourceUrl ?? line.source),
            });
          }}
          allowCreate
          onCreated={onSkuCreated}
          placeholder="Type to search SKUs…"
          emptyMessage="No SKUs in the catalog yet"
        />
      </label>
      <label>
        Quantity
        <input
          type="number"
          min={1}
          value={line.quantity}
          onChange={(event) => onPatch({ quantity: event.target.value })}
          required
        />
      </label>
      <label>
        Unit price ($)
        <input
          value={line.unitPrice}
          onChange={(event) => onPatch({ unitPrice: event.target.value })}
          placeholder=""
          inputMode="decimal"
          required
        />
      </label>
      <label>
        Source (this line)
        <input
          value={line.source}
          onChange={(event) => onPatch({ source: event.target.value })}
          placeholder=""
        />
      </label>
      <div className="table-actions">
        <button type="button" onClick={onRemove}>
          Remove line
        </button>
      </div>
    </fieldset>
  );
}
