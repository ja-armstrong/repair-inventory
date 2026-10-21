import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, apiJson, ApiError } from "../api";
import { useAuth } from "../auth";
import { PoLineFields, type PoLineDraft } from "../components/PoLineFields";
import type { SkuPickerOption } from "../components/SkuPicker";
import { SourceText } from "../components/SourceText";
import { Timeline, type TimelineEntry } from "../components/Timeline";

/**
 * PO detail (tickets 07 + 08): paperwork (lines, tracking, approve, timeline)
 * plus links into the physical half (print labels, scan-to-receive) and
 * close-with-shortfall when remainder will not arrive.
 *
 * Ticket 04: while the PO is Awaiting approval the order has not been
 * placed — the lines table shows a single Quantity column and the header
 * shows no "Marked ordered" / "Shortfall" chips. From approval onward the
 * Ordered / Received / Shortfall columns and chips return. "Fulfills
 * demand" renders "Batch #N — <device identifier>" (Asset ID, else IMEI,
 * else serial number), not the bare demand id.
 *
 * Pre-approval revisions (spec: .scratch/po-pre-approval-edits/spec.md):
 * an unapproved PO is a draft — its lines can be replaced (SKUs added,
 * removed, quantities/prices adjusted, optional note; one po.lines_changed
 * event) and a mistaken draft can be deleted outright. Both affordances
 * exist only while Awaiting approval; the server enforces the same gate.
 *
 * Ticket 05: a manager can set the shipping cost in any status except
 * Closed (optional note); the server recomputes the total and records the
 * change on the timeline.
 *
 * Ticket 11: a line's source renders CLICKABLE when the shared detector
 * (sourceLink.ts — the one decision, applied to every stored value
 * including history-suggested ones) says it parses as a web URL; free text
 * stays plain text.
 *
 * The approval panel (spec: .scratch/po-approval-ux/spec.md): while the PO
 * is Awaiting approval, a manager's decision is the page's primary action,
 * so the approve form renders as a large bordered panel at the TOP of the
 * page instead of an h3 buried in the paperwork. The approval note is
 * optional — the sign-off is the status change itself; the server still
 * refuses a given-but-blank note.
 */

interface Line {
  id: number;
  sku: { id: number; name: string; kind: string };
  quantity: number;
  receivedQuantity: number;
  shortfall: number;
  unitPrice: string;
  unitPriceCents: number;
  source: string | null;
  /** Ticket 04: the demand this line fulfills — id (the record key), the
   * demanding batch's number, and the device identifier (Asset ID, else
   * IMEI, else serial). device is null for a batch-only demand. */
  demand: { id: number; batchNumber: number; device: string | null } | null;
}

interface Tracking {
  id: number;
  carrier: string;
  trackingNumber: string;
  addedAt: string;
  addedBy: { id: number; email: string } | null;
}

interface PoDetail {
  id: number;
  number: number;
  purpose: string;
  sources: string | null;
  shippingCost: string;
  shippingCostCents: number;
  status: string;
  createdAt: string;
  createdBy: { id: number; email: string };
  approvedAt: string | null;
  approvedBy: { id: number; email: string } | null;
  closedAt: string | null;
  closedBy: { id: number; email: string } | null;
  closedNote: string | null;
  demandIds: number[];
  lines: Line[];
  tracking: Tracking[];
  shortfallTotal: number;
  totalCents: number;
  total: string;
  events: TimelineEntry[];
}

// Pre-approval editor draft keys (unique within the editor's list).
let editDraftCounter = 0;
function nextEditKey(): string {
  editDraftCounter += 1;
  return `edit-${editDraftCounter}`;
}

