# 17: Simple-English manual

**What to build:** `docs/manual.md` — the user manual in Simple English (the simple.wikipedia register): short sentences, common words, literal statements. No analogies, no idioms, no undefined jargon. Program flow top to bottom for a repair tech who has never read a codebase: logging in; making a batch; adding devices; adding, swapping, and removing parts; what each part status means and who may change what; approval and closing; ordering (POs) and receiving by scan; returns (RMA orders); counting (audits and cycle counts); intake outside POs (migration and salvage); searching; and reports. Every automatic behavior stated literally — "when you close the batch, the parts you used become Unavailable" — so the tech knows what the system will do without being told.

**Blocked by:** 16 (the system is documented; the manual describes the same flows in simpler words).

**Status:** ready-for-human

- [x] Covers every user-facing flow end to end, in the order a tech meets them
- [x] Simple-English register throughout: no analogies, no idioms, no undefined terms
- [x] Every automatic behavior (reservations, demand, auto-reserve on receipt, audit settlement, close settlement) stated literally
- [x] A non-technical reader can follow each flow without opening the code

## Comments

- Wrote `docs/manual.md` (~440 lines): a short word list, part statuses, then
  the 14 flow sections in the order a tech meets them — login, screen tour,
  batches/devices, parts, swap/remove, approval/closing/retriage, POs and
  scan-to-receive, RMA orders, audits and cycle counts, intake (migration and
  salvage), search, reports, admin panel, and the tech-vs-manager table.
- Every claim was verified against the web pages (`web/src/pages/`,
  `web/src/components/`) and the server code, not just the logic map. UI
  wording wins in the manual: nav labels, button labels ("Approve →
  In-transit", "Close with shortfall", "Physically counted now"), field names,
  and the exact destination-choice strings.
- Literal automatic behaviors stated with what the code actually does:
  oldest-Available pick with price snapshot; demand auto-move to Parts needed;
  receipt creating the part as Available, refreshing the SKU price to the line
  unit cost, fulfilling demand and auto-reserving onto the waiting device —
  while the device itself stays in Parts needed (a human moves it out; the
  server deliberately does not, see `receiving.ts` line 418 comment); close
  settling attached parts to Unavailable; audit close failing due-but-unscanned
  parts with the Reserved-attachment settlement; scan-wins only for
  Unavailable/RMA (not Damaged by Tech).
- Doc-vs-code mismatch found and reported, not fixed: the Cycle count page's
  help text (`web/src/pages/CycleCountPage.tsx`, "Expected = ..." paragraph)
  says scanning a Damaged by Tech part makes it Available again ("the scan
  wins"), but `scanDisagreesWithStatus` in `server/domains/audits/counting.ts`
  only restores Unavailable and RMA. The manual states the code rule. Left as a
  one-line UI-copy fix for an implementation ticket.
- Also noted in the manual: `docs/manual.md` mentions the spec-story promise
  that PO receipt auto-reserves "to the batch" — the implementation reserves
  onto the device row when the demand carries a device (the true, narrower
  behavior); the manual describes what is.
- README pointer updated from "not yet written" to a link (same commit, as
  instructed).
