# Spec: PO approval panel and optional approval note

On a PO detail page whose order is **Awaiting approval**, the manager's
decision is the page's primary action — but today the Approve form renders as
an `h3` section buried between Shipping cost, Tracking, and the Timeline, and
it refuses to submit without an approval note (server 400, `required` input).
The shop wants the decision front and center and the prose optional: the
sign-off itself is the record; requiring a sentence for every approval is
friction (the same reasoning that made device-rejection notes optional —
`.scratch/optional-rejection-notes/spec.md`).

## Requirements

- **Panel at the top**: while the PO is Awaiting approval, a manager sees a
  large, bordered **Approve this purchase order** panel at the very top of
  the page, above Lines / Shipping cost / Tracking / Timeline. The panel
  stays manager-only and Awaiting-approval-only (the server enforces the
  same gate it always did).
- **Note optional**: `POST /api/purchase-orders/:id/approve` accepts a body
  with no `note`. When a note IS given it must be non-blank — a
  given-but-blank note is refused loudly (400), never silently dropped. A
  noteless approval records a `po.status_changed` payload WITHOUT a note key
  (the same payload shape the optional device-decision note uses).
- **Timeline**: the `po.status_changed` description renders the ` — note`
  suffix only when a note was actually given (no dangling dash).

## Consequence accepted

An approved PO's status-change event can carry no note — the approval's WHY
lives in the recorded transition itself, and the manager's identity and
timestamp are on the event regardless.
