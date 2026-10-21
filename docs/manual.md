# RMS — user manual

This manual explains how to use the RMS app. It is written in
simple English. It is for the person at the repair counter, not for a
programmer. Every sentence says what the app really does.

## Words this manual uses

| Word | Meaning |
| --- | --- |
| **Batch** | A group of devices repaired together. The batch is the record of those repairs. |
| **Device** | One item being repaired, for example one phone. Devices are not stock. |
| **IMEI** | A 15-digit number that identifies a phone. |
| **SKU** | One kind of part in the catalog, with a name and a price. "SKU" is short for Stock Keeping Unit. |
| **Serialized Part** | One physical unit of a SKU. Each one has its own **Serial**. |
| **Serial** | The part number the app assigns, like `P00001`. It is not the maker's serial number. |
| **Note** | A short text you must write when you do something. Notes can never be edited or deleted. |
| **PO** | Purchase Order. A request to buy parts. "PO" is short for Purchase Order. |
| **RMA** | Sending a part back to the seller. "RMA" is short for Return Merchandise Authorization. |
| **Return order** | A shipment of in-stock (Available) parts back to the seller. The part's price counts as revenue the moment the order is completed - no one enters a value. |
| **Audit** | A full count of the stock, on a schedule. |
| **Cycle count** | A small count of one SKU, done any time. |

## Part statuses

Every serialized part has one status:

| Status | Meaning |
| --- | --- |
| **Available** | On the shelf. The app can give it to a device. |
| **Reserved** | Promised to one device on one batch. |
| **Unavailable** | Out of circulation. Used in a repair, written off, or failed an audit. |
| **RMA** | Waiting to go back to the seller. |
| **Damaged by Tech** | Broken by a tech. The tech's name is recorded. |
| **Buyback** | Slated for sale to a supplier's buyback program. |
| **In-Transit** | Scanned onto an open RMA, buyback, or return order - physically gone with that shipment. Completing the order makes it Unavailable. Only an order's scan puts a part here, and the order screen is the only place its status changes next. |

## 1. Logging in

The app has no passwords.

