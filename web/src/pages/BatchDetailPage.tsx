import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { api, apiJson, ApiError } from "../api";
import { useAuth } from "../auth";
import { Modal } from "../components/Modal";
import { ModelPicker } from "../components/ModelPicker";
import { SkuPicker } from "../components/SkuPicker";
import { Timeline, type TimelineEntry } from "../components/Timeline";
import {
  DevicePartsPanel,
  type DevicePartsData,
  type PartEditPermissions,
  type SkuOption,
} from "../components/DeviceParts";

/**
 * Batch detail: the device grid (the spreadsheet columns this app replaces),
 * device status editing driven by the server-owned transition graph
 * (allowedNextStatuses on every device — this page keeps no copy of the
 * rules), the batch lifecycle (approval for managers, close with the
 * server's guard messaging, retriage via "Additional issues present"), the
 * per-device parts panel, cross-batch device history, and the one immutable
 * chronological timeline.
 */

export type RepairStatus = string;

export interface DeviceRow {
  id: number;
  deviceNumber: number | null;
  batchId: number;
  batchNumber: number;
  model: { id: number; name: string };
  capacity: string | null;
  assetId: string | null;
  imei: string | null;
  serialNumber: string | null;
  statedIssue: string;
  notes: string | null;
  // Ticket 08: the combined Loc/Bin — one optional free-text current-state
  // field, edited inline on the row; no note, no timeline event.
  locBin: string | null;
  repairTimeMinutes: number | null;
  repairStatus: RepairStatus;
  resolutionNotes: string | null;
  // Ticket 25: the manager's per-device approval decision while the batch is
  // Awaiting approval — null until decided; a rejection's note becomes the
  // Denied Repair resolution notes at batch approval.
  approvalDecision: "approved" | "rejected" | null;
  approvalDecisionNote: string | null;
  priceAddLimitCents: number;
  assignedTech: { id: number; email: string };
  triageDate: string;
  priorDeviceId: number | null;
  allowedNextStatuses: RepairStatus[];
  warnings?: string[];
}

interface BatchDetail {
  id: number;
  number: number;
  createdAt: string;
  createdBy: { id: number; email: string };
  status: string;
  approvedAt: string | null;
  approvedBy: { id: number; email: string } | null;
  approvedCost: string | null;
  closedAt: string | null;
  closedBy: { id: number; email: string } | null;
  partEditPermissions: PartEditPermissions;
  deviceCounts: Record<string, number>;
  deviceTotal: number;
  devices: DeviceRow[];
}

interface ModelOption {
  id: number;
  name: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

/**
 * The batch's current computed Parts Cost over all its devices (server-computed),
 * plus the open Need-to-Order estimate as its OWN segment (ticket 06): a demand
 * is an estimate at the SKU's current price, not a signed-off cost, so it is
 * shown next to the total — never folded into the number being signed off.
 */
function currentPartsCost(partsByDevice: Record<number, DevicePartsData>): string {
  const cents = Object.values(partsByDevice).reduce((sum, data) => sum + data.partsCostCents, 0);
  const estimate = batchNtoEstimateCents(partsByDevice);
  const total = `$${(cents / 100).toFixed(2)}`;
  return estimate > 0 ? `${total} + ${ntoEstimateLabel(estimate)}` : total;
}

/**
 * The batch-wide open-demand estimate: the sum of the server-computed
 * per-device estimate fields (ticket 06) — the client never re-prices a
 * demand from SKU data itself.
 */
function batchNtoEstimateCents(partsByDevice: Record<number, DevicePartsData>): number {
  return Object.values(partsByDevice).reduce((sum, data) => sum + data.openDemandEstimateCents, 0);
}

/** Ticket 06: the "estimated, not signed-off" wording for an aggregate estimate. */
function ntoEstimateLabel(cents: number): string {
  return `NTO — est. $${(cents / 100).toFixed(2)}`;
}

const emptyDeviceForm = {
  modelId: "",
  capacity: "",
  assetId: "",
  imei: "",
  serialNumber: "",
  locBin: "",
  statedIssue: "",
  notes: "",
  repairTimeMinutes: "",
};

export function BatchDetailPage() {
  const { id } = useParams();
  const batchId = Number(id);
  const { user } = useAuth();
  const [batch, setBatch] = useState<BatchDetail | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [skus, setSkus] = useState<SkuOption[]>([]);
  const [partsByDevice, setPartsByDevice] = useState<Record<number, DevicePartsData>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deviceForm, setDeviceForm] = useState({ ...emptyDeviceForm });
  const [addingDevice, setAddingDevice] = useState(false);
  // Pre-attach (the add-device modal): the parts the device should enter the
  // batch with — picked SKUs (serialized units are reserved; consumables are
  // recorded as usage at quantity × price) AND/OR scanned serials. One POST —
  // the server creates the device AND attaches every entry through the one
  // cores, atomically.
  const [preAttach, setPreAttach] = useState<
    Array<{ kind: "sku"; sku: SkuOption; quantity: string } | { kind: "serial"; serial: string }>
  >([]);
  const [preAttachPicker, setPreAttachPicker] = useState("");
  const [preAttachSerial, setPreAttachSerial] = useState("");
  const [preAttachNote, setPreAttachNote] = useState("");
  const [noteText, setNoteText] = useState("");
  const [approvalNote, setApprovalNote] = useState("");
  const [bulkLimit, setBulkLimit] = useState("");

