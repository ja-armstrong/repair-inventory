# Received-part expenses and shortfall demand release

Two changes to the purchaseorders/reports seam:

1. **Expenses count receipts, not consumption.** The expense report should
   show the cost of all parts RECEIVED via purchase orders — not the consumed
   subset, and not the ordered lines total. A received part is spent money
   whether or not a repair consumes it; and a shortfall close usually means
   the vendor failed to ship (or the line was a mistake), so the ordered total
   would overstate spend. Decisions (user-confirmed):
   - Consumables switch to receipt-based too (their usage lines disappear —
     counting both would double-count). `device_consumables` remains the
     Parts Cost record.
   - The non-purchased consumption section (consumed migration/salvage parts,
     excluded from the total) STAYS, still keyed off the close-settlement
     events.
2. **Shortfall close releases demand.** When a PO closes with a shortfall,
   the demand records it had marked ordered must return to the outstanding
   purchasing queue — the goods never came, so the need is unmet and must be
   orderable again.