1. Open the app. You see the **Log in** page.
2. Type your email address (the shop's own domain — the allowed domains are set in the `ALLOWED_EMAIL_DOMAINS` setting).
3. Click **Send login link**.
4. The link arrives two ways. If the owner has set up email sending (Resend),
   it arrives in your email inbox. The link is also always printed in the
   server console - the window where the server program is running. Ask the
   person who runs the server if the email does not arrive.
5. Click the link. The app logs you in.

The link stops working after 15 minutes. It works one time only.

The very first user is created by the owner in the admin panel (section 13):
until the owner creates a user there, nobody can log in.

You stay logged in after that. You do not need to log in again each day. You
stop being logged in when you click **Log out**, or when a manager deactivates
your account.

## 2. The main screen

After logging in, you see a menu bar at the top. It has:

- A **search box** (it says "Search — SKU, serial, IMEI, #batch"). It reaches
  everything — results open on a results page.
- **Batches** — the repair records.
- **Inventory** — the list of part kinds (SKUs) and their stock. Each row
  shows the SKU's number (**SKU #**), name, kind, price, price state, and
  Available count; a **Search SKUs** box filters the list with the same
  fuzzy matching the pickers use.
- **Intake** — adding parts to stock without a purchase order.
- **Orders** — purchase orders.
- **RMA** — returns to sellers, and the **return orders** that ship in-stock
  parts back and book their price as revenue.
- **Buyback** — sell-backs to suppliers' buyback programs.
- **Counting** — full stock counts (audits) and small counts of one SKU
  (cycle counts) on one page.

Managers also see **Price audit**, **Reports**, and **Users**.

The admin panel is not in this menu. The owner opens it by typing `/admin`
after the app's address. Section 13 explains it.

Sometimes a colored banner appears above the menu. It shows what the counting
rhythm is doing — an open window, or a countdown to the next one. Section 9
explains it.

## 3. Making a batch and adding devices

A batch is one group of repairs. Make one batch per intake of devices.

1. Open **Batches**.
2. Write the **Opening note (required)**. Say what this batch is, for example
   "Intake from 09.24 drop-off — 30 devices".
3. Click **Create batch**. The batch gets a number, like `#29`.
4. The new batch starts in **Awaiting approval**.

The Batches list shows one row per batch: its opening note (one line; hover
to read the full text), its status (Awaiting approval, Open, or Closed), who
created it and when, and its device counts.

### Adding devices

Open the batch. There is an **Add a device** button above the device list and
another below it. Fill in the fields:

| Field | What it is for |
| --- | --- |
| **Model** | Type in the box and the model list is searched the same fuzzy way as the parts search (typo-friendly abbreviations work, for example "ip13" finds iPhone 13). Click the model, or press Enter on the highlighted one. If nothing matches, an **Add "\<name\>" as a model** row appears — click it, check the name, and click **Add model**. If a model with that name already exists (spelling aside, upper or lower case), the app tells you so and picks the existing model instead of making a second one. The list never shrinks. |
| **Capacity** | The storage size, for example 128gb. |
| **IMEI** | The phone's 15-digit number. |
| **Asset ID** | The shop's own asset number for the device. |
| **Serial number** | The maker's serial number. |
| **Loc/Bin** | Where the device sits in the shop, as one free-text label, for example Shelf 3 / Bin B. Optional. You can also set or change it any time later, right on the device's row in the batch — type in the box and click **Save**. No note is needed; the change is not written to the timeline. An empty Loc/Bin shows as —. |
| **Stated Issue** | What the customer said is wrong. This field is required. |
| **Notes** | Extra facts, for example cosmetic issues, PCL, or MDM. |
| **Repair Time (minutes)** | How long the repair took. You can fill this in later. |

You must give at least one of: IMEI, Asset ID, or Serial number. Without one of
them, the app refuses the device.

The app sets the **Triage Date** by itself. The **Assigned Tech** is you by
default. You can change it later with the **Edit** button; its **Model** field
is the same searchable box described above.

If you type an IMEI that is already in the system, the app shows a warning. It
still adds the device. The warning is there so you can check for a mistake.

**Pre-attaching parts.** In the same form you can pick the parts the device
will need (**Parts to pre-attach**): search for a SKU and click **Add picked
SKU to list**, and/or scan a serial into the serial box and click **Add
scanned serial to list**. Once a model is chosen in the form, SKUs whose
names match that model are marked **for \<model\>** and sort to the top of
the parts list — the rest of the catalog stays listed below them. Serialized
SKUs reserve their oldest Available
unit, a scanned serial reserves that exact unit, and a **consumable** SKU is
recorded as usage — set the **quantity** on its list row (a consumable has no
units; its cost is what is tracked). When you click **Add device**, the
device enters the batch with those parts and costs already on it; a
serialized SKU with no stock becomes a **Need to Order** record instead (the
device then waits in Parts needed). The whole add is one transaction: if any
part is refused — for example, a part that would push past a device's price
add limit on an approved batch — the device is not created at all, and the
error says why.

### Repair statuses

Each device has a **Repair Status**. You change it in the device's row: pick
the next status from the dropdown and click **Set**. The dropdown only shows
the moves the app allows.

The statuses are:

- **Awaiting repair** — the start.
- **In progress** — someone is working on it.
- **Parts needed** — the device is waiting for a part.
- **QA** — quality assurance: someone is checking the repair.
- **Repaired** — done. This status is final.
- **Unrepairable** — it cannot be fixed. This status is final.
- **Additional issues present** — more problems showed up. This status is
  final for this batch. See "Retriage" in section 6.
- **Denied Repair** — a manager rejected this device when approving the batch.
  The repair never starts; the device's parts went back to stock. No one can
  pick this status from the dropdown — only a rejection sets it. This status
  is final.

When you set a final status (Repaired, Unrepairable, Additional issues
present, or Denied Repair), you can write **Resolution notes** saying how the
repair ended. The status change itself is recorded on the timeline either way.

**Fixing a mistake.** Final statuses are not traps: if a device was set to a
final status by accident, the dropdown also offers the way back — Repaired,
Unrepairable, and Additional issues present can go back to **In progress** or
**QA**; Repaired can also go straight back to **Awaiting repair**; Denied
Repair can go back to **Awaiting repair**. The change is recorded on the
timeline like any other. Two things the way-back move does
NOT undo: leaving Additional issues present does not undo the retriage — the
device it created on the new batch (with the moved parts) must be removed
separately, through that device's **Remove** button; leaving Denied Repair
does not put the returned parts back on the device — add them again through
the parts panel.

**Putting a phone down.** A tech who picks a device up (**In progress**) and
puts it back on the shelf can set it back to **Awaiting repair** — so can
Repaired, when the repair was recorded in error. The device's parts stay
attached and reserved; only the status rewinds.

## 4. Adding parts to a device

1. Open the batch.
2. Click **Parts** in the device's row.
3. Under **Add a part by SKU**, pick the SKU in the **SKU search box**: type
   part of the SKU's name, and a list of the closest matches opens. You can
   also move with the arrow keys and press Enter, or just click a row. Each
   row shows the SKU's full name (it wraps; nothing is cut off), its price,
   and how many units are Available. Rows with **Available: 0** are dimmed
   but still clickable — picking one is how a **Need to Order** starts. A
   row marked **consumable** is a consumable SKU; consumables have no stock
   count. A **price stale** marker means the SKU's price is past its expiry
   date. The SKU you picked stays shown in full under the search box. The box
   always offers **Add "…" as a SKU** at the bottom of the list — even when
   SKUs match — so a new part can be added from any search: the typed text
   becomes the new SKU's name (you can edit it), pick the kind and a price,
   and the new SKU is selected as if you had picked it from the list.

   The box lists every kind, and the form adapts to what you picked: pick a
   **serialized** SKU and the form reserves a unit (oldest Available, or the
   exact unit you scan); pick a **consumable** SKU and the form asks for a
   **Quantity** instead — clicking **Record usage** adds quantity × the SKU's
   price to the device's Parts Cost. A consumable has no units and no stock
   count, so nothing is reserved — but its cost is tracked on the device
   exactly like a reserved part, price add limit included.
4. You may write a **Supplier link**. If the shop runs out, this name is copied
   onto the purchase order later.
5. You may write a **Price**. This is the part's own price (section 10 explains
   where a part's price comes from). Leave it empty and the part keeps whatever
   price it already has. If you type one, the reserved unit is marked **price
   overridden** and the device's Parts Cost uses your price. If no stock is
   Available, an add with a price is refused — a price needs a unit to sit on;
   add the part again without a price to start the Need to Order.
6. Or **scan a serial** instead of picking a SKU. In the **Serial scan** box,
   scan or type the unit's serial and click **Add part** — that exact unit is
   added (and its SKU is known from the unit, so no SKU pick is needed). Give
   a SKU or a serial, not both. A serial that does not exist is refused; a
   unit that is not Available is refused with its current status — the app
   never guesses and never starts a Need to Order from a scan.
7. The note is optional — write one when the addition needs words.
8. Click **Add part**.

On an approved batch, the parts panel shows the device's **Price Add Limit**
and how much of it is left. A tech may add up to that limit; an addition that
would push the device past it is refused with the price, the spend so far, and
the options (a manager can add it in place, the device can be retriaged onto a
new batch, or it can be marked Unrepairable). Additions made before the
approval never count against the limit — the approved cost already covers
them.

Two things can happen:

- **Stock exists.** The app takes the oldest Available unit of that SKU. The
  part becomes **Reserved** for this device. Its price at this moment is
  recorded — the part's own price if it has one, otherwise the SKU's catalog
  price. Later catalog price changes do not change this recorded price.
- **Stock is empty.** The app creates a **Need to Order** record for the SKU.
  The record is tied to this batch and device. The device then moves to
  **Parts needed** by itself. You do nothing. When the part arrives later, the
  app fills the record and gives the part to this device (section 7) — and if
  that was the last record the device was waiting on, the device moves back to
  **Awaiting repair** by itself.
  Once a purchase order carries the record, the device's parts panel stops
  saying "Need to Order" and says **"in transit on PO #N"** instead — the
  record is not needed any more, it is on its way (ticket 29).

The device's **Parts Cost** is computed by the app. It is the sum of the
reserved parts' recorded prices plus consumable use. Nobody types it by hand.
A part the shop does not own yet — an open **Need to Order** record — adds
nothing to this sum: there is no part to price. Instead the app shows its
estimate NEXT TO the cost as **"NTO — est. $<SKU price>"** (on the device's
Parts Cost, in the approval view, and on the batch's status line). The
estimate is the SKU's current catalog price, labeled as estimated rather than
signed off; when the part arrives, the app replaces it with the part's real
price.

### Consumables

A **Consumable** is a part you use up, for example adhesive. Consumables have a
price but no serials. They are never counted and never audited.

You record consumable use in the same **Add a part** form: pick the consumable
SKU (its row is marked **consumable**), type the **Quantity**, and click
**Record usage**. The quantity times the price is added to the Parts Cost, and
every recorded use is listed under **Consumable usage** on the same panel.

**Removing a recorded use.** If a use was recorded by mistake, click
**Remove** on its row and write the note (required) saying why. The cost comes
off the device right away, the record stays on the timeline (what was
removed, by whom, and why), and — on an approved batch — the same rules as
removing a part apply: any tech can remove from any device (the batch must
not be closed), and the approved cost is corrected with the note.

## 5. Swapping and removing parts

In the parts panel, each attached part has **Swap** and **Remove** buttons.

**Remove** takes the part off the device. The app asks two things:

- A **destination** for the part. You always pick it yourself — the app never
  chooses for you, and the form will not submit until you have. The choices
  are:
  - **Available (return to stock)** — the part is fine. It goes back on the
    shelf. It becomes Available again.
  - **Buyback (slate for supplier sale)** — the part has resale value. It
    becomes Buyback and joins the buyback pool.
  - **RMA (slate for vendor return)** — the part is bad. It will go back to
    the seller. It becomes RMA.
  - **Damaged by Tech (attributed to you)** — you broke it. It becomes
    Damaged by Tech, with your name on it.
- A **note (required)**. Say why the part is leaving the device.

A part never silently returns to stock. It always goes to the destination you
chose, with your note on the record.

**Swap** replaces the part with another unit of the same SKU. The app does two
things at once: it reserves a fresh unit of the same SKU for the device, and it
sends the old part to the destination you chose. You can swap at any time,
even after approval. By default the fresh unit is the oldest Available one of
the SKU; you may instead **scan a replacement serial** in the swap form — the
swap then reserves that exact unit (it must be the same SKU and Available, and
the app says so clearly when it is not).

## 6. Approval and closing

### Approval

Only a manager can approve. On a batch in **Awaiting approval**, the manager
first decides **each device** on the batch — **Approve** or **Reject** (the
per-device **Approval** column). A rejection may carry a note saying why;
when it does, that note becomes the device's resolution notes when the batch
opens. Decisions can
be changed until the batch is approved — the latest decision counts. The
**Approve batch** button stays disabled while any device is undecided, and the
server refuses an approval that leaves one out, naming the devices. To decide
them all at once, the manager can use **Approve all devices** — it approves
every device that has no decision yet; devices rejected earlier keep their
rejection.

Approval means this:

- Every device must have a decision. Rejected devices end in the final status
  **Denied Repair**: their repair on this batch is over, their installed parts
  go back to stock (Available, with a note naming the denial), and the device
  keeps the rejection note as its resolution notes.
- Each device can also get a **Price Add Limit** (typed in the Approval
  column, in dollars; blank keeps what the device already has). This is the
  most the shop may add to that device's cost after approval without a
  manager — parts and consumable usage both count. The default is $0, which
  means no post-approval additions at all. A manager can change the limit
  later on the device's row.
- The manager agrees to the Parts Cost of the APPROVED devices. The app records
  that cost; denied devices contribute nothing to it. A part still on an open
  **Need to Order** record is NOT in the recorded cost — there is no part to
  pay for yet — so the approval screen shows its estimate next to the total,
  labeled **"NTO — est. $..."**; the estimate is never recorded as cost. When
  the part arrives, the app updates the recorded approved cost to the part's
  real price.
- The batch becomes **Open**. Repair can proceed on the approved devices.
- After approval, a tech can **Swap** same-SKU parts, add parts or record
  consumable usage up to the device's Price Add Limit, and **remove** any
  part (or consumable usage) from any device — removals only ever reduce the
  cost, so any tech makes that call. Adding past the limit needs a manager.
- A manager can still add or remove parts after approval. The app updates the
  recorded approved cost with each change; a note (optional) can record why.
- Before approval, part lists can be edited freely by anyone.

### Retriage

Sometimes more problems show up after approval. Set the device to
**Additional issues present** (resolution notes are optional). The app then does
this by itself:

1. It ends the device's run on this batch.
2. It creates a **new batch**. The new batch starts in Awaiting approval.
3. It creates a new device row on that batch, linked to the old row.
4. It moves the device's Reserved parts and open Need to Order records onto the
   new device.

The parts on the new batch now need fresh approval. The app shows a link to
the new batch.

### Closing

Any user can close a batch. Click **Close batch**. The app only allows this
when every device is in a final status: Repaired, Unrepairable, Additional
issues present, or Denied Repair. If one device is not final, the app refuses
and names it.

When you close the batch, each part still attached to a device goes where its
device's final status sends it:

- **Repaired** device: a part of a **Buybackable** SKU goes to the **Buyback**
  pool — it was the replaced part, and it is worth money back. Any other part
  becomes **Unavailable** (the repair used it up).
- **Unrepairable** device: every part goes back to **Available** — the repair
  is reversed, nothing was replaced, and the applied part is good stock.
- **Additional issues present** and **Denied Repair** devices have no parts
  left to settle: a retriage already moved the first device's parts to the
  continuation batch, and a denial already returned the second device's parts
  to stock at approval.

Parts removed earlier already went to the destination chosen at removal time.

A closed batch accepts nothing new: no devices, no status changes, no parts.

## 7. Ordering parts (purchase orders)

### Creating a PO

1. Open **Orders**. Click **New purchase order**.
2. The top of the form lists the outstanding **Need to Order** records. Each
   row shows the SKU, the supplier link, and the batch that needs it. The
   supplier link was pre-filled from the SKU's **default source link** when
   the Need to Order was filed (a link saved on the SKU in
   **Inventory**). Tick a row and the app creates a filled-in line for you.
3. Below the Need to Order records, the form lists every serialized SKU whose
   available stock has fallen below its **minimum on-hand quantity** (a
   number saved on the SKU in **Inventory**; 0 means no minimum). Each row
   shows the stock on hand, the minimum, and the shortfall. Tick a row and
   the app creates a line whose quantity is the shortfall — ordering it
   lifts the stock back up to the minimum. The row stays listed until the
   stock is actually received; putting it on a PO does not clear it.
4. Fill in **Purpose** (why you are ordering) and **Sources** (where you buy).
   Both are free text. The app suggests words you used before.
5. Fill in **Shipping cost** if you know it.
6. Write the **Opening note (required)**.
7. Check the **Lines**. Each line has a SKU, a Quantity, a Unit price, and an
   optional Source. Pick the line's SKU in the same **SKU search box** used
   elsewhere (type part of the name, click the match). The unit price you type
   here is the price you agreed with the seller. It does not have to match the
   catalog price; picking a SKU pre-fills the box with the SKU's catalog price.
   Picking a SKU also pre-fills the **Source** with the SKU's default source
   link, when it has one — both boxes stay editable, and the default is only
   a convenience. A supplier link that reads as a web address (the SKU's
   default, or the Need to Order's own) shows as a clickable link.
   If the search finds nothing, the box offers to create the SKU on the spot:
   click **Add "…" as a SKU**, check the name, pick the kind and a price, and
   the new SKU is selected for the line.
8. You may add **Tracking** entries (carrier and tracking number) now or later.
9. Click **Create purchase order**.

A new PO starts in **Awaiting approval**.

### Changing or deleting a draft PO

While the PO is **Awaiting approval**, the order has not been placed yet, so
it can still be changed:

- Click **Edit lines**. The current lines appear as editable rows. You can
  change a row's SKU, quantity, unit price, and source, remove a row, or add
  a new row. Saving replaces all lines with the rows you see; the change
  (and the note, if you wrote one) lands on the timeline. If you remove the only
  line for a SKU whose Need to Order records this PO had marked ordered,
  those records become outstanding again (they show up on the new-PO form's
  demand list). Keeping a line for the same SKU keeps the records marked
  ordered.
- Click **Delete draft PO** to remove the whole draft: its lines, tracking,
  history, and any "marked ordered" links are deleted. Need to Order records
  it covered become outstanding again. A deleted draft leaves no record
  behind, and the next PO can reuse its number.

Once the PO is approved, none of this is possible: the lines and the order
itself are frozen, and only the shipping cost can still change.

### Reading the PO page

While the PO is **Awaiting approval**, the order has not been placed yet. The
Lines table shows a single **Quantity** column (how many you plan to order),
and the page shows no "Marked ordered" or "Shortfall" counts anywhere.

From approval onward (In-transit, Partially received, Received, Closed), the
Lines table shows **Ordered**, **Received**, and **Shortfall** columns, and
the top of the page shows how many Need to Order records the PO marked
ordered and how many units are still short.

The **Fulfills demand** column shows which Need to Order record the line
covers: **Batch #N — <device identifier>** when the demand names a device
(the device's Asset ID, else its IMEI, else its serial number), **Batch #N**
when the demand is for the batch only, and **—** when the line covers no
demand. Hovering the cell shows the demand record's id.

A line's **Source** that reads as a web address (http(s) links, or
scheme-less ones shaped like `source.com/part`) shows as a clickable link
that opens in a new tab; anything else — a vendor name, a note, a number —
stays plain text. The same rule applies to the supplier link on the Need to
Order rows of the new-PO form.

### Approval

Only a manager can approve. On the PO page of an order **Awaiting approval**,
the **Approve this purchase order** panel sits at the very top of the page —
a large bordered box above the lines, tracking, and timeline. The approval
note is optional: write one when the sign-off needs words, or leave it blank
and click **Approve**. The app moves the PO to In-transit and assigns a serial
number to every expected part. Now labels can be printed.

### Printing labels

Labels print two ways, and the label page shows both buttons.

**Print with DYMO (all)** — the primary way. This sends every label straight
to the DYMO LabelWriter: no print dialog, no page-range picking, one physical
label per serial. Requirements:

- DYMO Connect must be installed and running on the computer you print from.
  Its web service listens at https://localhost:41951.
- The first time (and after clearing the certificate), the browser must trust
  the DYMO web service's self-signed certificate. Open
  https://localhost:41951/DYMO/DLS/Printing/StatusConnected in the browser
  once, accept the certificate warning, and go back to the label page.
- A printer must be selected in the **DYMO printer** picker on the label page.
  The chosen printer is saved as the shop's default (a manager can save it; a
  tech's pick applies to that session only).

The status line under the buttons reports progress and, if a label fails, the
exact serial that failed and why. Nothing prints silently and nothing is
skipped silently.

**Print via browser** — the fallback. The browser print dialog opens, and the
printout contains exactly the labels, one per page on the label stock size —
no app header, no toolbar, no blank pages.

On the PO page, click **Print labels** to open the label sheet. You get one
barcode label per expected part. Put a label on the right part when the box
arrives.

### Receiving

When the box arrives:

1. Open the PO. Click **Receive**.
2. Scan each label, or type the serial, and press Enter. The input stays
   focused, so you can scan the whole box without touching the mouse.
3. When you scan a label, the app does all of this at once:
   - It creates the part as **Available** in stock, with the part's own price
     set to that line's unit cost (see section 10 for what a part's own price
     means).
   - It adds 1 to the line's **Received** count.
   - It sets the SKU's catalog price to that line's unit cost. This refreshes
     the price, so the price-audit clock starts over.
   - If the SKU has an open Need to Order record, the app marks the record
     **fulfilled** and reserves the part onto the device that was waiting.
     The part's cost is added to the batch's approved cost right away — the
     approval is corrected in place, and the timeline records that the
     purchase order receipt caused the change. This never counts against
     the device's Price Add Limit: the need was already approved, the
     arrival just fills it.
   - If the batch has already been **Closed**, the app refuses to attach
     the part. The receipt still goes through: the part stays in stock as
     **Available** and the Need to Order record stays open for a person to
     resolve by hand.
   - The device itself moves back to **Awaiting repair** by itself when the
     record it was waiting on is filled — as long as it was in **Parts
     needed** and no other Need to Order record of its is still open. From
     there, a person moves it to **In progress** when work starts. A device
     that someone already pulled back to work is left alone.
4. The PO's status changes by itself: **Partially received** when some units
   have arrived, **Received** when every line is full.

Consumable lines have no labels. On the Receive page, type a **Quantity** for
the line and click **Receive quantity**.

### Closing with a shortfall

If some units will never arrive, any user can end the PO. On the PO page,
write the **Close note** and click **Close with shortfall**. This only works
when at least one unit is missing. The missing count stays visible on the
lines.

Closing also releases the PO's **Need to Order** records: any the order had
marked as ordered go back onto the purchasing list, because the parts never
came. Records the order actually fulfilled stay fulfilled.

### Changing the shipping cost

The shipping cost you typed at creation is often not the number the carrier
actually charged. On the PO page, a manager sees a **Shipping cost** form:
type the new amount (a **Note** saying why is optional), then click
**Set shipping cost**. The PO total updates and the timeline records the old
amount and the new amount, with the note when you wrote one.

This works in every status except **Closed** — a closed PO is the final
record of what was spent, so its shipping cost can no longer change. The
expense report counts PO shipping from the same stored number, so an edit
shows up there too.

## 8. Sending parts back (RMA orders) and selling parts back (buybacks)

### RMA orders

An RMA order is one shipment of parts back to a seller.

Parts become **RMA** when you remove them from a device with the RMA
destination, or when you set that status on the part's own page.

1. Open **RMA**. The page lists every RMA part and shows which order it is on,
   and below it the **Return orders** section (see "Return orders" below).
2. Write the **Opening note (required)** and click **Create RMA order**. The
   order starts **In-Transit**. No approval is needed.
3. On the order's page, scan the serials of the parts you are sending. Only
   RMA parts join an order, and a part can be on only one open order at a
   time. A scanned part becomes **In-Transit** — it reads as physically gone
   with the shipment everywhere in the app, and it cannot be reserved or
   edited until the order completes.
4. When the seller answers, fill in **Complete this order** at the bottom:
   - For every part, choose a **Disposition**:
     - **Credited** — the seller paid you back. Type the **Credit (USD)** value.
     - **RMA-rejected** — the seller refused the part. No credit value.
   - Write a **note (required)** for every part.
   - Write the **Completion note (required)** at the bottom.
5. Click **Complete order**.

When you complete the order, every part on it becomes **Unavailable** — the
credited parts and the rejected parts alike. The notes keep the difference
visible. A completed order never takes more parts.

You do not know what the seller will pay until they answer, so the order
list and the order page show an **estimated recovery while the order is
In-Transit: 50% of the value of the parts on it** (each part counts at its
own price if it has one, otherwise the SKU price). The estimate is for
looking at only; the RMA-recovery report counts only the credit values you
entered at completion.

### Return orders

A **return order** is a shipment of parts you still have **Available** back
to the seller, where the value is not a negotiation: the part's price is
your revenue. Unlike an RMA order, **no one enters a value** — completing
the order books each part's price itself.

1. On the **RMA** page, in the **Return orders** section, write the
   **Opening note (required)** and click **Create return order**. The order
   starts **In-Transit**.
2. On the order's page, scan the serials of the Available parts you are
   sending. Only Available parts join a return order — the scan moves them
   to **In-Transit**, so a part already on an RMA, buyback, or return order
   refuses, and a part on a shipment can never be reserved onto a batch.
3. The order page shows the running **revenue** (the parts' prices summed —
   this is what completion will book).
4. Write the **Completion note (required)** and click **Complete order**.

When you complete the order, every part becomes **Unavailable**, and each
part's current price is snapshotted onto the order as **booked revenue** —
a later price change cannot rewrite a completed order. The returns-revenue
report (section 12) lists it. Return orders have their own number line:
return #4 is not RMA #4.

### Buyback orders

A **buyback order** is a shipment of parts to a supplier's buyback program —
an RMA order that earns money.

A SKU can be marked **Buybackable** on its page (serialized SKUs only;
changing it needs a note). A part of a buybackable SKU can enter the **Buyback**
pool two ways, both deliberate: you pick **Buyback** as the destination when
removing it from a device (the note you write is the record of that choice —
nothing is pre-selected for you), or the batch close does it for a **Repaired**
device, because the part was the replaced one and is worth money back. A part
in the pool can also be moved out on the part's page, with a note, before it
ships.

1. Open **Buyback**. The page lists every Buyback part (the pool) and shows
   which order it is on.
2. Write the **Opening note (required)** and click **Create buyback order**.
   The order starts **In-Transit**.
3. Scan the serials of the parts you are selling. Only Buyback parts join an
   order, and a part can be on only one open order at a time. A scanned part
   becomes **In-Transit**, exactly like an RMA order.
4. When the supplier pays, fill in **Complete this order**:
   - Type the **Order value (USD)** — the full amount the supplier paid for
     the shipment. That one number is the recorded recovery revenue;
     individual parts are not accepted or rejected one by one.
   - Write the **Completion note (required)**.
5. Click **Complete order**.

When you complete the order, every part on it becomes **Unavailable**. The
buyback-recovery report (section 12) lists each completed order with the
value you entered and the total revenue. While the order is
In-Transit the order list shows an **estimated recovery: 10% of the value of
the parts on it** — the real number is the value you enter when the supplier
pays. While an order is In-Transit, its parts' statuses cannot be
changed on their own pages — the shipment owns them until it completes.
Buyback parts are exempt from the audit's due list, like RMA parts.

## 9. Counting (audits and cycle counts)

### The banner

The app counts stock on a schedule. The default is every 2 months. The banner
above the menu shows one of two things, whichever is true:

- While a window is open: "Audit #N is open — the window for the <date>
  boundary. Parts are being counted." The open window is its own reminder;
  there is no countdown on top of it. (The very first window has no scheduled
  date — it was opened by hand — so its banner says so.)
- While no window is open: "No audit window is open — the next one opens on
  <date>, in <N> days." After a manager closes a window early, the app stays
  quiet until the next scheduled date; the banner counts down to it.

When the app has never run an audit, the banner shows nothing. The Counting
page is where a manager opens that first window.

Click **Go to counting** in the banner.

### Opening the window

The window opens by itself. When the scheduled date arrives, the app opens
the next counting window automatically — the first person to use any
counting page after that date triggers it, and the window is recorded as
opening on the scheduled date. You never need to open an audit window by
hand, with one exception: the very first window ever is opened by a manager,
by hand, once. That Open control appears only on a system with no audits at
all, and only a manager (or an admin) can use it; after the first audit
exists it is gone for everyone.

Only one window can be open at a time.

At the moment the window opens, the app fixes the **due list**: every part in
circulation whose last count is too old. Parts added to stock after this
moment are not demanded by this audit.

The page shows which parts are exempt and why: RMA parts (waiting), In-Transit parts (gone on an open order), Unavailable parts, Damaged by Tech parts, parts counted since the
last audit, and parts added after the window opened.

### Scanning

Scan or type each due part's serial and click **Count**. Each scan refreshes
that part's last-count date.

Sometimes the shelf disagrees with the record. If a part is recorded as
**Unavailable**, **RMA**, **Buyback**, or **In-Transit** but it is physically in your hand, the scan wins:
the app makes the part **Available** again. You must write a note in that
case.

### Closing

The window closes in one of two ways:

- A manager closes it early, before the next scheduled date. Closing by hand
  is a manager's decision — a tech can scan and watch the window, but only a
  manager (or an admin) can close it. The schedule does not move: the next
  window still opens on its scheduled date, so an early close leaves a quiet
  gap.
- The next scheduled date arrives. Then the window closes by itself, at the
  first use of any counting page after that date. This closing is recorded
  as done by the system, not by a person.

Closing settles with no grace:

- Parts you scanned in the window are **counted**.
- Due parts you did not scan become **Unavailable**. The app treats them as
  lost. A Reserved part that fails is also taken off its device.
- Parts that left circulation during the window are **accounted for**.

The app records how the closing went, by itself: if every due part was
counted or accounted for, the audit is recorded as **complete**; if any due
part was left unscanned, it is recorded as a **shortfall**. Nobody chooses
this label — the counted parts decide it. No note is required to close. The
counting page still asks you to confirm when unscanned parts remain; be sure
before you close. A closed audit never opens again.

If the app could not run for a long time and several scheduled dates passed,
the app does not invent the missed windows: the open window is closed once,
and the new window is recorded as opening on the latest missed date. The
timeline shows the gap. A closed audit never opens again.

### Cycle counts

Between audits, you can count any SKU at any time. On the **Counting** page
(below the audit window), pick the SKU in the SKU search box (type part of its
name, click the match), and scan serials. Each scan refreshes the part's
last-count date.

A part cycle-counted since the last audit is exempt from the next audit's due
list. The same scan-wins rule applies: a scan of a part recorded as Unavailable,
RMA, Buyback, or In-Transit makes it Available again, and a note is required. Scanning a
part recorded as Damaged by Tech only refreshes its count date; it stays
Damaged by Tech.

## 10. Adding parts without an order

Parts can enter stock three ways: a purchase order (section 7), migration, or
salvage. The last two live on the **Intake** page. The app records on every
part how it arrived. The expense report counts the parts a purchase order
actually delivered.

Every part has a **price of its own**. When a part is added without a price of
its own, its price is the SKU's catalog price, and it follows the catalog when
that changes. When a price of its own is set — on the Intake page, or later on
the part's page — the part keeps that price even if the catalog changes. A part
with a price of its own is marked **price overridden**, and the part's page
shows the SKU price next to it. A device's Parts Cost always uses the price
recorded when the part was attached.

A serialized SKU can carry a **minimum on-hand quantity** — set on the SKU's
page in **Inventory** (whole number, 0 or more; 0 means no minimum, and
consumables never have one). It is the smallest number of **Available** units
the shop wants on the shelf. When the stock drops below it, the **New purchase
order** form lists the SKU with the shortfall (section 7). Changing the number
needs no note; the change is recorded on the SKU's timeline.

### Where an added part can go

If the SKU has an outstanding **Need to Order** record, the app does not
leave the new part on the shelf. The **oldest** Need to Order record wins
first: the app reserves the part onto the device that was waiting, marks
that record **fulfilled**, and adds the part's price to the batch's approved
cost right away — the approval is corrected in place, and the timeline
records that the intake caused the change. This never counts against the
device's Price Add Limit: the need was already approved, the arrival just
fills it. When several Need to Order records are waiting, the first one
created gets the first part, the second one the next part, and so on — one
part per record. The Intake page shows where each part went ("Reserved to
Batch #N — device …"). A Need to Order record with no device is filled from
stock: the record is fulfilled and the part stays **Available**. If the
batch has already been **Closed**, the app refuses to attach the part — the
part stays **Available** and the record stays open for a person to resolve
by hand. With no open Need to Order record, the part simply lands
**Available**. When the filled record was the device's last open one and the
device was waiting in **Parts needed**, the device moves back to
**Awaiting repair** by itself; a person moves it to **In progress** when work
starts again.

### Changing a part's price

Open the part's page (from the inventory list, a batch's parts list, or a
search) and use the **Price** form: type the price and a note (required). The
change is recorded on the part's timeline with the old and the new price.
The part's page shows its SKU at the top — the name (a link to the SKU's
page), the **SKU #** number, and the SKU's price.

Rules:

- While the part is on the shelf, or attached to a batch that is still
  **Awaiting approval**, anyone can set or change the price.
- Once the carrying batch is **approved (Open)**, only a manager can change the
  price, the note is required, and the change amends the approval — the
  approved Parts Cost moves to the new price.
- A part on a **Closed** batch can no longer be re-priced: the closed batch's
  recorded cost is final.

### Migration

Migration is bulk stock that already sits on your shelves. It is put into the
system at the start.

1. On **Intake**, set **Flow** to "Migration — bulk shelf stock".
2. Pick the SKU in the SKU search box (type part of its name, click the match).
   If nothing matches, the box offers to create the SKU on the spot (**Add "…"
   as a SKU** — name editable, kind, price) and selects it.
3. Type the **Quantity** (1 to 200).
4. Decide about **Physically counted now**:
   - Checked (the default): you really touched and counted these parts today.
     The app records today's count for each part. The next audit will not
     demand them.
   - Unchecked: the parts were not counted. The first audit will demand them.
5. Optionally type a **Price** — the parts' own price, when it differs from the
   SKU's catalog price. Leave it empty and they follow the SKU price.
6. A note is optional. Click **Add parts**.

### Salvage

Salvage is one part that came from somewhere other than a purchase.

1. Set **Flow** to "Salvage — one part with provenance".
2. Pick the SKU in the SKU search box (type part of its name, click the match).
   If nothing matches, the box offers to create the SKU on the spot and
   selects it.
3. Write the **provenance note (required)**: what the part came off, and why
   it exists.
4. Optionally type a **Price** — this part's own price.
5. Click **Add salvaged part**.

### Labels

New intake parts get serials from the app, but they have no labels yet. After
adding, click **Print labels for these parts** and print the sheet — with
**Print with DYMO (all)** straight to the LabelWriter, or with **Print via
browser** as the fallback (see "Printing labels" above). Scan the parts only
after their labels are on them.

## 11. Searching

Use the search box at the top of every page. Type and press Enter.

What you can type, and what you will find:

| You type | You find |
| --- | --- |
| Part of a SKU name | SKUs with that text in the name. Capital letters do not matter. |
| A part serial, exactly (`P00001`) | The app jumps straight to that part's page. |
| A device's IMEI, Asset ID, or serial number, exactly | The device's rows on every batch it appeared on. |
| Part of a device's Loc/Bin label, for example `bin b` | The device(s) sitting there. Capital letters do not matter, and part of the label is enough. |
| A batch, PO, RMA, buyback, or return number (`#29` or `29`) | That batch, PO, or RMA/buyback/return order. |

The results page groups the hits: SKUs, Parts, Devices, Batches, Purchase
orders, RMA orders, Buyback orders, Return orders. You can also filter by user
with the **by user** dropdown.

## 12. Reports

Reports are manager-only. Open **Reports**. Every report covers a date range:
pick **From** and **To**. Both days count. Click **Download CSV**. A CSV is a
spreadsheet file that Excel can open.

| Report | What it counts |
| --- | --- |
| **Total expenses** | What the purchase orders actually delivered — each received part and consumable quantity at its ordered unit cost — plus PO shipping cost. Migration or salvage parts were never bought; if one is consumed in a repair it is listed separately, not in the total. |
| **RMA recovery** | Parts on completed RMA orders: the credits you received, and the rejected parts at zero. |
| **Buyback recovery** | Each completed buyback order with the one value you entered when the supplier paid (the recovery revenue), and the total. |
| **Returns revenue** | Parts on completed return orders: each part's price as booked revenue (no manual value), and the total. |
| **Batches completed** | Batches closed in the range, with device counts by final status (including Denied). |
| **Shrink** | Damaged by Tech parts and audit-failed parts, each priced at its SKU price. Shrink means stock that is lost or damaged. |
| **Per-tech stats** | For each tech: repairs completed, average repair time, and damage attributed to them. |

## 13. The admin panel

The admin panel is for the owner only. It is not in the menu. Type `/admin`
after the app's address, for example `http://localhost/admin`. It asks for
the **Admin key**. This key is set in a file on the server, not in the app. If
the key is not set, the whole panel is switched off.

The panel has these sections. Be careful: several of them are dangerous.

- **Settings** — changes the shop-wide numbers: the audit interval, the price
  expiry, and the label size. It also sets the default DYMO printer for label
  printing. Every change is recorded.
- **Users & roles** — the owner's list of every user: create users (with
  their role: tech, manager, or admin), change a user's role, deactivate or
  reactivate an account, and send a login link. This is how the very first
  user comes to exist — the app has no automatic first account — and how
  everyone gets back in after the database is cleared. A user's login link
  is also shown on the page, so you can hand it to them when email is not
  set up.
