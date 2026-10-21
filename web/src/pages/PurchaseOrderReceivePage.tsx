import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { api, apiJson, ApiError } from "../api";

/**
 * Scan-to-receive (ticket 08): keyboard-wedge scanners type a serial and
 * press Enter — the input stays focused. Each accepted scan creates the
 * part as Available, bumps the line, refreshes price, and may auto-reserve.
 */

interface Line {
  id: number;
  sku: { id: number; name: string; kind: string };
  quantity: number;
  receivedQuantity: number;
  shortfall: number;
  unitPrice: string;
}

interface ExpectedSerial {
  serial: string;
  received: boolean;
  lineId: number;
  sku: { id: number; name: string };
}

interface PoDetail {
  id: number;
  number: number;
  purpose: string;
  status: string;
  lines: Line[];
  expectedSerials: ExpectedSerial[];
  shortfallTotal: number;
  closedNote: string | null;
}

export function PurchaseOrderReceivePage() {
  const { id } = useParams();
  const poId = Number(id);
  const [po, setPo] = useState<PoDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanInput, setScanInput] = useState("");
  const [consumableQty, setConsumableQty] = useState<Record<number, string>>({});
  const scanField = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    if (!Number.isInteger(poId) || poId <= 0) {
      setError("invalid purchase order id");
      return;
    }
    try {
      setPo(await api<PoDetail>(`/api/purchase-orders/${poId}`));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not load the purchase order");
    }
  }, [poId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const open = po?.status === "In-transit" || po?.status === "Partially received";

  useEffect(() => {
    if (open) {
      scanField.current?.focus();
    }
  }, [open, po?.expectedSerials.length]);

  async function onScan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const serial = scanInput.trim().toUpperCase();
    if (!serial || !po) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await apiJson<{
        serial: string;
        reserved: boolean;
        status: string;
        purchaseOrder: PoDetail;
      }>(`/api/purchase-orders/${poId}/receive`, { serial });
      setPo(result.purchaseOrder);
      setNotice(
        result.reserved
          ? `${result.serial} received and auto-reserved.`
          : `${result.serial} received as Available.`
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the scan failed");
    } finally {
      setBusy(false);
      setScanInput("");
      scanField.current?.focus();
    }
  }

  async function onReceiveConsumable(lineId: number) {
    const raw = consumableQty[lineId] ?? "";
    const quantity = Number(raw);
    if (!Number.isInteger(quantity) || quantity < 1) {
      setError("enter a whole-number quantity of at least 1");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await apiJson<{ purchaseOrder: PoDetail }>(
        `/api/purchase-orders/${poId}/receive-consumable`,
        { lineId, quantity }
      );
      setPo(result.purchaseOrder);
      setNotice(`Received ${quantity} on consumable line.`);
      setConsumableQty((prev) => ({ ...prev, [lineId]: "" }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not receive consumable");
    } finally {
      setBusy(false);
    }
  }

  if (error && !po) {
    return (
      <section>
        <h2>Receive</h2>
        <p className="status-error">{error}</p>
        <Link to={`/orders/${id}`}>← Back to purchase order</Link>
      </section>
    );
  }
  if (!po) {
    return (
      <section>
        <h2>Receive PO #{id}</h2>
        <p className="placeholder">Loading…</p>
      </section>
    );
  }

  const pending = po.expectedSerials.filter((entry) => !entry.received);
  const received = po.expectedSerials.filter((entry) => entry.received);
  const consumableLines = po.lines.filter((line) => line.sku.kind === "consumable");

  return (
    <section>
      <p>
        <Link to={`/orders/${po.id}`}>← PO #{po.number}</Link>
        {" · "}
        <Link to={`/orders/${po.id}/labels`}>Print labels</Link>
      </p>
      <h2>Receive PO #{po.number}</h2>
      <p className="placeholder">
        {po.status} · {po.purpose}
        {po.shortfallTotal > 0 && <> · shortfall {po.shortfallTotal} unit{po.shortfallTotal === 1 ? "" : "s"}</>}
      </p>
      {notice && <p className="status-ok">{notice}</p>}
      {error && <p className="status-error">{error}</p>}

      {open && (
        <>
          <h3>Scan a serial</h3>
          <form className="form scan-form" onSubmit={onScan}>
            <label>
              Scan or type a serial
              <input
                ref={scanField}
                value={scanInput}
                onChange={(event) => setScanInput(event.target.value)}
                placeholder="P00001"
                autoFocus
                autoComplete="off"
              />
            </label>
            <button type="submit" disabled={busy}>
              Receive
            </button>
            <p className="placeholder">
              Each scan creates the part as Available.
            </p>
          </form>
        </>
      )}
      {!open && (
        <p className="placeholder">
          Receiving is only available while the PO is In-transit or Partially received
          {po.closedNote ? ` — closed note: ${po.closedNote}` : ""}.
        </p>
      )}

      <h3>Lines</h3>
      <table className="table">
        <thead>
          <tr>
            <th>SKU</th>
            <th>Ordered</th>
            <th>Received</th>
            <th>Shortfall</th>
            <th>Unit price</th>
          </tr>
        </thead>
        <tbody>
          {po.lines.map((line) => (
            <tr key={line.id}>
              <td>
                <Link to={`/inventory/skus/${line.sku.id}`}>{line.sku.name}</Link>
                {line.sku.kind === "consumable" ? " (consumable)" : ""}
              </td>
              <td>{line.quantity}</td>
              <td>{line.receivedQuantity}</td>
              <td>{line.shortfall}</td>
              <td>${line.unitPrice}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {open && consumableLines.some((line) => line.shortfall > 0) && (
        <>
          <h3>Receive consumables</h3>
          {consumableLines
            .filter((line) => line.shortfall > 0)
            .map((line) => (
              <form
                key={line.id}
                className="form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void onReceiveConsumable(line.id);
                }}
              >
                <p>
                  {line.sku.name} — {line.shortfall} remaining
                </p>
                <label>
                  Quantity
                  <input
                    type="number"
                    min={1}
                    max={line.shortfall}
                    value={consumableQty[line.id] ?? ""}
                    onChange={(event) =>
                      setConsumableQty((prev) => ({ ...prev, [line.id]: event.target.value }))
                    }
                    required
                  />
                </label>
                <button type="submit" disabled={busy}>
                  Receive quantity
                </button>
              </form>
            ))}
        </>
      )}

      <h3>Pending serials ({pending.length})</h3>
      {pending.length === 0 ? (
        <p className="placeholder">No pending expected serials.</p>
      ) : (
        <ul>
          {pending.map((entry) => (
            <li key={entry.serial}>
              {entry.serial} — {entry.sku.name}
            </li>
          ))}
        </ul>
      )}

      <h3>Received serials ({received.length})</h3>
      {received.length === 0 ? (
        <p className="placeholder">Nothing received yet.</p>
      ) : (
        <ul>
          {received.map((entry) => (
            <li key={entry.serial}>
              <Link to={`/inventory/parts/${encodeURIComponent(entry.serial)}`}>{entry.serial}</Link>{" "}
              — {entry.sku.name}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
