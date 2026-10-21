# 19: DYMO Web Connect printing — one click, no print dialog

**What to build:** Labels print straight to the DYMO LabelWriter through the DYMO local web service — no OS/browser print dialog, no manual page-range selection, no non-barcode pages to skip. A "Print with DYMO" action sends **all** requested labels automatically.

**Step 0 — verify the SDK facts before coding** (web research to DYMO's portal may be blocked from this environment; work around it):
- Known-architecture assumptions to verify: the DYMO Connect desktop install ships a local web service listening on `http://localhost:41951`; a JS framework (`dymo.connect.framework.js`) loaded by the page talks to it; the API provides init, printer discovery (`getPrinters`), opening a label from XML (`.label` format, DYMO Connect schema), and `print(label, printerName)`; the service renders barcodes driver-side (Barcode object supports Code 128), so the template carries a Barcode object (serial) plus text objects (SKU name, serial).
- Try: DYMO developer pages via alternate mirrors, the framework file itself on DYMO's download CDN, and — most reliably — the LOCAL DYMO Connect install on this machine for bundled framework files and samples (check `C:\Program Files\DYMO\` and ProgramData). Record what was verified vs. assumed in the ticket comments.
- If the framework JS can be legally bundled (it is a redistributable SDK component), bundle it locally so an offline shop PC works; otherwise load from DYMO's CDN with a loud offline error. State the choice and why.

**Integration:**
- A client printing module wrapping the SDK: explicit init status; printer discovery; the chosen printer persisted as a new setting (`dymo_printer_name`, manager-editable via the existing settings seam); `printOne(label)` and `printAll(labels)` looping the list (the service queues them).
- Label template: a `.label` XML template matching the configured label size (settings already carry width/height in sixteenths; current stock 2-5/16" × 4") with a Code 128 Barcode object (the serial) + text objects (SKU name, serial). Built/transformed per label from the existing label-data endpoints.
- **Loud failure paths** (per the AGENTS.md standard — never a silent fallback): framework not loadable; service not reachable on 41951 ("start DYMO Connect — its web service listens on localhost:41951"); no DYMO printer found; per-label print errors. Each names the next action.
- **UI**: on both label surfaces (PO labels, intake labels): a primary "Print with DYMO (all)" button, a printer picker fed by discovery, and a status line. The browser print view remains as an explicit secondary button ("Print via browser").
- **Fallback pagination fix**: the browser path must print exactly the labels — one label per page, nothing else, no blank pages (`@media print` renders only the label sheet, each label `break-after: page` except the last, `@page` sized to the label). This kills the manual page-range dance when the DYMO path is unavailable.
- HTTPS note: the app serves plain http on the LAN, so calling the local http service is fine; document that an https deployment would need the exception for localhost.

**Tests:** the DYMO service is outside the test seam (client has no unit tests — build is the gate). Server-side: the new setting round-trips and validates. Include a **manual verification checklist** in the ticket comments: with DYMO Connect running, print one label; print all from a PO; unplug-path (stop the service) shows the loud message.

**Blocked by:** none (08's label surfaces and settings exist).

**Status:** ready-for-human

- [x] SDK facts verified or explicitly marked assumed; framework bundled locally if obtainable (see Comments — verified but deliberately NOT bundled, with reasons)
- [x] "Print with DYMO (all)" on PO labels and intake labels sends every label without any dialog; per-label failures surface loudly
- [x] Printer choice persisted in settings; discovery lists installed DYMO printers
- [x] Service-down, no-printer, and offline states each show a specific, actionable message
- [x] Browser fallback prints only the labels, one per page, no blanks, no app chrome
- [x] Manual verification checklist recorded; full suite, typecheck, build green

## Comments

### Step 0 — SDK facts: verified vs assumed (all verified against the LIVE service on this machine)

DYMO Connect 1.6.2.9 is installed here (`C:\Program Files (x86)\DYMO\DYMO Connect`) with the web
service (`DYMO.WebApi.Win.Host.exe`) RUNNING during verification, so every fact below was checked
against the real service, not just read from source.

| Fact | Ticket's assumption | Verified | How |
| --- | --- | --- | --- |
| Local service on localhost:41951 | assumed | **YES, but HTTPS** — `%LOCALAPPDATA%\DYMO\DYMOConnect\DYMOWebApi.Json` says `PortNumber: 41951, UseSSL: true`; the framework JS confirms `WS_PROTOCOL="https://"`, port range 41951–41960, host 127.0.0.1/localhost | config file + framework source + live `curl -k https://localhost:41951/...` |
| JS framework `dymo.connect.framework.js` talks to it | assumed | YES | fetched the framework (343,874 bytes) from DYMO's official GitHub (`dymosoftware/dymo-connect-framework`); extracted the exact constants and command list |
| API: init, `getPrinters`, open label XML, `print(label, printer)` | assumed | Exact wire contract verified live: `GET /DYMO/DLS/Printing/StatusConnected` → `true`; `GET .../GetPrinters` → XML (`<Printers><LabelWriterPrinter><Name>…`); `POST .../PrintLabel` with form-urlencoded `printerName`, `printParamsXml`, `labelXml`, `labelSetXml` → body `"true"`/`"false"`; `POST .../RenderLabel` → base64 PNG. `GetJobStatus` exists in the protocol but is NOT implemented by this service/framework combination — per-label confirmation is the boolean PrintLabel response only | live probes + framework source |
| Service sends CORS headers | — | YES: `Access-Control-Allow-Origin: *` (server header: Kestrel), so a page on any origin can call it | live `curl -i` with a foreign Origin |
| `.label` XML template; Barcode object supports Code 128 | assumed | YES — the service does NOT accept old DLS v8 (`DieCutLabel`) XML for RenderLabel ("The 'DieCutLabel' element is not declared"); the DYMO Connect (DCD) schema was extracted from genuine sample layouts embedded in `DYMOConnect.exe` (root `<LabelFile version="1"><DYMOLabel>`, geometry in decimal inches, `<BarcodeObject><BarcodeFormat>Code128Auto</BarcodeFormat><Data>…`), then verified by rendering the template via `RenderLabel` and visually inspecting the returned PNG (bold SKU name, Code 128 bars with the serial beneath, serial text line) | binary extraction + live render (PNG inspected) |
| Driver-side barcode rendering | assumed | Consistent with observations (the service renders; the template carries only format + data) | live render |
| A real printer is attached here | — | YES: `GetPrinters` reports **DYMO LabelWriter 450, IsConnected=True** | live probe |

A single test label was printed to the real LabelWriter 450 during Step 0 verification
(`PrintLabel` → `true`); 3 more during the browser smoke test (below).

### Framework source and the bundling decision (deviation from the ticket's Step 0 option A)

**NOT bundling `dymo.connect.framework.js`.** The framework is obtainable (DYMO's official GitHub
repo, `dymosoftware/dymo-connect-framework`), but: its license is "Other/NOASSERTION" (not clearly
redistributable), it is a 344 KB minified Closure blob using synchronous XHR and an untyped global
namespace, and it adds nothing we need — the web-service wire contract it implements was extracted
from its source and verified directly against the live service. `web/src/dymo/dymoClient.ts` is a
fully typed client speaking that contract. No CDN dependency either, so an offline shop PC works.
This also fits the review standard: the seam is the DYMO local web service itself, with an
explicit, auditable contract.

### What was built

- `web/src/dymo/dymoClient.ts` — service discovery (StatusConnected port scan 41951–41960, cached;
  cache invalidated on any connection failure so a restart on another port re-scans), `getPrinters`
  (XML parse), `printOne` (PrintLabel; a `"false"` answer and non-200 answers are loud errors),
  `printAll` (sequential per-label send with confirmations; a failure throws naming the exact
  serial and the count reached).
- `web/src/dymo/labelXml.ts` — the DCD template generator: `DYMORect` (printable area) derived from
  the configured `label_width/height_sixteenths` settings (verified that DYMORect drives the
  rendered/printed content size); `<LabelName>Shipping</LabelName>` (the 30256 stock, our default
  2-5/16" × 4" — LabelName must be an installed stock name; custom names are refused by the
  service). Code 128 Auto barcode object carries the serial; text objects carry SKU name and serial.
- `web/src/components/DymoPrintControls.tsx` — the toolbar on BOTH label surfaces: printer picker
  (discovery-fed, marks not-connected printers), primary **"Print with DYMO (all)"** (no dialog),
  secondary **"Print via browser"**, and a status line. The pick persists via
  `PATCH /api/settings {key: "dymo_printer_name"}`; a tech's 403 is surfaced as "applies to this
  session only" — never silently dropped. The browser fallback stays available (with a
  "Check again" retry) even when the DYMO service is unreachable.
- Settings seam (`server/domains/parts/settings.ts`): first TEXT-typed setting
  (`dymo_printer_name`, trimmed, max 200 chars, empty = "not chosen yet"); `getSettingStr` added;
  `getSettingInt` refuses text keys and vice versa (caller-bug = loud throw); both write seams
  (manager + admin) share the extended validator. No migration needed (row created on first write).
- Browser fallback pagination fix (LabelSheet + styles.css): `@page` sized from the configured
  stock (injected from settings data), everything but the label cards hidden in `@media print`,
  one label per page with `break-after: page` on every card except the last — no blank pages.
- HTTPS note (in docs/manual.md): the app serves plain http on the LAN, so calling the local
  https service is fine; the FIRST use (and after clearing it) requires accepting the DYMO
  service's self-signed certificate once per browser — open
  `https://localhost:41951/DYMO/DLS/Printing/StatusConnected`, accept the warning, return to the
  labels page. An https deployment of the app would need the same localhost exception.

### Verified in a real browser (dev server + the live service + real printer)

- Intake labels page (`/inventory/labels?ids=1,2,3`): picker discovered "DYMO LabelWriter 450";
  loud "choose a printer" state before selection; selecting as manager persisted the setting and
  recorded `setting.updated` (from "" → "DYMO LabelWriter 450"); after reload the persisted
  printer auto-selected; "Print with DYMO (all)" reported **"Sent 3 of 3 labels to DYMO
  LabelWriter 450."** with no dialog.
- The generated label XML was also rendered via `RenderLabel` and the PNG inspected (name, Code 128
  bars + serial, serial text, all inside the printable area).

### Manual verification checklist (human, with the real printer)

1. **Print one label**: with DYMO Connect running, open an intake labels page, pick the printer,
   click **Print with DYMO (all)** with one label → one label feeds out, barcode scans as the
   serial, SKU name and serial read correctly. (Expected to pass — 4 test labels printed this way
   during development.)
2. **Print all from a PO**: approve a PO with several lines → Labels → **Print with DYMO (all)**
   → one label per expected serial, no dialogs, status "Sent N of N".
3. **Unplug path**: quit DYMO Connect, reload a labels page → loud message naming
   `https://localhost:41951`, "Start DYMO Connect", and the certificate-acceptance URL; **Print
   via browser** still works.
4. **No-printer path**: DYMO Connect running but the USB cable unplugged → picker shows
   "DYMO LabelWriter 450 (not connected)"; printing is refused loudly if attempted.
5. **Browser fallback**: on a labels page click **Print via browser** → print preview shows ONLY
   the labels, one per page, on the configured stock size, no app header, no blank pages.

### Deviations and notes

- **Framework not bundled** (see above) — the ticket's alternative (load from DYMO's CDN with a
  loud offline error) was rejected for the same reason: no external dependency at all.
- **Template format is DYMO Connect (DCD), not DLS v8** — the ticket said ".label XML … DYMO
  Connect schema"; verified that the service rejects the old DLS schema for rendering, so the
  generator emits the DCD schema from DYMO's own samples. The generator emits XML per label rather
  than shipping a static .label file, because the printable area must follow the settings.
- `GET /api/settings` now returns one string value among numbers
  (`dymo_printer_name`); `listSettings` is `Record<string, number | string>`. Admin settings JSON
  reports `min: null` for text settings (UI renders "—").
- Existing "Print labels" button on both label pages is replaced by the controls block
  (DYMO primary + browser secondary); no other page flows changed.