- **Backup** — click **Download backup**. The app saves a full copy of the
  database into `data/backups/` and downloads it. It is safe to do this while
  the shop is working. Copy the backups folder to another place (a USB stick,
  a network share) regularly. These files are your only recovery.
- **Danger zone**:
  - **Clear the database** — this deletes everything: all batches, parts,
    orders, audits, and users. The app makes a backup first, and it demands you
    type `ERASE ALL DATA` to confirm. After clearing, everyone is logged out
    and the user list is empty — create your users again in **Users & roles**
    and send each one their login link.
  - **Restore from backup** — uploads a `.sqlite` backup file. The app checks
    the file first. If it is valid, the app backs up the current database and
    stages the file. The swap happens when the server is restarted next. Work
    saved between the upload and the restart is thrown away — restart right
    away.
- **SQL console** — lets the owner look directly at the data. Read-only by
  default. Writing needs a typed confirmation, and every write is backed up
  first.
- **Environment** — shows and changes the server's settings file (.env)
  without opening the server. Secret values (the Resend key, the admin key)
  are shown only partially, like `(set ····abcd)`. If you leave a secret box
  empty and press Save, nothing changes.
  **Nothing you save here works immediately.** It works only after the server
  is restarted. The page shows which values are waiting for a restart.
- **Restart button** — on the Environment page. You must type `RESTART` to
  confirm. The server stops and starts again. This works when the server runs
  with `npm run dev`, because that program starts the server again by itself.
  In production (`npm start`) the button is refused, unless the owner has set
  `ALLOW_RESTART=true` in .env to say "yes, a supervisor program will start
  the server again". Warning: a restart ends every admin session — you must
  type the admin key again. The normal app users stay logged in, because
  their sessions are kept in the database.
