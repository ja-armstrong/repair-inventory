# RMS

The domain of a single-site device repair shop: serialized parts inventory, batch repairs of devices, purchase orders, RMA orders, and auditing. Built for a small team (≤3 users) at ~350 repairs/month.

## Language

### Repairs

**Batch**:
A group of devices repaired together; the authoritative record of parts, cost, approval, and repair status for those devices. Lifecycle: Awaiting approval → Open → Closed. Closing requires every device row to be terminal, and settles each device's still-Reserved parts by that terminal status: a Repaired device's Buybackable part goes to the Buyback pool and its other parts become Unavailable; an Unrepairable device's parts return to Available; the other terminal statuses have no parts left to settle.
_Avoid_: batch ticket, work order

**Approval**:
A manager's sign-off on a Batch's parts cost, required before repair proceeds. While the Batch is Awaiting approval, the manager decides each device individually: approved or rejected (plus an optional **Price Add Limit**, default $0 — the post-approval spend a tech may add without further approval, covering parts and consumable usage; over-limit additions are refused with the options: manager override, retriage, or Unrepairable). Approving the batch requires every device decided; rejected devices end in Denied Repair (parts returned to stock). After approval, a tech may swap same-SKU parts, add within the device's Price Add Limit, and remove any part (or consumable usage line) from any device — a removal only ever reduces cost, so it is a tech's own decision, never manager-gated and never automatic; each change amends the approval in place, and a note (optional) may record why. Any other part change is a manager in place or a retriage.

**Model**:
A device's model, drawn from a maintained list techs may extend; drives compatible part-SKU suggestions.

**Device**:
An individual item being repaired, recorded as a row on a Batch. Devices are not inventory; a different department owns them. Identified by at least one of IMEI, Asset ID, or serial number, and matched across Batches by those identifiers for repair history.
_Avoid_: phone, unit, asset

**Triage Date**:
The date a device was triaged into its Batch.

**Assigned Tech**:
The user a device is assigned to for repair.

### Parts & inventory

**SKU**:
A kind of part in the catalog, with a price. Parts are requested by SKU. A SKU may carry a **default source link** — one free-text vendor link (e.g. `source.com/part`); a convenience, never a lock: it pre-fills new Purchase Order lines' source and a Need to Order's supplier, but every line stays editable, and there is no supplier entity.
_Avoid_: part number, item type

**Serialized Part**:
A physical unit of a SKU with a system-assigned serial and a lifecycle status.
_Avoid_: part (when ambiguous), item

**Consumable**:
A part tracked for cost only: quantity used is recorded per device, but consumables are never cycle-counted or audited.

**Repair Status**:
A device's progress on its Batch row: Awaiting repair, In progress, QA, Repaired, Unrepairable, Parts needed, or Additional issues present.

**Additional issues present**:
A terminal Repair Status: the device's repair on this Batch ends, and the device is retriaged onto a new Batch (with any new parts requiring fresh approval).

**Parts needed**:
A Repair Status meaning the device is blocked awaiting a Need to Order demand to be fulfilled. Fulfilling the device's LAST open demand automatically returns it to Awaiting repair (a device pulled back to work is not rewound).

**Serial**:
The system-assigned identifier of a serialized part. Not the manufacturer's serial.
_Avoid_: OEM serial

**Available**:
In stock, usable, and unassigned; eligible to be reserved.

**Reserved**:
Committed to a Batch.

**Unavailable**:
Out of circulation: consumed in a repair, written off, or failed audit.

**RMA** (part status):
Slated for return to a vendor.

**In-Transit** (part status):
Attached to an open outbound order — RMA, buyback, or return — and physically gone with it. Only that order's scan puts a part here (from Available, RMA, or Buyback) and only its Complete settles it (to Unavailable).
_Avoid_: shipping (as a part status)

**Damaged by Tech**:
Broken by a tech; attributed to that tech for shrink reporting.

**Part Price**:
A serialized part's own price, defaulting to its SKU price until overridden (e.g. an eBay-sourced unit). The device's Parts Cost uses the price snapshotted when the part is attached. Techs may set or change it until the carrying batch is approved; afterwards only a manager, with a note.

**Denied Repair**:
A terminal Repair Status reached when a manager rejects a device at batch approval. All of the device's parts return to stock automatically.

**Buyback** (part status):
Slated for sale to a supplier's buyback program (e.g. a replaced screen worth money back).

**Buybackable**:
A SKU flag marking its parts as eligible for the buyback program. Buyback entry is never a silent default: a tech may choose the Buyback destination when removing a part, and at Batch close a Repaired device's Buybackable part goes to the Buyback pool automatically — it was the replaced part, and it is worth money back — while a non-Buybackable part has no value to recover and becomes Unavailable. On an Unrepairable device nothing was replaced, so its parts return to Available regardless of the flag.

**Buyback Order**:
A shipment of Buyback parts to a supplier — an RMA order that earns money. Lifecycle: In-Transit → Complete; the whole order settles for ONE value entered BY HAND when the supplier pays (the recovery revenue — individual parts carry no disposition or price), and every part on it leaves inventory (Unavailable). While open, its estimated value is 10% of the parts'-price sum (display only).

