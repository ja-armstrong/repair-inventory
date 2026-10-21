import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import JsBarcode from "jsbarcode";

/**
 * The shared label sheet (ticket 13): one Code 128 label per serial, CSS-sized
 * to the shop's configured label stock (manager-editable settings keys
 * label_width_sixteenths / label_height_sixteenths — current stock 2-5/16" × 4",
 * moving to 2" × 1"). Extracted from the PO labels page so ANY label sheet —
 * PO expected serials, migration and salvage intake, any future selection —
 * renders through this one component instead of a copy (single source of
 * truth).
 *
 * Browser fallback print path (ticket 19): @page is sized to the configured
 * stock (injected below, since the size is data, not a static CSS value),
 * app chrome and toolbar are hidden, and only the label cards print — one
 * per page with `break-after: page` on every card except the last, so there
 * are no blank pages and no manual page-range selection.
 */

export interface LabelSize {
  widthSixteenths: number;
  heightSixteenths: number;
  widthIn: number;
  heightIn: number;
}

export interface LabelEntry {
  serial: string;
  skuId: number;
  skuName: string;
}

/** Fractional inches as the shop says them: 2.3125 → "2-5/16". */
export function formatInches(inches: number): string {
  const whole = Math.floor(inches);
  const numerator = Math.round((inches - whole) * 16);
  if (numerator === 0) {
    return String(whole);
  }
  return `${whole}-${numerator}/16`;
}

export function LabelSheet({
  label,
  labels,
  isMarked,
  markText,
}: {
  label: LabelSize;
  labels: LabelEntry[];
  /** Optional per-entry mark (the PO sheet flags already-received serials). */
  isMarked?: (entry: LabelEntry) => boolean;
  markText?: string;
}) {
  // Compact stock (1" tall) renders a tighter barcode; anything taller keeps
  // the roomy default. Derived from the configured height, not a preset.
  const compact = label.heightIn <= 1.25;
  return (
    <div
      className="label-sheet"
      style={
        {
          "--label-width": `${label.widthIn}in`,
          "--label-height": `${label.heightIn}in`,
        } as CSSProperties
      }
    >
      {/* @page sized from the configured stock so the browser fallback prints
          one label per page on the right paper size — no page-range dance. */}
      <style>{`@media print { @page { size: ${label.widthIn}in ${label.heightIn}in; margin: 0; } }`}</style>
      {labels.map((entry) => (
        <LabelCard
          key={entry.serial}
          entry={entry}
          compact={compact}
          marked={isMarked?.(entry) ?? false}
          markText={markText}
        />
      ))}
    </div>
  );
}

function LabelCard({
  entry,
  compact,
  marked,
  markText,
}: {
  entry: LabelEntry;
  compact: boolean;
  marked: boolean;
  markText?: string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const barcodeOptions = useMemo(
    () => ({
      format: "CODE128" as const,
      displayValue: true,
      fontSize: compact ? 12 : 16,
      height: compact ? 36 : 64,
      margin: 4,
      width: compact ? 1.2 : 1.6,
    }),
    [compact]
  );

  useEffect(() => {
    if (svgRef.current) {
      JsBarcode(svgRef.current, entry.serial, barcodeOptions);
    }
  }, [entry.serial, barcodeOptions]);

  return (
    <article className={`label-card${marked ? " label-received" : ""}`}>
      <svg ref={svgRef} className="label-barcode" />
      <p className="label-sku">SKU #{entry.skuId}</p>
      <p className="label-name">{entry.skuName}</p>
      {marked && <p className="label-received-mark no-print">{markText ?? "received"}</p>}
    </article>
  );
}