  const reload = useCallback(async () => {
    if (!Number.isInteger(batchId) || batchId <= 0) {
      setError("invalid batch id");
      return;
    }
    try {
      const [detail, entries, modelList, skuList, parts] = await Promise.all([
        api<BatchDetail>(`/api/batches/${batchId}`),
        api<TimelineEntry[]>(`/api/batches/${batchId}/timeline`),
        api<ModelOption[]>("/api/models"),
        api<SkuOption[]>("/api/skus"),
        api<{ devices: DevicePartsData[] }>(`/api/batches/${batchId}/parts`),
      ]);
      setBatch(detail);
      setTimeline(entries);
      setModels(modelList);
      setSkus(skuList);
      setPartsByDevice(
        Object.fromEntries(parts.devices.map((entry) => [entry.deviceId, entry])),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not load the batch");
    }
  }, [batchId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Ticket 07: a model created inline (or selected after a 409 duplicate)
  // joins the catalog list — deduped by id, since the 409 path can hand
  // back a row the list already carries.
  const onModelCreated = useCallback((model: ModelOption) => {
    setModels((all) => (all.some((m) => m.id === model.id) ? all : [...all, model]));
  }, []);

  async function run(action: () => Promise<unknown>, done: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    setWarning(null);
    try {
      await action();
      setNotice(done);
      await reload();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function onAddDevice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    setWarning(null);
    try {
      const created = await apiJson<DeviceRow & { warnings?: string[] }>(
        `/api/batches/${batchId}/devices`,
        {
          modelId: deviceForm.modelId === "" ? undefined : Number(deviceForm.modelId),
          capacity: deviceForm.capacity,
          assetId: deviceForm.assetId,
          imei: deviceForm.imei,
          serialNumber: deviceForm.serialNumber,
          locBin: deviceForm.locBin,
          statedIssue: deviceForm.statedIssue,
          notes: deviceForm.notes,
          repairTimeMinutes:
            deviceForm.repairTimeMinutes === "" ? undefined : Number(deviceForm.repairTimeMinutes),
          preAttach:
            preAttach.length > 0
              ? preAttach.map((entry) =>
                  entry.kind === "sku"
                    ? entry.sku.kind === "consumable"
                      ? { skuId: entry.sku.id, quantity: Number(entry.quantity) }
                      : { skuId: entry.sku.id }
                    : { serial: entry.serial },
                )
              : undefined,
          preAttachNote:
            preAttach.length > 0 && preAttachNote.trim() !== "" ? preAttachNote : undefined,
        },
      );
      if (created.warnings && created.warnings.length > 0) {
        setWarning(created.warnings[0]);
      }
      setNotice(
        preAttach.length > 0
          ? `Device added with ${preAttach.length} part${preAttach.length === 1 ? "" : "s"} pre-attached.`
          : "Device added.",
      );
      await reload();
      setDeviceForm({ ...emptyDeviceForm });
      setPreAttach([]);
      setPreAttachPicker("");
      setPreAttachNote("");
      setAddingDevice(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
    } finally {
      setBusy(false);
    }
  }

  async function onAddNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const added = await run(
      () => apiJson(`/api/batches/${batchId}/notes`, { note: noteText }),
      "Note added.",
    );
    if (added) {
      setNoteText("");
    }
  }

  async function onApprove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const approved = await run(
      () =>
        apiJson(
          `/api/batches/${batchId}/approve`,
          // The note is optional: an empty input sends NO note key at all —
          // the server accepts a noteless approval but refuses a
          // given-but-blank note.
          approvalNote.trim() === "" ? {} : { note: approvalNote }
        ),
      "Batch approved.",
    );
    if (approved) {
      setApprovalNote("");
    }
  }

  // Ticket 28: apply one Price Add Limit to every undecided device at once —
  // one PATCH per device to the manager's price-limit endpoint (decisions
  // are left untouched).
  async function onApplyLimitToUndecided(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!batch) {
      return;
    }
    const cents = Math.round(Number(bulkLimit) * 100);
    const targets = batch.devices.filter((device) => device.approvalDecision === null);
    const ok = await run(
      async () => {
        for (const device of targets) {
          await apiJson(
            `/api/batches/${batchId}/devices/${device.id}/price-limit`,
            { priceAddLimitCents: cents },
            "PATCH",
          );
        }
      },
      `Price add limit applied to ${targets.length} device${targets.length === 1 ? "" : "s"}.`,
    );
    if (ok) {
      setBulkLimit("");
    }
  }

  // Bulk "Approve all devices": one POST approves every device with no
  // decision yet — the server leaves devices already decided (rejected ones
  // included) untouched, so a rejection never flips silently.
  async function onApproveAllDevices() {
    await run(
      () => apiJson<{ approved: number }>(`/api/batches/${batchId}/devices/approve-all`, {}),
      "All undecided devices approved — review the decisions, then approve the batch.",
    );
  }

  async function onCloseBatch() {
    await run(() => apiJson(`/api/batches/${batchId}/close`, {}), "Batch closed.");
  }

  if (error && !batch) {
    return (
      <section>
        <h2>Batch</h2>
        <p className="status-error">{error}</p>
        <Link to="/batches">Back to batches</Link>
      </section>
    );
  }
  if (!batch) {
    return (
      <section>
        <h2>Batch #{id}</h2>
        <p className="placeholder">Loading…</p>
      </section>
    );
  }

  const visibleCounts = Object.entries(batch.deviceCounts).filter(([, n]) => n > 0);
  const undecidedCount = batch.devices.filter((device) => device.approvalDecision === null).length;

  return (
    <section>
      <p>
        <Link to="/batches">← All batches</Link>
      </p>
      <h2>Batch #{batch.number}</h2>
      <p className="placeholder">
        Created {formatDate(batch.createdAt)} by {batch.createdBy.email} · {batch.deviceTotal}{" "}
        {batch.deviceTotal === 1 ? "device" : "devices"} · <strong>{batch.status}</strong>
        {batch.status === "Open" && batch.approvedCost !== null && (
          <> · approved cost {`$${batch.approvedCost}`}</>
        )}
        {(() => {
          // Ticket 06: open Need-to-Order demand adds no stored cost, so the
          // status line names its estimate NEXT TO the approved cost instead
          // of letting the stored figure understate the batch's outlook.
          const estimate = batchNtoEstimateCents(partsByDevice);
          return estimate > 0 ? (
            <span className="status-warn"> · {ntoEstimateLabel(estimate)}</span>
          ) : null;
        })()}
        {batch.closedAt && <> · closed {formatDate(batch.closedAt)}</>}
      </p>
      {visibleCounts.length > 0 && (
        <p>
          {visibleCounts.map(([key, n]) => (
            <strong key={key}>
              {LABELS[key] ?? key}: {n}{" "}
            </strong>
          ))}
        </p>
      )}
      {notice && <p className="status-ok">{notice}</p>}
      {warning && <p className="status-warn">{warning}</p>}
      {error && <p className="status-error">{error}</p>}

      {batch.status === "Awaiting approval" && (
        <section className="lifecycle">
          <h3>Approval</h3>
          {user?.role === "manager" ? (
            <>
              <form className="form" onSubmit={onApprove}>
                <p className="placeholder">
                  Approving signs off the parts cost (currently {currentPartsCost(partsByDevice)}).
                  Decide each device below first.
                </p>
                <label>
                  Approval note (optional)
                  <input
                    value={approvalNote}
                    onChange={(event) => setApprovalNote(event.target.value)}
                    placeholder=" "
                  />
                </label>
                <button
                  type="submit"
                  disabled={busy || undecidedCount > 0}
                  title={undecidedCount > 0 ? "Decide every device first" : undefined}
                >
                  {undecidedCount > 0
                    ? `Approve batch (${undecidedCount} undecided)`
                    : "Approve batch"}
                </button>
              </form>
              {undecidedCount > 0 && (
                <p>
                  <button type="button" disabled={busy} onClick={() => void onApproveAllDevices()}>
                    Approve all devices ({undecidedCount} undecided)
                  </button>
                </p>
              )}
              {undecidedCount > 0 && (
                <form className="form" onSubmit={onApplyLimitToUndecided}>
                  <p className="placeholder">
                    Set one Price Add Limit on all {undecidedCount} undecided device
                    {undecidedCount === 1 ? "" : "s"} at once (each device keeps its own decision).
                  </p>
                  <label>
                    Price add limit ($)
                    <input
                      value={bulkLimit}
                      onChange={(event) => setBulkLimit(event.target.value)}
                      placeholder="e.g. 250.00"
                      inputMode="decimal"
                      required
                    />
                  </label>
                  <button type="submit" disabled={busy}>
                    Apply limit to undecided
                  </button>
                </form>
              )}
            </>
          ) : (
            <p className="placeholder">
              Awaiting a manager's approval.
            </p>
          )}
        </section>
      )}
      {batch.status === "Open" && (
        <section className="lifecycle">
          <h3>Close</h3>
          <p className="placeholder">
            Closing requires every device to be in a terminal status (Repaired, Unrepairable, Additional issues
            present, or Denied Repair).
          </p>
          <button type="button" disabled={busy} onClick={() => void onCloseBatch()}>
            Close batch
          </button>
        </section>
      )}

      {/* Ticket 30 follow-up: the add-device button sits ABOVE the batch
          lines, and its form lives in a modal — the grid and the form are
          never on screen at opposite ends of a scroll. */}
      <p>
        <button type="button" disabled={busy} onClick={() => setAddingDevice(true)}>
          Add a device
        </button>
      </p>

      <DeviceGrid
        batchId={batch.id}
        devices={batch.devices}
        models={models}
        skus={skus}
        onSkuCreated={(sku) => setSkus((all) => [...all, sku])}
        onModelCreated={onModelCreated}
        partsByDevice={partsByDevice}
        permissions={batch.partEditPermissions}
        onChanged={reload}
        canDecideApproval={batch.status === "Awaiting approval" && user?.role === "manager"}
        canRemoveDevice={batch.status !== "Closed"}
      />

      {/* The same door from below the grid: a long batch should not force a
          scroll back to the top to add the next device. */}
      <p>
        <button type="button" disabled={busy} onClick={() => setAddingDevice(true)}>
          Add a device
        </button>
      </p>

      {addingDevice && (
        <Modal title="Add a device" onClose={() => setAddingDevice(false)}>
          <form className="form" onSubmit={onAddDevice}>
        {/* Ticket 07: one ModelPicker replaces the pick-or-type pair — the
            same fuzzy search as SKU search, with inline create-if-missing
            through POST /api/models (the server dedupes case-insensitively
            and a 409 selects the existing row). */}
        <label>
          Model
          <ModelPicker
            models={models}
            value={deviceForm.modelId}
            onChange={(modelId) => setDeviceForm({ ...deviceForm, modelId })}
            onCreated={onModelCreated}
            placeholder="Type to search models…"
          />
        </label>
        <label>
          Capacity
          <input
            value={deviceForm.capacity}
            onChange={(event) => setDeviceForm({ ...deviceForm, capacity: event.target.value })}
            placeholder=""
          />
        </label>
        <label>
          IMEI
          <input
            value={deviceForm.imei}
            onChange={(event) => setDeviceForm({ ...deviceForm, imei: event.target.value })}
            placeholder=""
          />
        </label>
        <label>
          Asset ID
          <input
            value={deviceForm.assetId}
            onChange={(event) => setDeviceForm({ ...deviceForm, assetId: event.target.value })}
            placeholder=""
          />
        </label>
        <label>
          Serial number
          <input
            value={deviceForm.serialNumber}
            onChange={(event) => setDeviceForm({ ...deviceForm, serialNumber: event.target.value })}
          />
        </label>
        <label>
          {/* Ticket 08: one combined free-text field, optional at creation. */}
          Loc/Bin
          <input
            value={deviceForm.locBin}
            onChange={(event) => setDeviceForm({ ...deviceForm, locBin: event.target.value })}
            placeholder="e.g. Shelf 3 / Bin B"
          />
        </label>
        <label>
          Stated Issue
          <input
            value={deviceForm.statedIssue}
            onChange={(event) => setDeviceForm({ ...deviceForm, statedIssue: event.target.value })}
            placeholder=""
            required
          />
        </label>
        <label>
          Notes (cosmetic issues, PCL, MDM)
          <input
            value={deviceForm.notes}
            onChange={(event) => setDeviceForm({ ...deviceForm, notes: event.target.value })}
          />
        </label>
        <label>
          Repair Time (minutes)
          <input
            type="number"
            min={0}
            value={deviceForm.repairTimeMinutes}
            onChange={(event) =>
              setDeviceForm({ ...deviceForm, repairTimeMinutes: event.target.value })
            }
            placeholder=""
          />
        </label>
        <label>
          Parts to pre-attach (optional — the device enters the batch with them)
          <SkuPicker
            skus={skus}
            value={preAttachPicker}
            onChange={(skuId) => setPreAttachPicker(skuId)}
            allowCreate
            onCreated={(sku) => setSkus((all) => [...all, sku])}
            placeholder="Type to search parts…"
            // Ticket 07: the chosen model immediately reshapes the
            // suggestions — SKUs matching the model sort first.
            suggestFor={models.find((model) => String(model.id) === deviceForm.modelId)?.name}
            emptyMessage="No SKUs yet"
          />
        </label>
        <div className="table-actions">
          <button
            type="button"
            disabled={busy || preAttachPicker === ""}
            onClick={() => {
              const picked = skus.find((sku) => String(sku.id) === preAttachPicker);
              if (
                picked &&
                !preAttach.some((entry) => entry.kind === "sku" && entry.sku.id === picked.id)
              ) {
                setPreAttach((all) => [...all, { kind: "sku", sku: picked, quantity: "1" }]);
              }
              setPreAttachPicker("");
            }}
          >
            Add picked SKU to list
          </button>
        </div>
        <label>
          …or scan a serial to pre-attach that exact unit
          <input
            value={preAttachSerial}
            onChange={(event) => setPreAttachSerial(event.target.value)}
            placeholder="scan or type the unit's serial"
          />
        </label>
        <div className="table-actions">
          <button
            type="button"
            disabled={busy || preAttachSerial.trim() === ""}
            onClick={() => {
              const serial = preAttachSerial.trim();
              if (!preAttach.some((entry) => entry.kind === "serial" && entry.serial === serial)) {
                setPreAttach((all) => [...all, { kind: "serial", serial }]);
              }
              setPreAttachSerial("");
            }}
          >
            Add scanned serial to list
          </button>
        </div>
        {preAttach.length > 0 && (
          <ul>
            {preAttach.map((entry, index) => (
              <li key={`${entry.kind}-${entry.kind === "sku" ? entry.sku.id : entry.serial}-${index}`}>
                {entry.kind === "sku"
                  ? `${entry.sku.name} · ${entry.sku.price}`
                  : `serial ${entry.serial}`}{" "}
                {entry.kind === "sku" && entry.sku.kind === "consumable" && (
                  <label>
                    quantity{" "}
                    <input
                      type="number"
                      min={1}
                      value={entry.quantity}
                      onChange={(event) =>
                        setPreAttach((all) =>
                          all.map((e) =>
                            e === entry ? { ...e, quantity: event.target.value } : e,
                          ),
                        )
                      }
                      style={{ width: "4rem" }}
                    />
                  </label>
                )}{" "}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setPreAttach((all) => all.filter((e) => e !== entry))}
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {preAttach.length > 0 && (
          <label>
            Note for attached parts (optional)
            <input
              value={preAttachNote}
              onChange={(event) => setPreAttachNote(event.target.value)}
            />
          </label>
        )}
        <p className="placeholder">
          Each pre-attached serialized SKU reserves its oldest Available unit; a scanned serial
          reserves that exact unit; a consumable SKU is recorded as usage (quantity × its price —
          the cost is tracked, the item has no units); with no stock on the SKU path, a Need to
          Order record is created instead. One transaction — if any part is refused (for example,
          over a device's price add limit on an approved batch), the device is not created.
        </p>
        <p className="placeholder">
          Triage Date is set automatically; Assigned Tech defaults to you.
        </p>
        <button type="submit" disabled={busy}>
          Add device
        </button>
          </form>
        </Modal>
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
      {/* The one timeline renderer (components/Timeline.tsx) — the batch's
          own events and its devices' events, one chronological list. */}
      <Timeline events={timeline} />
    </section>
  );
}

const LABELS: Record<string, string> = {
  awaitingRepair: "Awaiting repair",
  inProgress: "In progress",
  qa: "QA",
  repaired: "Repaired",
  unrepairable: "Unrepairable",
  partsNeeded: "Parts needed",
  additionalIssuesPresent: "Additional issues present",
  deniedRepair: "Denied Repair",
};

function DeviceGrid({
  batchId,
  devices,
  models,
  skus,
  onSkuCreated,
  onModelCreated,
  partsByDevice,
  permissions,
  onChanged,
  canDecideApproval,
  canRemoveDevice,
}: {
  batchId: number;
  devices: DeviceRow[];
  models: ModelOption[];
  skus: SkuOption[];
  /** Ticket 24: a SKU created inline in the parts panel joins the catalog list. */
  onSkuCreated: (sku: SkuOption) => void;
  /** Ticket 07: a model created inline in the edit form joins the catalog list. */
  onModelCreated: (model: ModelOption) => void;
  partsByDevice: Record<number, DevicePartsData>;
  permissions: PartEditPermissions;
  onChanged: () => Promise<void>;
  /** Ticket 25: manager + Awaiting approval — the per-device decision column renders. */
  canDecideApproval: boolean;
  /** Ticket 30: Awaiting approval or Open — any tech may offer device removal. */
  canRemoveDevice: boolean;
}) {
  const [editing, setEditing] = useState<DeviceRow | null>(null);
  const [partsDevice, setPartsDevice] = useState<DeviceRow | null>(null);
  const [historyDevice, setHistoryDevice] = useState<DeviceRow | null>(null);
  const [history, setHistory] = useState<DeviceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onAction(action: () => Promise<unknown>): Promise<unknown> {
    setBusy(true);
    setError(null);
    setWarning(null);
    try {
      const result = await action();
      await onChanged();
      return result;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function toggleHistory(device: DeviceRow) {
    if (historyDevice?.id === device.id) {
      setHistoryDevice(null);
      setHistory(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ history: DeviceRow[] }>(
        `/api/batches/${batchId}/devices/${device.id}/history`,
      );
      setHistoryDevice(device);
      setHistory(data.history);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && <p className="status-error">{error}</p>}
      {warning && <p className="status-warn">{warning}</p>}
      <table className="table">
        <thead>
          <tr>
            <th>Device #</th>
            <th>Model</th>
            <th>Capacity</th>
            {/* Ticket 08: the combined Loc/Bin — an inline current-state cell. */}
            <th>Loc/Bin</th>
            <th>Asset ID</th>
            <th>IMEI</th>
            <th>Stated Issue</th>
            <th>Notes</th>
            <th>Repair Time</th>
            <th>Repair Status</th>
            <th>Resolution notes</th>
            {canDecideApproval && <th>Approval</th>}
            <th>Assigned Tech</th>
            <th>Triage Date</th>
            <th>Parts Cost</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {devices.map((device) => (
            <tr key={device.id}>
              <td>
                <strong>#{device.deviceNumber}</strong>
              </td>
              <td>{device.model.name}</td>
              <td>{device.capacity ?? "—"}</td>
              <td>
                <LocBinControl batchId={batchId} device={device} busy={busy} onAction={onAction} />
              </td>
              <td>{device.assetId ?? "—"}</td>
              <td>{device.imei ?? "—"}</td>
              <td>{device.statedIssue}</td>
              <td>{device.notes ?? "—"}</td>
              <td>{device.repairTimeMinutes === null ? "—" : `${device.repairTimeMinutes}m`}</td>
              <td>
                <StatusControl
                  batchId={batchId}
                  device={device}
                  busy={busy}
                  onAction={onAction}
                />
              </td>
              <td>{device.resolutionNotes ?? "—"}</td>
              {canDecideApproval && (
                <td>
                  <ApprovalControl batchId={batchId} device={device} busy={busy} onAction={onAction} />
                </td>
              )}
              <td>{device.assignedTech.email}</td>
              <td>{formatDate(device.triageDate)}</td>
              <td>
                {partsByDevice[device.id] ? (
                  <>
                    {partsByDevice[device.id].partsCost}
                    {/* Ticket 06: the open demand's estimate is the server's
                        explicit field, shown next to the cost — the demanded
                        part is not owned yet, so it is not signed-off cost. */}
                    {partsByDevice[device.id].openDemandEstimate && (
                      <span className="status-warn">
                        {" "}· {partsByDevice[device.id].openDemandEstimate}
                      </span>
                    )}
                    {partsByDevice[device.id].demand.some((d) => d.status === "open") && (
                      <span className="status-warn"> · Parts needed</span>
                    )}
                  </>
                ) : (
                  "—"
                )}
              </td>
              <td className="table-actions">
                <button type="button" disabled={busy} onClick={() => setEditing(device)}>
                  Edit
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    setPartsDevice(partsDevice?.id === device.id ? null : device)
                  }
                >
                  Parts
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void toggleHistory(device)}
                >
                  History
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {partsDevice && (
        <Modal
          title={`Parts — device #${partsDevice.deviceNumber}`}
          onClose={() => setPartsDevice(null)}
        >
          <DevicePartsPanel
            batchId={batchId}
            device={{ id: partsDevice.id, model: partsDevice.model.name, deviceNumber: partsDevice.deviceNumber }}
            data={
            partsByDevice[partsDevice.id] ?? {
              deviceId: partsDevice.id,
              parts: [],
              consumables: [],
              demand: [],
              partsCostCents: 0,
              partsCost: "0.00",
              openDemandEstimateCents: 0,
              openDemandEstimate: null,
              priceAddLimitCents: 0,
              postApprovalSpendCents: 0,
              priceAddRemainingCents: 0,
            }
          }
            skus={skus}
            onSkuCreated={onSkuCreated}
            permissions={permissions}
            onChanged={onChanged}
            onClose={() => setPartsDevice(null)}
          />
        </Modal>
      )}
      {historyDevice && (
        // Ticket 30 follow-up: history is a modal too — one design language
        // for every form and panel on the page.
        <Modal
          title={`History — ${historyDevice.model.name} (device #${historyDevice.deviceNumber})`}
          onClose={() => { setHistoryDevice(null); setHistory(null); }}
        >
          <p className="placeholder">
            Matched by IMEI, Asset ID, or serial number, plus the retriage chain
            (device rows linked across batches).
          </p>
          {history !== null && history.length > 0 ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Batch</th>
                  <th>Model</th>
                  <th>IMEI</th>
                  <th>Asset ID</th>
                  <th>Serial number</th>
                  <th>Repair Status</th>
                  <th>Triage Date</th>
                  <th>Retriage</th>
                </tr>
              </thead>
              <tbody>
                {history.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <Link to={`/batches/${entry.batchId}`}>#{entry.batchNumber}</Link>
                    </td>
                    <td>{entry.model.name}</td>
                    <td>{entry.imei ?? "—"}</td>
                    <td>{entry.assetId ?? "—"}</td>
                    <td>{entry.serialNumber ?? "—"}</td>
                    <td>{entry.repairStatus}</td>
                    <td>{formatDate(entry.triageDate)}</td>
                    <td>
                      {entry.priorDeviceId !== null
                        ? `continues device #${entry.priorDeviceId}`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="placeholder">No other batches match this device's identifiers.</p>
          )}
        </Modal>
      )}
      {editing && (
        <DeviceEditForm
          batchId={batchId}
          device={editing}
          models={models}
          onModelCreated={onModelCreated}
          busy={busy}
          canRemoveDevice={canRemoveDevice}
          onClose={() => setEditing(null)}
          onSaved={async (warnings) => {
            setWarning(warnings.length > 0 ? warnings[0] : null);
            await onChanged();
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

/**
 * The Loc/Bin cell (ticket 08): the device's current shelf location, edited
 * INLINE on the row — no note, no modal, and no timeline event (it is where
 * the device sits NOW, not something that happened to it). Spreadsheet-cell
 * editing: the input is seeded with the current value, Save commits it;
 * an unset value renders the "—" placeholder, never a silent blank, and
 * saving an emptied cell CLEARS the field (present-but-empty = cleared
 * PATCH semantics).
 */
function LocBinControl({
  batchId,
  device,
  busy,
  onAction,
}: {
  batchId: number;
  device: DeviceRow;
  busy: boolean;
  onAction: (action: () => Promise<unknown>) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState(device.locBin ?? "");
  // Re-seed from the server row after every reload (each action reloads the
  // batch) so the cell never shows a value the server no longer has.
  useEffect(() => {
    setDraft(device.locBin ?? "");
  }, [device.locBin]);
  const unchanged = draft === (device.locBin ?? "");
  return (
    <span className="loc-bin-control">
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="—"
        disabled={busy}
        aria-label={`Loc/Bin — device #${device.deviceNumber}`}
        style={{ maxWidth: "9rem" }}
      />
      <button
        type="button"
        disabled={busy || unchanged}
        onClick={() => {
          void onAction(() =>
            apiJson(
              `/api/batches/${batchId}/devices/${device.id}`,
              { locBin: draft.trim() },
              "PATCH",
            ),
          );
        }}
      >
        Save
      </button>
    </span>
  );
}

function StatusControl({
  batchId,
  device,
  busy,
  onAction,
}: {
  batchId: number;
  device: DeviceRow;
  busy: boolean;
  onAction: (action: () => Promise<unknown>) => Promise<unknown>;
}) {
  const [target, setTarget] = useState<RepairStatus | "">("");
  const [resolutionNotes, setResolutionNotes] = useState("");
  const [retriagedTo, setRetriagedTo] = useState<{ batchId: number; batchNumber: number } | null>(
    null,
  );
  // The options ARE the server-owned graph (narrowed by the batch lifecycle);
  // an empty list means the device is terminal on this batch.
  const options = device.allowedNextStatuses ?? [];

  if (options.length === 0) {
    return <span>{device.repairStatus} (terminal)</span>;
  }
  return (
    <span className="status-control">
      {device.repairStatus} →{" "}
      <select value={target} onChange={(event) => setTarget(event.target.value as RepairStatus | "")}>
        <option value="">choose…</option>
        {options.map((status) => (
          <option key={status} value={status}>
            {status}
          </option>
        ))}
      </select>
      {target !== "" && (
        <input
          value={resolutionNotes}
          onChange={(event) => setResolutionNotes(event.target.value)}
          placeholder="Resolution notes"
        />
      )}
      <button
        type="button"
        disabled={busy || target === ""}
        onClick={() => {
          const chosen = target as RepairStatus;
          void onAction(() =>
            apiJson<DeviceRow & { retriagedTo?: { batchId: number; batchNumber: number; deviceId: number } }>(
              `/api/batches/${batchId}/devices/${device.id}/status`,
              {
                repairStatus: chosen,
                resolutionNotes: resolutionNotes === "" ? undefined : resolutionNotes,
              },
            ),
          ).then((untyped) => {
            setTarget("");
            setResolutionNotes("");
            const response = untyped as
              | { retriagedTo?: { batchId: number; batchNumber: number; deviceId: number } }
              | undefined;
            if (response?.retriagedTo) {
              setRetriagedTo(response.retriagedTo);
            }
          });
        }}
      >
        Set
      </button>
      {retriagedTo && (
        <span className="status-warn">
          {" "}
          <Link to={`/batches/${retriagedTo.batchId}`}>
            retriaged onto batch #{retriagedTo.batchNumber}
          </Link>
        </span>
      )}
    </span>
  );
}

/**
 * The per-device approval decision (ticket 25): visible only while the
 * batch is Awaiting approval AND the viewer is a manager (the server
 * enforces both; this component renders the phase). Shows the current
 * decision; Approve decides on the spot, Reject requires a note — that
 * note becomes the Denied Repair resolution notes at batch approval.
 * Re-deciding before the batch opens is allowed; the latest wins.
 */
function ApprovalControl({
  batchId,
  device,
  busy,
  onAction,
}: {
  batchId: number;
  device: DeviceRow;
  busy: boolean;
  onAction: (action: () => Promise<unknown>) => Promise<unknown>;
}) {
  const [note, setNote] = useState("");
  // Ticket 28: the Price Add Limit, typed in dollars and sent as cents. The
  // input starts empty — leaving it alone keeps the device's standing limit.
  const [limit, setLimit] = useState("");
  const decision = device.approvalDecision;

  function decide(next: "approved" | "rejected"): void {
    const limitCents = limit.trim() === "" ? undefined : Math.round(Number(limit) * 100);
    void onAction(() =>
      apiJson<DeviceRow>(
        `/api/batches/${batchId}/devices/${device.id}/approval`,
        next === "rejected"
          ? { decision: next, note: note.trim(), priceAddLimitCents: limitCents }
          : { decision: next, priceAddLimitCents: limitCents },
      ),
    ).then(() => {
      if (next === "rejected") {
        // keep the note — it is what the denial will carry
        return;
      }
      setNote("");
      setLimit("");
    });
  }

  return (
    <span className="approval-control">
      <span>
        {decision === null
          ? "undecided"
          : decision === "approved"
            ? `approved · limit $${(device.priceAddLimitCents / 100).toFixed(2)}`
            : `rejected${device.approvalDecisionNote ? ` — ${device.approvalDecisionNote}` : ""}`}
      </span>
      <input
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="rejection note (optional)"
        style={{ maxWidth: "16rem" }}
      />
      <input
        value={limit}
        onChange={(event) => setLimit(event.target.value)}
        placeholder="price add limit $ (blank = keep)"
        inputMode="decimal"
        style={{ maxWidth: "12rem" }}
      />
      <button
        type="button"
        disabled={busy || decision === "approved"}
        onClick={() => decide("approved")}
      >
        Approve
      </button>
      {/* Re-deciding is allowed until the batch opens (latest wins), so each
          button locks only on ITS OWN current decision — a device approved by
          mistake can still be rejected here, and vice versa. */}
      <button
        type="button"
        disabled={busy || decision === "rejected"}
        onClick={() => decide("rejected")}
      >
        Reject
      </button>
    </span>
  );
}

/**
 * Edit device (ticket 30 follow-up): opens in a MODAL so the grid and the
 * form are never on screen at opposite ends of a scroll. The bottom of the
 * modal carries the ticket-30 removal: "Remove from this batch" with a
 * required note — parts return to Available, open Need to Order demand is
 * cancelled; terminal devices and Closed batches are refused by the server
 * (the section is offered only where the batch state makes removal possible).
 */
function DeviceEditForm({
  batchId,
  device,
  models,
  onModelCreated,
  busy,
  canRemoveDevice,
  onClose,
  onSaved,
}: {
  batchId: number;
  device: DeviceRow;
  models: ModelOption[];
  /** Ticket 07: a model created inline in this form joins the catalog list. */
  onModelCreated: (model: ModelOption) => void;
  busy: boolean;
  canRemoveDevice: boolean;
  onClose: () => void;
  onSaved: (warnings: string[]) => Promise<void>;
}) {
  const [form, setForm] = useState({
    modelId: String(device.model.id),
    capacity: device.capacity ?? "",
    assetId: device.assetId ?? "",
    imei: device.imei ?? "",
    serialNumber: device.serialNumber ?? "",
    // Ticket 08: the combined Loc/Bin — also editable here; emptying the box
    // clears it (present-but-empty = cleared).
    locBin: device.locBin ?? "",
    statedIssue: device.statedIssue,
    notes: device.notes ?? "",
    repairTimeMinutes: device.repairTimeMinutes === null ? "" : String(device.repairTimeMinutes),
    resolutionNotes: device.resolutionNotes ?? "",
    assignedTechId: String(device.assignedTech.id),
  });
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeNote, setRemoveNote] = useState("");
  const [removeError, setRemoveError] = useState<string | null>(null);

  async function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      const response = await apiJson<DeviceRow & { warnings?: string[] }>(
        `/api/batches/${batchId}/devices/${device.id}`,
        {
          modelId: Number(form.modelId),
          capacity: form.capacity,
          assetId: form.assetId,
          imei: form.imei,
          serialNumber: form.serialNumber,
          locBin: form.locBin,
          statedIssue: form.statedIssue,
          notes: form.notes,
          repairTimeMinutes: form.repairTimeMinutes === "" ? undefined : Number(form.repairTimeMinutes),
          resolutionNotes: form.resolutionNotes === "" ? undefined : form.resolutionNotes,
          assignedTechId: Number(form.assignedTechId),
        },
        "PATCH",
      );
      await onSaved(response.warnings ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
    }
  }

  // Ticket 30: the removal is its own confirm step inside the modal — a
  // success closes the whole modal (the row is gone).
  async function onRemove() {
    setRemoveError(null);
    try {
      await apiJson(`/api/batches/${batchId}/devices/${device.id}/remove`, {
        note: removeNote.trim(),
      });
      setRemoving(false);
      await onSaved([]);
    } catch (err) {
      setRemoveError(err instanceof ApiError ? err.message : "the request failed");
    }
  }

  return (
    <Modal
      title={`Edit device #${device.deviceNumber}`}
      onClose={onClose}
    >
      <form className="form" onSubmit={onSave}>
      {error && <p className="status-error">{error}</p>}
      {/* Ticket 07: the edit form's model field is the same ModelPicker —
          one model-entry control everywhere. */}
      <label>
        Model
        <ModelPicker
          models={models}
          value={form.modelId}
          onChange={(modelId) => setForm({ ...form, modelId })}
          onCreated={onModelCreated}
          placeholder="Type to search models…"
        />
      </label>
      <label>
        Capacity
        <input value={form.capacity} onChange={(event) => setForm({ ...form, capacity: event.target.value })} />
      </label>
      <label>
        IMEI
        <input value={form.imei} onChange={(event) => setForm({ ...form, imei: event.target.value })} />
      </label>
      <label>
        Asset ID
        <input value={form.assetId} onChange={(event) => setForm({ ...form, assetId: event.target.value })} />
      </label>
      <label>
        Serial number
        <input
          value={form.serialNumber}
          onChange={(event) => setForm({ ...form, serialNumber: event.target.value })}
        />
      </label>
      <label>
        {/* Ticket 08: the same combined field the row edits inline. */}
        Loc/Bin
        <input value={form.locBin} onChange={(event) => setForm({ ...form, locBin: event.target.value })} />
      </label>
      <label>
        Stated Issue
        <input
          value={form.statedIssue}
          onChange={(event) => setForm({ ...form, statedIssue: event.target.value })}
          required
        />
      </label>
      <label>
        Notes (cosmetic issues, PCL, MDM)
        <input value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
      </label>
      <label>
        Repair Time (minutes)
        <input
          type="number"
          min={0}
          value={form.repairTimeMinutes}
          onChange={(event) => setForm({ ...form, repairTimeMinutes: event.target.value })}
        />
      </label>
      <label>
        Resolution notes
        <input
          value={form.resolutionNotes}
          onChange={(event) => setForm({ ...form, resolutionNotes: event.target.value })}
        />
      </label>
      <label>
        Assigned Tech (user id)
        <input
          type="number"
          min={1}
          value={form.assignedTechId}
          onChange={(event) => setForm({ ...form, assignedTechId: event.target.value })}
        />
      </label>
      <p className="placeholder">
        Repair Status changes go through the row's status control, not this form.
      </p>
      <div className="table-actions">
        <button type="submit" disabled={busy}>
          Save
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
      </form>

      {canRemoveDevice && (
        <div className="device-parts">
          <h4>Remove from this batch</h4>
          <p className="placeholder">
            Ends this device's run here: its parts return to Available stock, its open Need to
            Order records are cancelled, and it leaves the grid, counts, and costs. The row and
            its history remain. Terminal devices (Repaired, Unrepairable, Denied Repair) cannot
            be removed.
          </p>
          {removeError && <p className="status-error">{removeError}</p>}
          {removing ? (
            <form className="form" onSubmit={(event) => { event.preventDefault(); void onRemove(); }}>
              <label>
                Note (required)
                <input
                  value={removeNote}
                  onChange={(event) => setRemoveNote(event.target.value)}
                  placeholder="why is this device leaving the batch?"
                  required
                />
              </label>
              <div className="table-actions">
                <button type="submit" disabled={busy || removeNote.trim() === ""}>
                  Confirm remove
                </button>
                <button type="button" onClick={() => setRemoving(false)}>
                  Back
                </button>
              </div>
            </form>
          ) : (
            <button type="button" disabled={busy} onClick={() => setRemoving(true)}>
              Remove from this batch
            </button>
          )}
        </div>
      )}
    </Modal>
  );
}
