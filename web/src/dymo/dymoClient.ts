/**
 * Client printing module for the DYMO Connect local web service (ticket 19).
 *
 * Step 0 SDK facts verified on the live service on this machine
 * (DYMO Connect 1.6.2.9, DYMO.WebApi.Win.Host.exe running):
 * - The service listens on HTTPS at localhost:41951 (config UseSSL: true;
 *   the framework scans ports 41951–41960), path "DYMO/DLS/Printing",
 *   server header "Kestrel", and answers with
 *   `Access-Control-Allow-Origin: *` so a browser page on any origin can
 *   call it. The first visit must have the self-signed certificate accepted
 *   in the browser — the framework's samples require the same manual step.
 * - GET  .../StatusConnected → body "true"
 * - GET  .../GetPrinters     → XML: <Printers><LabelWriterPrinter>
 *                               <Name>…</Name>…</LabelWriterPrinter>
 * - POST .../PrintLabel      → form-urlencoded printerName, printParamsXml,
 *                              labelXml, labelSetXml; body "true" | "false"
 * - POST .../RenderLabel     → base64 PNG (used only for the template
 *                              verification in Step 0)
 * - GetJobStatus exists in the protocol but is not implemented by this
 *   service/framework combination, so per-label confirmation is the
 *   boolean PrintLabel response only.
 * The service renders barcodes driver-side; the label template only carries
 * a Code 128 (<BarcodeFormat>Code128Auto</BarcodeFormat>) object.
 *
 * Choice NOT to bundle dymo.connect.framework.js: the redistributable
 * framework JS (344 KB minified, license "Other/NOASSERTION", synchronous
 * XHR, untyped global namespace) is not needed — this module speaks the
 * verified service contract directly, fully typed, with no external CDN
 * dependency, so an offline shop PC works.
 */

import type { LabelEntry, LabelSize } from "../components/LabelSheet";
import { buildSerialLabelXml } from "./labelXml";

const SERVICE_HOST = "localhost";
const SERVICE_PATH = "DYMO/DLS/Printing";
// The DYMO framework scans ports 41951–41960 (WS_START_PORT..WS_END_PORT).
const SERVICE_PORTS = [41951, 41952, 41953, 41954, 41955, 41956, 41957, 41958, 41959, 41960];

const CERT_HINT =
  "If DYMO Connect is running, open https://localhost:41951/DYMO/DLS/Printing/StatusConnected in this browser once and accept the self-signed certificate warning, then try again.";

export class DymoError extends Error {}

let cachedPort: number | null = null;

function serviceUrl(port: number, command: string): string {
  return `https://${SERVICE_HOST}:${port}/${SERVICE_PATH}/${command}`;
}

async function serviceGet(port: number, command: string): Promise<Response> {
  return fetch(serviceUrl(port, command), { method: "GET" });
}