export function PurchaseOrderDetailPage() {
  const { id } = useParams();
  const poId = Number(id);
  const navigate = useNavigate();
  const { user } = useAuth();
  const [po, setPo] = useState<PoDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [approveNote, setApproveNote] = useState("");
  const [closeNote, setCloseNote] = useState("");
  const [carrier, setCarrier] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [shippingText, setShippingText] = useState("");
  const [shippingNote, setShippingNote] = useState("");
  // Pre-approval line editor (spec: .scratch/po-pre-approval-edits/spec.md):
  // null = not editing; otherwise the draft rows being revised.
  const [lineDrafts, setLineDrafts] = useState<PoLineDraft[] | null>(null);
  const [editNote, setEditNote] = useState("");
  const [editSkus, setEditSkus] = useState<SkuPickerOption[]>([]);

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

  async function onAddNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(() => apiJson(`/api/purchase-orders/${poId}/notes`, { note: noteText }), "Note added.");
    setNoteText("");
  }

  async function onAddTracking(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(
      () =>
        apiJson(`/api/purchase-orders/${poId}/tracking`, {
          carrier,
          trackingNumber,
        }),
      "Tracking entry added."
    );
    setCarrier("");
    setTrackingNumber("");
  }

  async function onApprove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(
      () =>
        apiJson(
          `/api/purchase-orders/${poId}/approve`,
          // The note is optional: an empty input sends NO note key at all —
          // the server accepts a noteless approval but refuses a
          // given-but-blank note.
          approveNote.trim() === "" ? {} : { note: approveNote }
        ),
      "Purchase order approved. Expected serials assigned and status set to In-transit."
    );
    setApproveNote("");
  }

  async function onClose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(
      () => apiJson(`/api/purchase-orders/${poId}/close`, { note: closeNote }),
      "Purchase order closed with shortfall."
    );
    setCloseNote("");
  }

  async function onSetShipping(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(
      () =>
        apiJson(
          `/api/purchase-orders/${poId}/shipping-cost`,
          // The note is optional: an empty input sends NO note key at all —
          // the server accepts a noteless change but refuses a
          // given-but-blank note.
          {
            shippingCost: shippingText,
            ...(shippingNote.trim() === "" ? {} : { note: shippingNote }),
          }
        ),
      "Shipping cost set. The total and the timeline reflect it."
    );
    setShippingText("");
    setShippingNote("");
  }

  // ---- pre-approval line editor -------------------------------------------

  async function startEditLines(): Promise<void> {
    if (!po) {
      return;
    }
    // The catalog feeds the line pickers; one load per editing session.
    try {
      setEditSkus(await api<SkuPickerOption[]>("/api/skus"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not load the SKU catalog");
      return;
    }
    setLineDrafts(
      po.lines.map((line) => ({
        key: nextEditKey(),
        skuId: String(line.sku.id),
        quantity: String(line.quantity),
        // unitPrice arrives formatted ("12.34") — round-trips into the input.
        unitPrice: line.unitPrice,
        source: line.source ?? "",
        // The line's PRIMARY demand ref is what the detail carries; the
        // server re-derives the full link set on save (same-SKU links are
        // kept whether or not they round-trip).
        demandIds: line.demand !== null ? [line.demand.id] : [],
      }))
    );
    setEditNote("");
    setError(null);
    setNotice(null);
  }

  function patchDraft(key: string, patch: Partial<PoLineDraft>): void {
    setLineDrafts((rows) =>
      rows === null ? rows : rows.map((row) => (row.key === key ? { ...row, ...patch } : row))
    );
  }

  function resolveEditSku(skuId: string): SkuPickerOption | undefined {
    return editSkus.find((sku) => sku.id === Number(skuId));
  }

  async function onSaveLines(): Promise<void> {
    if (lineDrafts === null) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiJson(`/api/purchase-orders/${poId}/lines`, {
        // The note is optional: an empty input sends NO note key at all —
        // the server accepts a noteless revision but refuses a
        // given-but-blank note.
        ...(editNote.trim() === "" ? {} : { note: editNote }),
        lines: lineDrafts.map((line) => ({
          skuId: Number(line.skuId),
          quantity: Number(line.quantity),
          unitPrice: line.unitPrice.trim() === "" ? "0" : line.unitPrice,
          source: line.source.trim() === "" ? undefined : line.source,
          demandIds: line.demandIds.length > 0 ? line.demandIds : undefined,
        })),
      });
      setLineDrafts(null);
      setNotice("Lines revised. The total and the timeline reflect it.");
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
    } finally {
      setBusy(false);
    }
  }

  async function onDeletePo(): Promise<void> {
    if (
      !window.confirm(
        "Delete this draft purchase order? Its lines, tracking, and history are removed and any Need to Order records it covered become outstanding again."
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiJson<{ deleted: number }>(`/api/purchase-orders/${poId}`, {}, "DELETE");
      navigate("/orders");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
      setBusy(false);
    }
  }

  if (error && !po) {
    return (
      <section>
        <h2>Purchase order</h2>
        <p className="status-error">{error}</p>
        <Link to="/orders">← All purchase orders</Link>
      </section>
    );
  }
  if (!po) {
    return (
      <section>
        <h2>Purchase order #{id}</h2>
        <p className="placeholder">Loading…</p>
      </section>
    );
  }

  const manager = user?.role === "manager";
  const awaiting = po.status === "Awaiting approval";
  const receivable = po.status === "In-transit" || po.status === "Partially received";
  const canClose = receivable && po.shortfallTotal > 0;

  return (
    <section>
      <p>
        <Link to="/orders">← All purchase orders</Link>
        {!awaiting && (
          <>
            {" · "}
            <Link to={`/orders/${po.id}/labels`}>Print labels</Link>
            {" · "}
            <Link to={`/orders/${po.id}/receive`}>Receive</Link>
          </>
        )}
      </p>
      <h2>PO #{po.number}</h2>
      <p className="placeholder">
        {po.status} · Created {new Date(po.createdAt).toLocaleString()} by {po.createdBy.email}
        {po.approvedAt !== null && po.approvedBy !== null && (
          <>
            {" "}
            · Approved {new Date(po.approvedAt).toLocaleString()} by {po.approvedBy.email}
          </>
        )}
        {po.closedAt !== null && po.closedBy !== null && (
          <>
            {" "}
            · Closed {new Date(po.closedAt).toLocaleString()} by {po.closedBy.email}
          </>
        )}
      </p>
      <p>
        <strong>Purpose:</strong> {po.purpose}
        {po.sources !== null && (
          <>
            {" "}
            · <strong>Sources:</strong> {po.sources}
          </>
        )}
        {/* Ticket 04: pre-approval the order has not been placed — no
            "marked ordered" or shortfall claims until it is approved. */}
        {!awaiting && po.demandIds.length > 0 && (
          <>
            {" "}
            · <strong>Marked ordered:</strong> {po.demandIds.length} demand record
            {po.demandIds.length === 1 ? "" : "s"}
          </>
        )}
        {!awaiting && po.shortfallTotal > 0 && (
          <>
            {" "}
            · <strong>Shortfall:</strong> {po.shortfallTotal} unit
            {po.shortfallTotal === 1 ? "" : "s"}
          </>
        )}
      </p>
      {po.closedNote !== null && (
        <p>
          <strong>Close note:</strong> {po.closedNote}
        </p>
      )}
      {notice && <p className="status-ok">{notice}</p>}
      {error && <p className="status-error">{error}</p>}

      {/* The approval is the page's PRIMARY action while Awaiting approval:
          a manager lands here to decide, so the panel sits at the very top,
          large and bordered (not one h3 among the paperwork sections below).
          Manager-only; the server enforces the same gate. */}
      {manager && awaiting && (
        <div className="approval-panel">
          <h2>Approve this purchase order</h2>
          <p>
            Manager approval moves this PO to In-transit and assigns an expected
            serial to every part, so labels can print before anything arrives.
          </p>
          <form className="form" onSubmit={onApprove}>
            <label>
              Approval note (optional)
              <input
                value={approveNote}
                onChange={(event) => setApproveNote(event.target.value)}
                placeholder=""
              />
            </label>
            <button type="submit" disabled={busy}>
              Approve
            </button>
          </form>
        </div>
      )}

      <h3>Lines</h3>
      <table className="table">
        <thead>
          <tr>
            <th>SKU</th>
            {/* Ticket 04: before approval the order has not been placed, so
                the table shows the single Quantity column instead of
                Ordered / Received / Shortfall. */}
            {awaiting ? <th>Quantity</th> : <th>Ordered</th>}
            {!awaiting && <th>Received</th>}
            {!awaiting && <th>Shortfall</th>}
            <th>Unit price</th>
            <th>Line total</th>
            <th>Source</th>
            <th>Fulfills demand</th>
          </tr>
        </thead>
        <tbody>
          {po.lines.map((line) => (
            <tr key={line.id}>
              <td>
                <Link to={`/inventory/skus/${line.sku.id}`}>{line.sku.name}</Link>
              </td>
              {awaiting ? (
                <td>{line.quantity}</td>
              ) : (
                <>
                  <td>{line.quantity}</td>
                  <td>{line.receivedQuantity}</td>
                  <td>{line.shortfall}</td>
                </>
              )}
              <td>${line.unitPrice}</td>
              <td>${((line.unitPriceCents * line.quantity) / 100).toFixed(2)}</td>
              <td>
                <SourceText text={line.source} />
              </td>
              {/* Ticket 04: "Batch #N — <device identifier>" instead of the
                  bare demand id. The demand id stays available as the
                  tooltip — it remains the record key. */}
              <td>
                {line.demand === null ? (
                  "—"
                ) : (
                  <span title={`Demand #${line.demand.id}`}>
                    Batch #{line.demand.batchNumber}
                    {line.demand.device !== null ? ` — ${line.demand.device}` : ""}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <strong>Shipping:</strong> ${po.shippingCost} · <strong>Total:</strong> ${po.total}
      </p>

      {/* Pre-approval revisions (spec: .scratch/po-pre-approval-edits/spec.md):
          the order has not been placed, so the lines can be replaced and a
          mistaken draft deleted outright. The server enforces the same gate. */}
      {awaiting && lineDrafts === null && (
        <p className="table-actions">
          <button type="button" disabled={busy} onClick={() => void startEditLines()}>
            Edit lines
          </button>
          <button type="button" disabled={busy} onClick={() => void onDeletePo()}>
            Delete draft PO
          </button>
          <span className="placeholder">
            The order has not been placed — SKUs, quantities, and prices can still be revised.
          </span>
        </p>
      )}
      {awaiting && lineDrafts !== null && (
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void onSaveLines();
          }}
        >
          <p className="placeholder">
            The submitted set REPLACES the lines. One timeline event records the change with the
            required note; a SKU whose line disappears releases its marked Need to Order records
            back to the outstanding queue.
          </p>
          {lineDrafts.map((line, index) => (
            <PoLineFields
              key={line.key}
              skus={editSkus}
              line={line}
              index={index}
              onPatch={(patch) => patchDraft(line.key, patch)}
              onRemove={() =>
                setLineDrafts((rows) =>
                  rows === null ? rows : rows.filter((row) => row.key !== line.key)
                )
              }
              resolveSku={resolveEditSku}
              onSkuCreated={(sku) => setEditSkus((all) => [...all, sku])}
            />
          ))}
          <button
            type="button"
            onClick={() =>
              setLineDrafts((rows) =>
                rows === null
                  ? rows
                  : [
                      ...rows,
                      {
                        key: nextEditKey(),
                        skuId: "",
                        quantity: "1",
                        unitPrice: "",
                        source: "",
                        demandIds: [],
                      },
                    ]
              )
            }
          >
            Add line
          </button>
          <label>
            Note (optional — the change lands on the timeline either way)
            <input
              value={editNote}
              onChange={(event) => setEditNote(event.target.value)}
              placeholder="Why the lines changed"
            />
          </label>
          <div className="table-actions">
            <button type="submit" disabled={busy}>
              Save lines
            </button>
            <button type="button" disabled={busy} onClick={() => setLineDrafts(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Ticket 05: manager-only, gated like the approve form above — the
          server enforces the same predicate. Closed is refused server-side,
          so the affordance disappears there. */}
      {manager && po.status !== "Closed" && (
        <>
          <h3>Shipping cost</h3>
          <p className="placeholder">
            Currently ${po.shippingCost}. Setting a new shipping cost updates the
            PO total and records the change (old → new) on the timeline.
          </p>
          <form className="form" onSubmit={onSetShipping}>
            <label>
              New shipping cost
              <input
                value={shippingText}
                onChange={(event) => setShippingText(event.target.value)}
                placeholder="e.g. 12.75"
                required
              />
            </label>
            <label>
              Note (optional)
              <input
                value={shippingNote}
                onChange={(event) => setShippingNote(event.target.value)}
                placeholder="Why the number changed"
              />
            </label>
            <button type="submit" disabled={busy}>
              Set shipping cost
            </button>
          </form>
        </>
      )}

      <h3>Tracking</h3>
      {po.tracking.length === 0 && <p className="placeholder">No tracking entries yet.</p>}
      {po.tracking.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Carrier</th>
              <th>Tracking number</th>
              <th>Added</th>
            </tr>
          </thead>
          <tbody>
            {po.tracking.map((entry) => (
              <tr key={entry.id}>
                <td>{entry.carrier}</td>
                <td>{entry.trackingNumber}</td>
                <td>
                  {new Date(entry.addedAt).toLocaleString()} · {entry.addedBy?.email ?? "system"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form className="form" onSubmit={onAddTracking}>
        <label>
          Carrier
          <input
            value={carrier}
            onChange={(event) => setCarrier(event.target.value)}
            placeholder=""
            required
          />
        </label>
        <label>
          Tracking number
          <input
            value={trackingNumber}
            onChange={(event) => setTrackingNumber(event.target.value)}
            placeholder=""
            required
          />
        </label>
        <button type="submit" disabled={busy}>
          Add tracking entry
        </button>
      </form>

      {canClose && (
        <>
          <h3>Close with shortfall</h3>
          <p className="placeholder">
            {po.shortfallTotal} unit{po.shortfallTotal === 1 ? "" : "s"} still unreceived.
          </p>
          <form className="form" onSubmit={onClose}>
            <label>
              Close note
              <input
                value={closeNote}
                onChange={(event) => setCloseNote(event.target.value)}
                placeholder=""
                required
              />
            </label>
            <button type="submit" disabled={busy}>
              Close with shortfall
            </button>
          </form>
        </>
      )}

      <h3>Timeline</h3>
      <form className="form" onSubmit={onAddNote}>
        <label>
          Add a note
          <input
            value={noteText}
            onChange={(event) => setNoteText(event.target.value)}
            placeholder="What happened?"
            required
          />
        </label>
        <button type="submit" disabled={busy}>
          Add note
        </button>
      </form>
      {/* The one timeline renderer (components/Timeline.tsx). */}
      <Timeline events={po.events} />
    </section>
  );
}
