import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { apiJson, ApiError } from "../api";
import { addPartRequest } from "../addPartRequest";
import { SkuPicker, type SkuPickerOption } from "./SkuPicker";

/**
 * The per-device parts panel (ticket 05): add a part — a serialized SKU
 * (reserving the oldest Available unit, with an optional per-part price
 * override, ticket 23, or filing a Need to Order demand when stock is
 * short), a scanned serial (that exact unit), or a CONSUMABLE SKU (recorded
 * as usage: quantity × unit price — the item has no units; its cost is what
 * is tracked) — swap a reserved
 * unit for another of the same SKU (oldest Available by default, or the
 * scanned replacement serial), remove with a required, ALWAYS-explicit
 * destination + note (ticket 02: no default, no pre-selection — the dialog
 * blocks submission until the tech chooses) —
 * and the device's computed Parts Cost over all of it, serialized
 * attachments and consumable usage alike. Price-overridden units are marked
 * in the list. CONTEXT.md vocabulary throughout.
 */

// The picker's option shape IS the SKU option shape — one source of truth
// (ticket 20); the panel and the pages above it keep their own name for it.
export type SkuOption = SkuPickerOption;

export interface DevicePartAttachment {
  id: number;
  part: { id: number; serial: string; status: string; statusLabel: string };
  sku: { id: number; name: string; kind: string; price: string; buybackable: boolean };
  price: string;
  // Ticket 23 (Part Price): true when the part carries its own price
  // override rather than following the SKU catalog price.
  priceOverridden: boolean;
  addedAt: string;
  addedBy: { id: number; email: string };
  removedAt: string | null;
  removedTo: string | null;
  removalNote: string | null;
  removalReason: string | null;
}

export interface DeviceConsumableUsage {
  id: number;
  sku: { id: number; name: string };
  quantity: number;
  costCents: number;
  recordedAt: string;
  recordedBy: { id: number; email: string };
}

export interface DeviceDemand {
  id: number;
  sku: { id: number; name: string; priceCents?: number | null };
  supplier: string | null;
  status: string;
  createdAt: string;
  // Ticket 29: the purchase order that already carries this demand, when one
  // does — the unit is not "needed" any more, it is in transit.
  orderedOn?: { poNumber: number; poStatus: string } | null;
}

export interface DevicePartsData {
  deviceId: number;
  parts: DevicePartAttachment[];
  consumables: DeviceConsumableUsage[];
  demand: DeviceDemand[];
  partsCostCents: number;
  partsCost: string;
  // Ticket 06: the open Need-to-Order demand's SKU-price estimate — its OWN
  // display field, never part of partsCostCents (a demand is an estimate, not
  // a signed-off cost). The label is null when nothing is outstanding.
  openDemandEstimateCents: number;
  openDemandEstimate: string | null;
  // Ticket 28: the device's Price Add Limit and its DERIVED post-approval
  // spend (active attachments + consumable usage created after approval).
  priceAddLimitCents: number;
  postApprovalSpendCents: number;
  priceAddRemainingCents: number;
}

/**
 * What the CURRENT viewer may do to this device's part list, computed
 * SERVER-side from the batch lifecycle (see serializeBatchDetail). The
 * panel renders from this — it never re-encodes the approval rules.
 */
export interface PartEditPermissions {
  addPart: boolean;
  removePart: boolean;
  consumable: boolean;
  swapPart: boolean;
}

const DESTINATIONS = [
  { value: "available", label: "Available (return to stock)" },
  { value: "buyback", label: "Buyback (slate for supplier sale)" },
  { value: "rma", label: "RMA (slate for vendor return)" },
  { value: "damaged_by_tech", label: "Damaged by Tech (attributed to you)" },
] as const;