async function servicePost(
  port: number,
  command: string,
  params: Record<string, string>
): Promise<Response> {
  const body = Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return fetch(serviceUrl(port, command), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

/**
 * Find the local DYMO web service: probe StatusConnected across the DYMO
 * port range and cache the first port that answers. Every failure is loud —
 * the message names the port and both possible fixes (start DYMO Connect,
 * or accept the self-signed certificate once).
 */
export async function findService(): Promise<number> {
  if (cachedPort !== null) {
    return cachedPort;
  }
  for (const port of SERVICE_PORTS) {
    try {
      const response = await serviceGet(port, "StatusConnected");
      if (response.ok && (await response.text()).trim() === "true") {
        cachedPort = port;
        return port;
      }
    } catch {
      // try the next port in the DYMO range
    }
  }
  throw new DymoError(
    `The DYMO web service is not reachable on https://${SERVICE_HOST}:41951. ` +
      `Start DYMO Connect on this computer — its web service listens on localhost:41951. ` +
      CERT_HINT
  );
}

/** A failed call invalidates the cached port: the next attempt re-scans, in case DYMO Connect restarted on a different port in the range. */
function invalidateCachedService(): void {
  cachedPort = null;
}

export interface DymoPrinter {
  name: string;
  modelName: string;
  isConnected: boolean;
  isTwinTurbo: boolean;
}

/** List installed DYMO LabelWriter printers from the local web service. */
export async function getPrinters(): Promise<DymoPrinter[]> {
  const port = await findService();
  let response: Response;
  try {
    response = await serviceGet(port, "GetPrinters");
  } catch {
    invalidateCachedService();
    throw new DymoError(
      `Lost contact with the DYMO web service on https://${SERVICE_HOST}:${port} while listing printers. ` +
        `Start DYMO Connect — its web service listens on localhost:41951. ` +
        CERT_HINT
    );
  }
  if (!response.ok) {
    throw new DymoError(
      `DYMO web service returned status ${response.status} for GetPrinters on port ${port}. ` +
        `Restart DYMO Connect and try again.`
    );
  }
  const text = await response.text();
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new DymoError(
      `DYMO web service returned unreadable printer data on port ${port}. ` +
        `Restart DYMO Connect and try again.`
    );
  }
  const printers: DymoPrinter[] = [];
  for (const node of Array.from(doc.getElementsByTagName("LabelWriterPrinter"))) {
    const read = (tag: string): string | null =>
      node.getElementsByTagName(tag)[0]?.textContent?.trim() ?? null;
    const name = read("Name");
    if (!name) {
      continue;
    }
    printers.push({
      name,
      modelName: read("ModelName") ?? name,
      isConnected: (read("IsConnected") ?? "").toLowerCase() === "true",
      isTwinTurbo: (read("IsTwinTurbo") ?? "").toLowerCase() === "true",
    });
  }
  return printers;
}

/**
 * Send one label to the chosen DYMO printer with no print dialog. The
 * service answers "true" / "false": a "false" or a non-200 answer is a
 * loud per-label failure naming the printer, the label and the service.
 */
export async function printOne(
  printerName: string,
  labelXml: string,
  printParamsXml: string
): Promise<void> {
  const port = await findService();
  let response: Response;
  try {
    response = await servicePost(port, "PrintLabel", {
      printerName,
      printParamsXml,
      labelXml,
      labelSetXml: "",
    });
  } catch {
    invalidateCachedService();
    throw new DymoError(
      `Could not reach the DYMO web service on https://${SERVICE_HOST}:${port} while printing. ` +
        `Start DYMO Connect — its web service listens on localhost:41951. ` +
        CERT_HINT
    );
  }
  const text = (await response.text()).trim();
  if (!response.ok) {
    throw new DymoError(
      `DYMO web service refused the print job for printer "${printerName}" ` +
        `(status ${response.status}): ${text || "no error detail"}. ` +
        `Check that the printer name matches DYMO Connect exactly.`
    );
  }
  if (text.toLowerCase() !== "true") {
    throw new DymoError(
      `The DYMO web service did not accept the label for printer "${printerName}" ` +
        `(service answered "${text}"). ` +
        `Check the label stock loaded in the printer and the printer name in DYMO Connect.`
    );
  }
}

export interface PrintAllResult {
  /** Number of labels the service accepted. */
  printed: number;
  total: number;
}

/**
 * Print every label in order through the local service. The service queues
 * the jobs; each label is sent and confirmed one at a time so a failure is
 * attributed to the exact serial — the run stops there and throws with the
 * serial named, never skipping a label silently.
 */
export async function printAll(
  printerName: string,
  size: LabelSize,
  entries: LabelEntry[],
  printParamsXml: string
): Promise<PrintAllResult> {
  let printed = 0;
  for (const entry of entries) {
    const labelXml = buildSerialLabelXml(size, entry);
    try {
      await printOne(printerName, labelXml, printParamsXml);
      printed += 1;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new DymoError(
        `Printing stopped at label ${printed + 1} of ${entries.length} (serial ${entry.serial}). ` +
          `${detail}`
      );
    }
  }
  return { printed, total: entries.length };
}
