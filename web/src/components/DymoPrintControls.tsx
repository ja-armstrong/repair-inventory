import { useCallback, useEffect, useState } from "react";
import { api, apiJson, ApiError } from "../api";
import type { LabelEntry, LabelSize } from "./LabelSheet";
import { DymoError, getPrinters, printAll, type DymoPrinter } from "../dymo/dymoClient";
import { LABEL_WRITER_PRINT_PARAMS_XML } from "../dymo/labelXml";

/**
 * The DYMO print controls (ticket 19): a printer picker fed by the DYMO
 * Connect local web service discovery, a primary "Print with DYMO (all)"
 * button that sends every label with no print dialog, and a status line.
 * Every failure path is loud and names the next action: service down
 * (start DYMO Connect on localhost:41951 / accept the self-signed
 * certificate), no DYMO printer found, no printer selected, and per-label
 * failures attributed to the exact serial.
 *
 * The chosen printer is persisted as the `dymo_printer_name` setting
 * (manager-editable server-side). A tech may still pick a printer for the
 * current session: the choice applies to this print regardless, and a 403
 * on save is surfaced as "applies to this session only" — never silently
 * dropped.
 */

interface DymoSettings {
  dymo_printer_name: string;
}

type Status = { kind: "idle" } | { kind: "busy" } | { kind: "ok"; message: string } | { kind: "error"; message: string };

export function DymoPrintControls({
  size,
  labels,
}: {
  size: LabelSize;
  labels: LabelEntry[];
}) {
  const [printers, setPrinters] = useState<DymoPrinter[] | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoadError(null);
    try {
      const list = await getPrinters();
      setPrinters(list);
      const settings = await api<DymoSettings>("/api/settings");
      const saved = settings.dymo_printer_name ?? "";
      // Start from the persisted choice when it is still installed; an
      // empty setting is an explicit "not chosen yet" — never defaulted to
      // the first printer found.
      setSelected(saved && list.some((p) => p.name === saved) ? saved : "");
    } catch (err) {
      setPrinters(null);
      setLoadError(
        err instanceof DymoError || err instanceof ApiError
          ? err.message
          : "could not reach the DYMO web service"
      );
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function choosePrinter(name: string): Promise<void> {
    // The picked printer applies to this session immediately; persisting it
    // as the shop default is manager-only. A failed save is stated, never
    // silently dropped.
    setSelected(name);
    try {
      await apiJson("/api/settings", { key: "dymo_printer_name", value: name }, "PATCH");
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setStatus({
          kind: "ok",
          message: `"${name}" applies to this session only — a manager can save it as the default printer.`,
        });
        return;
      }
      setStatus({
        kind: "error",
        message:
          err instanceof ApiError
            ? err.message
            : "could not save the printer choice — the selected printer is still used for this session",
      });
    }
  }  async function runPrintAll(): Promise<void> {
    setBusy(true);
    setStatus({ kind: "busy" });
    try {
      const result = await printAll(selected, size, labels, LABEL_WRITER_PRINT_PARAMS_XML);
      setStatus({
        kind: "ok",
        message: `Sent ${result.printed} of ${result.total} label${result.total === 1 ? "" : "s"} to ${selected}.`,
      });
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "printing failed",
      });
    } finally {
      setBusy(false);
    }
  }

  const noPrinters = printers !== null && printers.length === 0;
  const noSelection = printers !== null && printers.length > 0 && !selected;

  return (
    <div className="dymo-print-controls no-print">
      {/* The browser fallback stays available even when the DYMO service is
          unreachable — it is the fallback. The DYMO controls render only when
          the service check has a result, with its failure stated loudly. */}
      {loadError ? (
        <div className="form" style={{ flexDirection: "row", maxWidth: "none", alignItems: "end" }}>
          <button type="button" onClick={() => window.print()}>
            Print via browser
          </button>
          <button type="button" disabled={busy} onClick={() => void reload()}>
            Check again
          </button>
        </div>
      ) : null}
      {loadError ? (
        <p className="status-error">{loadError}</p>
      ) : (
        <>
          <div className="form" style={{ flexDirection: "row", maxWidth: "none", alignItems: "end" }}>
            <label>
              DYMO printer
              <select
                value={selected}
                disabled={busy || printers === null}
                onChange={(event) => void choosePrinter(event.target.value)}
              >
                <option value="">
                  {printers === null ? "checking for DYMO printers…" : "— choose a printer —"}
                </option>
                {(printers ?? []).map((printer) => (
                  <option key={printer.name} value={printer.name}>
                    {printer.name}
                    {printer.isConnected ? "" : " (not connected)"}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" disabled={busy || noSelection || labels.length === 0} onClick={() => void runPrintAll()}>
              {busy ? "Printing…" : "Print with DYMO (all)"}
            </button>
            <button type="button" onClick={() => window.print()}>
              Print via browser
            </button>
          </div>
          {noPrinters && (
            <p className="status-error">
              No DYMO printer found. Start DYMO Connect on this computer and check that the
              LabelWriter is plugged in and powered on, then reopen this page.
            </p>
          )}
          {noSelection && !noPrinters && (
            <p className="status-error">
              Choose a DYMO printer before printing — nothing is sent until one is selected.
            </p>
          )}
          {status.kind === "busy" && <p className="placeholder">Sending labels to DYMO…</p>}
          {status.kind === "ok" && <p className="status-ok">{status.message}</p>}
          {status.kind === "error" && <p className="status-error">{status.message}</p>}
        </>
      )}
    </div>
  );
}