- **API console** — lets the owner send real API requests (GET, POST, PATCH,
  PUT, DELETE) to this same server from the panel. Every request runs as the
  first active manager or admin, through the app's normal checks — nothing is
  bypassed.
  Only this app's own addresses (/api/... and /health) are allowed. The
  answer is shown exactly as the server sent it, including errors.
- **System info** — row counts, applied migrations, uptime, and the database
  file's path and size.

## 14. The sandbox — a practice copy

The app runs a second copy of itself at the address `/sandbox`, on the same
server and the same port as the main app. Example: if the main app is at
`http://localhost`, the sandbox is at `http://localhost/sandbox`.

The sandbox has its own database, a separate file (`data/sandbox.sqlite`).
Nothing done in the sandbox changes the shop's data. Every sandbox page shows
a red SANDBOX banner, and the browser tab is called RMS (SANDBOX).

### Logging into the sandbox

The sandbox uses the same login flow as the main app (section 1), and its
email works the same way too: if the owner has set up email sending (Resend),
the trainee gets the link in their inbox; if not, the link is printed only in
the server console. Every sandbox link's address contains `/sandbox`.

The sandbox starts empty — it has no users. The owner creates trainee users:

1. Open the sandbox's admin panel: type `/sandbox/admin` after the app's
   address. It asks for the same Admin key as the main panel (section 13).