**Need to Order**:
A demand record for a SKU with insufficient Available stock, tied to the Batch that needs it. Carries an optional supplier link, pre-filled from the SKU's default source link when it has one. Not a physical part and not a part status. An arriving unit — a PO receipt or a salvage/migration intake — auto-reserves FIFO onto the OLDEST outstanding demand (open, on an Open batch, not already ordered on a PO), attaching onto the demanding device: the approval amends in place to the part's actual price, the Price Add Limit does not apply, and a Closed batch refuses the attachment (the part stays Available and the demand stays open for manual resolution). A demand with no device is fulfilled from stock with no attachment. Fulfilling a device's last open demand auto-returns the device from Parts needed to Awaiting repair; a device pulled back to work is not rewound.
_Avoid_: parts needed (as a part status)

**Minimum On-hand**:
A serialized SKU's declared smallest on-hand stock — the count of its Available units — the shop wants on the shelf; 0 means no minimum, and consumables never carry one. A prompt, not a state machine: while the on-hand count sits below the minimum, the PO form lists the SKU alongside the outstanding Need to Order demand with the shortfall as the suggested quantity, and the row disappears only when receiving lifts the stock back to the minimum.
_Avoid_: reorder point, par level

**Intake Source**:
How a serialized part entered inventory: purchase order, migration, or
salvage. The expense report counts purchase-order receipts; consumed
migration/salvage parts are listed separately, excluded from the total. An
intake is an intake: migration and salvage intake auto-reserve onto
outstanding Need to Order demand exactly as a PO receipt does.

**Audit**:
A count of serialized parts whose last count falls on or before the previous audit's opening. A window opens automatically on the cadence (default every 2 months, anchored on the schedule, not on the moment it actually opened) and runs until a manager closes it early or the next boundary auto-closes it — an early close leaves a quiet gap until the next scheduled open. A close is complete when nothing due is left unscanned, otherwise it is a shortfall; parts due but unscanned at close become Unavailable. The very first window is opened by a manager by hand; every later one is automatic.

**Cycle Count**:
An ad-hoc count of a SKU's parts, any user, any time. Refreshes each counted part's last-count date; the physical scan wins over the recorded status, with a required note.

### Orders

**Purchase Order (PO)**:
A request to buy parts: purpose, SKUs with quantities and prices, sources, shipping cost, and tracking. Lifecycle: Awaiting approval → In-transit → Partially received / Received; may be closed with a shortfall by note, which releases the demand records it had marked ordered back to the outstanding purchasing list (the goods never came; fulfilled records stay fulfilled). Manager approval required to leave Awaiting approval. While Awaiting approval the PO is a draft: any user may revise its lines - SKUs added or removed, quantities and unit prices adjusted - with an optional note (one `po.lines_changed` event), or delete the draft outright (a hard delete: lines, tracking, demand links, and timeline go together, and the sequential number may be reused). Approval freezes the paperwork. Shipping cost is set at creation but often known only when the package ships, so a manager may change it - with an optional note - in any status before Closed; the change lands on the timeline and rolls into the PO total. A line's source is free text, pre-filled from the SKU's default source link when it has one (the demand record's supplier is the fallback) and always editable; any stored source that parses as a web URL renders clickable on the PO page, while free text stays plain text. Received parts whose SKU has outstanding Need to Order demand are auto-reserved for the originating Batch: the attachment amends the approval in place to the part's actual price (the demand is the approval-time intent; the arrival makes it real), never counts against the device's Price Add Limit, and is refused only when the batch is Closed — the receipt still completes and the demand stays open for manual resolution.

**RMA Order**:
A shipment of RMA parts back to a vendor, carrying a per-part credit value entered BY HAND at completion — the vendor's acceptance is what sets the real value. Lifecycle: In-Transit → Complete; on Complete, all its parts become Unavailable — credited or RMA-rejected alike, distinguished by note. While open, its estimated value is 50% of the parts'-price sum (display only).

**Return Order**:
A shipment of Available parts back to a vendor. Like an RMA order but it takes in-stock parts and, unlike one, books each part's price as revenue automatically the moment the order completes — no manual value entry, because a return's credit is the known SKU price, not a negotiated receipt. Lifecycle: In-Transit → Complete; on Complete, all its parts become Unavailable. It lives under the RMA tab.

### People & records

**Tech**:
A user who repairs devices. Techs create Batches, POs, and RMA, Buyback, and Return orders, and may close Batches.

**Manager**:
A user who, beyond Tech abilities, moves Batches and POs out of Awaiting approval and manages users and roles.

**Admin**:
A user with every Manager power — today the separation is in name only, reserved for later functionality. Feature logic never branches on "admin" directly; manager-power checks go through one predicate (admin passes everywhere a manager does).

**Note**:
An immutable, chronological, user-stamped text entry on a Batch, PO, RMA order, Buyback order, or Return order. Required on creation and on any part status change. Typed notes and system-recorded events (user, timestamp, action) merge into one timeline.
_Avoid_: comment
