# Spec: Reject stays clickable after a device is approved

Bug report: on the batch page's Approval column, the **Reject** button was
disabled once a device's decision was "approved" — an approval made by
mistake could not be corrected from the UI, even though the server allows
re-deciding until the batch opens (the latest decision wins).

## Requirement

Each decision button locks only on ITS OWN current decision: Approve is
disabled while the device is already approved (re-clicking is event noise);
Reject is disabled while the device is already rejected. A device approved by
mistake can be rejected, and a rejected one can be approved — exactly the
re-togglability the server enforces.