2. Use **Users & roles** to create the trainee's user and mint a login link.
   It reaches the trainee the same way a main-app link does (email if Resend
   is set up, otherwise printed in the server console — give it to the
   trainee).
3. The trainee opens the link and is logged in to the sandbox.

### Practicing in the sandbox

A trainee uses the sandbox exactly like the main app: make a batch (section
3), add devices and parts (sections 3 and 4), approve and close (section 6),
receive a purchase order (section 7). The rules are the real rules: the app
checks every trainee action exactly as it checks the same action in the main
app.

### Resetting the sandbox

Training leaves data behind. The owner erases it by resetting the sandbox
from a backup. Resetting is done by hand only — nothing resets by itself.

1. Make sure a backup file exists. Backup files live in the `data/backups/`
   folder on the server. If there is none, open the main admin panel
   (section 13) and click **Backup** first. Older sandbox backups (their file
   names start with `sandbox-`) can be used too.
2. Open the sandbox admin panel's **Reset** page.
3. Pick a file from the list (newest first) or upload a `.sqlite` file. The
   app checks the file first. A bad file is refused, and the sandbox keeps
   running with its current data.
4. When the file passes, the app first saves a backup of the sandbox's
   current data (the page shows its file name — that backup is how you undo
   the reset). Then the chosen file is staged.
