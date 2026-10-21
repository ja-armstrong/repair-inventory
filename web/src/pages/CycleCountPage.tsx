import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, apiJson, ApiError } from "../api";
import { SkuPicker, type SkuPickerOption } from "../components/SkuPicker";

interface PartRow {
  id: number;
  serial: string;
  status: string;
  statusLabel: string;
  lastCountedAt: string | null;
}

interface SkuDetail {
  id: number;
  name: string;
  kind: "serialized" | "consumable";
  parts: PartRow[];
}

interface ScanResult {
  part: PartRow;
  statusChanged: boolean;
}

/**
 * Cycle counting (spec story 65): any user, any time, pick a SKU, scan
 * (type) serials. Every scan refreshes the part's last-count date; an
 * Unavailable or RMA part found on the shelf is restored to Available —
 * the scan wins, the note is required (a Damaged by Tech part stays
 * damaged; only its count date moves). The screen keeps a
 * session-scoped tally of counted vs expected.
 */
export function CycleCountPage() {
  const [skus, setSkus] = useState<SkuPickerOption[]>([]);
  const [skuId, setSkuId] = useState("");
  const [sku, setSku] = useState<SkuDetail | null>(null);
  const [sessionStart] = useState(() => new Date());
  const [scanned, setScanned] = useState<Set<string>>(new Set());
  const [serial, setSerial] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const list = await api<SkuPickerOption[]>("/api/skus");
        // The whole catalog goes to the picker; it filters to serialized SKUs.
        setSkus(list);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "could not load SKUs");
      }
    })();
  }, []);

  const reloadSku = useCallback(async () => {
    if (skuId === "") {
      setSku(null);
      return;
    }
    try {
      setSku(await api<SkuDetail>(`/api/skus/${skuId}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not load the SKU");
    }
  }, [skuId]);

  useEffect(() => {
    void reloadSku();
  }, [reloadSku]);

  const { expected, counted } = useMemo(() => {
    const parts = sku?.parts ?? [];
    const expectedParts = parts.filter((part) => part.status === "available" || part.status === "reserved");
    const countedParts = expectedParts.filter(
      (part) =>
        scanned.has(part.serial) ||
        (part.lastCountedAt !== null && new Date(part.lastCountedAt) >= sessionStart)
    );
    return { expected: expectedParts, counted: countedParts };
  }, [sku, scanned, sessionStart]);

  async function onScan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (skuId === "" || serial.trim() === "") {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body: Record<string, unknown> = { skuId: Number(skuId), serial: serial.trim() };
      if (note.trim() !== "") {
        body.note = note.trim();
      }
      const result = await apiJson<ScanResult>("/api/cycle-counts", body);
      setScanned((previous) => new Set(previous).add(result.part.serial));
      setNotice(
        result.statusChanged
          ? `${result.part.serial} counted; changed to Available.`
          : `${result.part.serial} counted.`
      );
      if (result.statusChanged) {
        setNote("");
      }
      setSerial("");
      await reloadSku();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the scan failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Cycle count</h2>
      <p className="placeholder">
        Scans refresh each part's last-count date.
      </p>
      {error && <p className="status-error">{error}</p>}
      {notice && <p className="status-ok">{notice}</p>}

      <form className="form" onSubmit={onScan}>
        <label>
          SKU
          <SkuPicker
            skus={skus}
            kind="serialized"
            value={skuId}
            onChange={setSkuId}
            placeholder="Type to search serialized SKUs…"
            emptyMessage="No serialized SKUs yet"
          />
        </label>
        <label>
          Scan serial
          <input
            value={serial}
            onChange={(event) => setSerial(event.target.value)}
            placeholder="P00001"
            autoFocus
            required
          />
        </label>
        <label>
          Note (required for status change)
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder=""
          />
        </label>
        <button type="submit" disabled={busy || skuId === ""}>
          Count
        </button>
      </form>

      {sku && (
        <>
          <h3>
            {sku.name} — counted {counted.length} of {expected.length} expected
          </h3>
          {counted.length === expected.length && expected.length > 0 && (
            <p className="status-ok">Every expected part has been counted.</p>
          )}
          <table className="table">
            <thead>
              <tr>
                <th>Serial</th>
                <th>Status</th>
                <th>Last counted</th>
                <th>This session</th>
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
                    {part.lastCountedAt ? new Date(part.lastCountedAt).toLocaleString() : "Never"}
                  </td>
                  <td>{scanned.has(part.serial) ? "✓ counted" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="placeholder">
            
          </p>
        </>
      )}
    </section>
  );
}
