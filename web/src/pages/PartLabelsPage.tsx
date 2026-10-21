import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { LabelSheet, formatInches, type LabelSize } from "../components/LabelSheet";
import { DymoPrintControls } from "../components/DymoPrintControls";

/**
 * The intake label print view (ticket 13): labels for any set of serialized
 * parts — freshly intake'd migration/salvage stock, or any later reprint —
 * through the shared LabelSheet (the same rendering the PO sheet uses), sized
 * from the configured label stock. The part ids come from the ?ids= query so
 * the sheet is URL-addressable and can be reprinted later. Ticket 19 adds the
 * DYMO print controls: one click sends every label to the LabelWriter with no
 * print dialog; the browser print view stays as an explicit secondary path.
 */

interface LabelEntry {
  id: number;
  serial: string;
  skuId: number;
  skuName: string;
}

interface LabelsPayload {
  label: LabelSize;
  labels: LabelEntry[];
}

export function PartLabelsPage() {
  const [searchParams] = useSearchParams();
  const ids = searchParams.get("ids") ?? "";
  const [data, setData] = useState<LabelsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!ids.trim()) {
      setError("no parts selected. start from the intake screen");
      return;
    }
    try {
      const payload = await api<LabelsPayload>(`/api/parts/labels?ids=${encodeURIComponent(ids)}`);
      setData(payload);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not load labels");
    }
  }, [ids]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <section className="labels-page">
      <div className="labels-toolbar no-print">
        <p>
          <Link to="/inventory/intake">← Intake</Link>
        </p>
        <h2>Labels</h2>
        {data && (
          <p className="placeholder">
            {data.labels.length} label{data.labels.length === 1 ? "" : "s"} · stock{" "}
            {formatInches(data.label.widthIn)}" × {formatInches(data.label.heightIn)}" (set by a
            manager under label settings)
          </p>
        )}
        {data && <DymoPrintControls size={data.label} labels={data.labels} />}
      </div>

      {error && !data && (
        <>
          <p className="status-error">{error}</p>
          <Link to="/inventory/intake">← Intake</Link>
        </>
      )}
      {data && <LabelSheet label={data.label} labels={data.labels} />}
    </section>
  );
}