5. The swap happens when the server is restarted next. Restart the server.
   The sandbox then serves the data from the chosen file.

After a reset, everyone using the sandbox is logged out, and every trainee
user created in the sandbox is gone. The shop's production data is never
touched by a reset.

The sandbox admin panel's other tools (Backup, Clear the database, SQL
console, API console, System info, Environment) all work on the sandbox
database only. The main panel's **Restore from backup** card does not exist
in the sandbox — the Reset page does that job.

Restarting the server restarts both copies together. There is one server
program; the sandbox is not a second program. When it stops, the main app and
the sandbox stop together, and both come back when it starts again.

## 15. Who can do what

| Task | Tech | Manager |
| --- | --- | --- |
| Log in, create batches, add devices | Yes | Yes |
| Decide a device's approval (approve/reject) while the batch awaits approval | No | Yes |
| Approve a batch | No | Yes |
| Add, swap, remove parts before approval | Yes | Yes |
| Swap same-SKU parts after approval | Yes | Yes |
| Add parts after approval within the device's Price Add Limit | Yes | Yes |
| Add or remove parts after approval beyond that (or at all with no limit) | No | Yes |
| Set or change a part's own price (shelf or Awaiting approval) | Yes | Yes |
| Change a part's own price on an approved (Open) batch | No | Yes, with a note (amends the approval) |
| Close a batch | Yes | Yes |
| Create purchase orders, receive, close with shortfall | Yes | Yes |
| Revise the lines of a purchase order (while Awaiting approval) | Yes | Yes |
| Delete a purchase order (while Awaiting approval) | Yes | Yes |
| Approve a purchase order | No | Yes |
| Change a purchase order's shipping cost (any status except Closed) | No | Yes |
| Create and complete RMA, buyback, and return orders | Yes | Yes |
| Scan into an open audit window; cycle count | Yes | Yes |
| Close an audit window (early, by hand) | No | Yes |
| Intake (migration and salvage) | Yes | Yes |
| Search | Yes | Yes |
| Price audit page and price refresh | No | Yes |
| Reports | No | Yes |
| Users (add users, change roles, deactivate) | No | Yes |
| Admin panel | No | Owner only, with the admin key |

**Admin**: a third role that currently has every Manager power — everything
above marked "Yes" for Manager is "Yes" for an admin too. It is separate in
name only, reserved for later functionality. The admin PANEL (with the admin
key) is the owner's, regardless of role.

## Where to read more

- `CONTEXT.md` — the full vocabulary of the shop's words.
- `README.md` — how to install, run, back up, and restore the program.
- `docs/logic-map.md` and `docs/data-model.md` — the full behavior, written for
  developers.
