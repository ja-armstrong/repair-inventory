import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { LabelSheet, formatInches, type LabelSize } from "../components/LabelSheet";
import { DymoPrintControls } from "../components/DymoPrintControls";

/**
 * PO label print view (ticket 08, rendered through the shared LabelSheet
 * since ticket 13): one Code 128 label per expected serial, sized from the
 * configured label stock. Serials not yet received are marked so the shop can
 * see what is still outstanding on the sheet. Ticket 19 adds the DYMO print
 * controls: one click sends every label to the LabelWriter with no print
 * dialog; the browser print view stays as an explicit secondary path.
 */

interface LabelEntry {
  serial: string;
  skuId: number;
  skuName: string;
  lineId: number;
  received: boolean;
}

interface LabelsPayload {
  poId: number;
  number: number;
  purpose: string;
  label: LabelSize;
  labels: LabelEntry[];
}

export function PurchaseOrderLabelsPage() {
  const { id } = useParams();
  const poId = Number(id);
  const [data, setData] = useState<LabelsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!Number.isInteger(poId) || poId <= 0) {
      setError("invalid purchase order id");
      return;
    }
    try {
      const payload = await api<LabelsPayload>(`/api/purchase-orders/${poId}/labels`);
      setData(payload);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not load labels");
    }
  }, [poId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (error && !data) {
    return (
      <section className="labels-page">
        <h2>Labels</h2>
        <p className="status-error">{error}</p>
        <Link to={`/orders/${id}`}>← Back to purchase order</Link>
      </section>
    );
  }
  if (!data) {
    return (
      <section className="labels-page">
        <h2>Labels</h2>
        <p className="placeholder">Loading…</p>
      </section>
    );
  }

  return (
    <section className="labels-page">
      <div className="labels-toolbar no-print">
        <p>
          <Link to={`/orders/${data.poId}`}>← PO #{data.number}</Link>
          {" · "}
          <Link to={`/orders/${data.poId}/receive`}>Receive</Link>
        </p>
        <h2>Labels for PO #{data.number}</h2>
        <p className="placeholder">
          {data.purpose} · {data.labels.length} label{data.labels.length === 1 ? "" : "s"} · stock{" "}
          {formatInches(data.label.widthIn)}" × {formatInches(data.label.heightIn)}" (set by a
          manager under label settings)
        </p>
        <DymoPrintControls size={data.label} labels={data.labels} />
      </div>

      <LabelSheet
        label={data.label}
        labels={data.labels}
        isMarked={(entry) => (entry as LabelEntry).received}
      />
    </section>
  );
}