function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function DevicePartsPanel({
  batchId,
  device,
  data,
  skus,
  onSkuCreated,
  permissions,
  onChanged,
  onClose,
}: {
  batchId: number;
  device: { id: number; model: string; deviceNumber?: number | null };
  data: DevicePartsData;
  skus: SkuOption[];
  /** Ticket 24: a SKU created inline in the add-part picker joins the catalog. */
  onSkuCreated: (sku: SkuOption) => void;
  permissions: PartEditPermissions;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // ONE add form for both kinds: a serialized pick reserves a unit; a
  // consumable pick records usage (quantity × unit price). The form adapts
  // to the picked SKU's kind and routes to the matching endpoint.
  const [addForm, setAddForm] = useState({
    skuId: "",
    serial: "",
    supplier: "",
    note: "",
    price: "",
    quantity: "1",
  });
  const [action, setAction] = useState<{ attachment: DevicePartAttachment; kind: "swap" | "remove" } | null>(null);
  const [actionForm, setActionForm] = useState({ destination: "available", note: "", serial: "" });
  // Ticket 30: cancelling a Need to Order record — the device's BLOCK itself.
  const [cancelForm, setCancelForm] = useState<{ demandId: number; note: string } | null>(null);

  const activeParts = data.parts.filter((part) => part.removedAt === null);
  const pastParts = data.parts.filter((part) => part.removedAt !== null);
  const openDemand = data.demand.filter((record) => record.status === "open");
  // The picked SKU drives the add form's shape and endpoint: consumables
  // are recorded as usage, serialized units are reserved.
  const pickedSku = skus.find((sku) => String(sku.id) === addForm.skuId) ?? null;

  async function run(action: () => Promise<unknown>, done: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(done);
      await onChanged();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function onAddPart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // The routing decision is a pure, tested contract (addPartRequest.ts): a
    // filled serial is a complete request on its own — the scan path never
    // requires a SKU pick, and an un-routable form fails LOUDLY here, never
    // as a silent no-op submit.
    const request = addPartRequest(addForm, pickedSku);
    if ("error" in request) {
      setError(request.error);
      return;
    }
    const path =
      request.endpoint === "consumables"
        ? `/api/batches/${batchId}/devices/${device.id}/consumables`
        : `/api/batches/${batchId}/devices/${device.id}/parts`;
    const done =
      request.endpoint === "consumables" ? "Consumable usage recorded." : "Part added.";
    const ok = await run(() => apiJson(path, request.body), done);
    if (ok) {
      setAddForm({ skuId: "", serial: "", supplier: "", note: "", price: "", quantity: "1" });
    }
  }

  async function onSubmitAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action) {
      return;
    }
    const { attachment, kind } = action;
    // Ticket 02: a removal without a chosen destination never reaches the
    // server — the dialog blocks submission until the tech picks one.
    if (kind === "remove" && actionForm.destination === "") {
      return;
    }
    // The swap's optional serial scan: a filled serial swaps in THAT exact
    // unit; blank keeps the oldest-Available pick. A removal never scans.
    const serial = kind === "swap" ? actionForm.serial.trim() : "";
    const ok = await run(
      () =>
        apiJson(
          `/api/batches/${batchId}/devices/${device.id}/parts/${attachment.id}/${kind}`,
          {
            destination: actionForm.destination,
            note: actionForm.note,
            serial: serial === "" ? undefined : serial,
          },
        ),
      kind === "swap" ? "Part swapped." : "Part removed.",
    );
    if (ok) {
      setAction(null);
      setActionForm({ destination: "available", note: "", serial: "" });
    }
  }

  // Ticket 30 pattern: cancelling a Need to Order and removing a part are
  // never silent — neither is removing consumable usage. The note form is
  // inline on the usage row.
  const [usageRemoval, setUsageRemoval] = useState<{ usageId: number; note: string } | null>(null);

  async function onRemoveUsage(event: FormEvent<HTMLFormElement>, usageId: number) {
    event.preventDefault();
    if (!usageRemoval) {
      return;
    }
    const ok = await run(
      () =>
        apiJson(`/api/batches/${batchId}/devices/${device.id}/consumables/${usageId}/remove`, {
          note: usageRemoval.note,
        }),
      "Consumable usage removed.",
    );
    if (ok) {
      setUsageRemoval(null);
    }
  }

  async function onCancelDemand(event: FormEvent<HTMLFormElement>, demandId: number) {
    event.preventDefault();
    if (!cancelForm) {
      return;
    }
    const ok = await run(
      () =>
        apiJson(`/api/batches/${batchId}/devices/${device.id}/demand/${demandId}/cancel`, {
          note: cancelForm.note,
        }),
      "Need to Order cancelled.",
    );
    if (ok) {
      setCancelForm(null);
    }
  }

  return (
    <div className="device-parts">
      <h3>
        Parts — {device.model} (device #{device.deviceNumber}) · Parts Cost:{" "}
        <strong>{data.partsCost}</strong>
        {data.openDemandEstimate !== null && (
          // Ticket 06: the estimate sits NEXT TO the cost, never inside it —
          // the demanded part is not owned yet, so it is not signed-off cost.
          <> · <span className="status-warn">{data.openDemandEstimate}</span></>
        )}
      </h3>
      <p className="placeholder">
        Parts Cost is computed from reserved parts and consumable usage — never entered by hand.
      </p>
      <p className="placeholder">
        {/* Ticket 28: the headroom the tech may still add without a manager. */}
        Price add limit: {formatMoney(data.priceAddLimitCents)} · added since approval:{" "}
        {formatMoney(data.postApprovalSpendCents)} · remaining:{" "}
        <strong>{formatMoney(data.priceAddRemainingCents)}</strong>
      </p>
      {notice && <p className="status-ok">{notice}</p>}
      {error && <p className="status-error">{error}</p>}

      {openDemand.length > 0 && (
        <div className="demand-list">
          <h4>Need to Order (device is blocked in Parts needed)</h4>
          <ul>
            {openDemand.map((record) => (
              <li
                key={record.id}
                className={record.orderedOn ? "status-ok" : "status-warn"}
              >
                {record.sku.name}
                {record.sku.priceCents !== null && record.sku.priceCents !== undefined
                  ? ` · ${formatMoney(record.sku.priceCents)}`
                  : ""}
                {record.orderedOn ? (
                  // Ticket 29: the honest wording — the part is already
                  // ordered; receipt flips it to fulfilled.
                  <> · in transit on PO #{record.orderedOn.poNumber}</>
                ) : (
                  record.supplier
                    ? ` · supplier: ${record.supplier}`
                    : " · no supplier linked"
                )}{" "}
                {/* Ticket 30: the need itself is cancellable — with a note. */}
                {cancelForm?.demandId === record.id ? (
                  <form className="form" onSubmit={(event) => void onCancelDemand(event, record.id)}>
                    <input
                      value={cancelForm.note}
                      onChange={(event) => setCancelForm({ demandId: record.id, note: event.target.value })}
                      placeholder="note: why is this need gone?"
                      required
                      style={{ maxWidth: "20rem" }}
                    />
                    <button type="submit" disabled={busy || cancelForm.note.trim() === ""}>
                      Confirm cancel
                    </button>
                    <button type="button" onClick={() => setCancelForm(null)}>
                      Back
                    </button>
                  </form>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setCancelForm({ demandId: record.id, note: "" })}
                  >
                    Cancel need to order
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <table className="table">
        <thead>
          <tr>
            <th>Serial</th>
            <th>SKU</th>
            <th>Price</th>
            <th>Added</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {activeParts.map((part) => (
            <tr key={part.id}>
              <td>
                <Link to={`/inventory/parts/${part.part.serial}`}>{part.part.serial}</Link>
              </td>
              <td>{part.sku.name}</td>
              <td>
                {part.price}
                {part.priceOverridden ? ` · price overridden (SKU ${part.sku.price})` : ""}
              </td>
              <td>{new Date(part.addedAt).toLocaleDateString()}</td>
              <td>{part.part.statusLabel}</td>
              <td className="table-actions">
                <button
                  type="button"
                  disabled={busy || !permissions.swapPart}
                  onClick={() => {
                    setAction({ attachment: part, kind: "swap" });
                    setActionForm({ destination: "available", note: "", serial: "" });
                  }}
                >
                  Swap
                </button>
                <button
                  type="button"
                  disabled={busy || !permissions.removePart}
                  onClick={() => {
                    setAction({ attachment: part, kind: "remove" });
                    // Ticket 02: the destination is ALWAYS the tech's
                    // explicit choice — no Buybackable default, the form
                    // starts unselected and cannot submit until chosen.
                    setActionForm({
                      destination: "",
                      note: "",
                      serial: "",
                    });
                  }}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
          {pastParts.map((part) => (
            <tr key={part.id} className="part-removed">
              <td>
                <Link to={`/inventory/parts/${part.part.serial}`}>{part.part.serial}</Link>
              </td>
              <td>{part.sku.name}</td>
              <td>
                {part.price}
                {part.priceOverridden ? ` · price overridden (SKU ${part.sku.price})` : ""}
              </td>
              <td>{new Date(part.addedAt).toLocaleDateString()}</td>
              <td>
                {part.removedTo === "available"
                  ? "Removed → Available"
                  : part.removedTo === "buyback"
                    ? "Removed → Buyback"
                    : part.removedTo === "rma"
                      ? "Removed → RMA"
                      : part.removedTo === "unavailable"
                        ? "Removed → Unavailable"
                        : "Removed → Damaged by Tech"}
                {part.removalNote ? ` (${part.removalNote})` : ""}
              </td>
              <td />
            </tr>
          ))}
          {data.parts.length === 0 && (
            <tr>
              <td colSpan={6} className="placeholder">
                No parts attached yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {action && (
        <form className="form" onSubmit={onSubmitAction}>
          <h4>
            {action.kind === "swap"
              ? `Swap ${action.attachment.part.serial} (another ${action.attachment.sku.name} unit will be reserved)`
              : `Remove ${action.attachment.part.serial}`}
          </h4>
          {action.kind === "swap" && (
            <label>
              Replacement serial (optional — scan to swap in that exact unit)
              <input
                value={actionForm.serial}
                onChange={(event) => setActionForm({ ...actionForm, serial: event.target.value })}
                placeholder="leave blank to reserve the oldest Available unit"
              />
            </label>
          )}
          <label>
            Destination for {action.attachment.part.serial}
            <select
              value={actionForm.destination}
              onChange={(event) => setActionForm({ ...actionForm, destination: event.target.value })}
              // Ticket 02: a removal starts UNSELECTED — no Buybackable
              // pre-selection anywhere; the form cannot submit until the
              // tech chooses. A swap keeps its Available default (the
              // swap's destination has always been explicit and required).
              required={action.kind === "remove"}
            >
              {action.kind === "remove" && (
                <option value="" disabled>
                  Choose a destination…
                </option>
              )}
              {DESTINATIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Note (required)
            <input
              value={actionForm.note}
              onChange={(event) => setActionForm({ ...actionForm, note: event.target.value })}
              placeholder="why is this part leaving the device?"
              required
            />
          </label>
          <div className="table-actions">
            <button
              type="submit"
              disabled={busy || (action.kind === "remove" && actionForm.destination === "")}
            >
              {action.kind === "swap" ? "Swap part" : "Remove part"}
            </button>
            <button type="button" onClick={() => setAction(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {(permissions.addPart || permissions.consumable) && (
        <>
          <h4>Add a part</h4>
          <form className="form" onSubmit={onAddPart}>
            <label>
              SKU (serialized units are reserved; consumables are recorded as usage)
              <SkuPicker
                skus={skus}
                value={addForm.skuId}
                onChange={(skuId) => {
                  const picked = skus.find((sku) => String(sku.id) === skuId) ?? null;
                  setAddForm({
                    ...addForm,
                    skuId,
                    // Ticket 11: the SKU's default source link pre-fills the
                    // supplier — the link the Need to Order record then
                    // carries to the PO form. The field stays editable;
                    // picking a SKU without a default clears it rather than
                    // leaking the previous SKU's link.
                    supplier: picked?.defaultSourceUrl ?? "",
                  });
                }}
                allowCreate
                onCreated={onSkuCreated}
                placeholder="Type to search parts…"
                emptyMessage="No SKUs yet"
              />
            </label>
            {pickedSku?.kind === "consumable" ? (
              <label>
                Quantity used
                <input
                  type="number"
                  min={1}
                  value={addForm.quantity}
                  onChange={(event) => setAddForm({ ...addForm, quantity: event.target.value })}
                  required
                />
              </label>
            ) : (
              <>
                <label>
                  Serial scan (optional — add that exact unit)
                  <input
                    value={addForm.serial}
                    onChange={(event) => setAddForm({ ...addForm, serial: event.target.value })}
                    placeholder="scan or type the unit's serial"
                  />
                </label>
                <label>
                  Supplier link (optional — pre-fills the purchase order when stock is short)
                  <input
                    value={addForm.supplier}
                    onChange={(event) => setAddForm({ ...addForm, supplier: event.target.value })}
                    placeholder="e.g. MobileSentrix"
                  />
                </label>
                <label>
                  Price (optional — this unit's own price, e.g. sourced from eBay)
                  <input
                    value={addForm.price}
                    onChange={(event) => setAddForm({ ...addForm, price: event.target.value })}
                    placeholder="leave blank to use the SKU price"
                  />
                </label>
              </>
            )}
            <label>
              Note (optional)
              <input
                value={addForm.note}
                onChange={(event) => setAddForm({ ...addForm, note: event.target.value })}
              />
            </label>
            <button
              type="submit"
              disabled={busy || (addForm.skuId === "" && addForm.serial.trim() === "")}
            >
              {pickedSku?.kind === "consumable" ? "Record usage" : "Add part"}
            </button>
            <p className="placeholder">
              {pickedSku?.kind === "consumable" ? (
                <>A consumable has no units to reserve — its cost is recorded on the device as
                quantity × the SKU's price, and counts toward Parts Cost and the device's price
                add limit exactly like a reserved part.</>
              ) : (
                <>By SKU, the oldest Available unit is reserved; scan a serial to add that exact unit
                instead (it must be Available). With no Available stock on the SKU path, a Need to
                Order record is created and the device waits in Parts needed.</>
              )}
            </p>
          </form>
        </>
      )}

      <h4>Consumable usage</h4>
      {data.consumables.length > 0 ? (
        <table className="table">
          <thead>
            <tr>
              <th>SKU</th>
              <th>Quantity</th>
              <th>Cost</th>
              <th>Recorded</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.consumables.map((usage) => (
              <tr key={usage.id}>
                <td>{usage.sku.name}</td>
                <td>{usage.quantity}</td>
                <td>{formatMoney(usage.costCents)}</td>
                <td>
                  {new Date(usage.recordedAt).toLocaleDateString()} by {usage.recordedBy.email}
                </td>
                <td className="table-actions">
                  {usageRemoval?.usageId === usage.id ? (
                    <form onSubmit={(event) => void onRemoveUsage(event, usage.id)}>
                      <input
                        value={usageRemoval.note}
                        onChange={(event) =>
                          setUsageRemoval({ usageId: usage.id, note: event.target.value })
                        }
                        placeholder="note: why is this usage coming off?"
                        required
                        style={{ maxWidth: "18rem" }}
                      />
                      <button type="submit" disabled={busy || usageRemoval.note.trim() === ""}>
                        Confirm removal
                      </button>
                      <button type="button" onClick={() => setUsageRemoval(null)}>
                        Back
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      disabled={busy || !permissions.removePart}
                      onClick={() => setUsageRemoval({ usageId: usage.id, note: "" })}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="placeholder">No consumable usage recorded on this device yet.</p>
      )}

      <p>
        <button type="button" onClick={onClose}>
          Close parts panel
        </button>
      </p>
    </div>
  );
}
