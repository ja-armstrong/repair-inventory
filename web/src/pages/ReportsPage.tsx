import { useState, type FormEvent } from "react";
import { useAuth } from "../auth";
import { ApiError } from "../api";
import { apiBase } from "../sandbox";

/**
 * The manager's reports page (ticket 12): the five CSV downloads, each over
 * an inclusive from/to date range picked here. The server generates the CSV
 * (RFC-4180 quoting, header rows) and this page saves it as a file — the
 * download is a plain GET, so the browser's session cookie carries auth.
 */

interface ReportDefinition {
  slug: string;
  title: string;
  description: string;
}

const REPORTS: ReportDefinition[] = [
  {
    slug: "expenses",
    title: "Total expenses",
    description: "Consumed purchased parts, consumable usage, and PO shipping.",
  },
  {
    slug: "rma-recovery",
    title: "RMA recovery",
    description: "Per-part credits recorded when RMA orders complete; rejected parts at zero.",
  },
  {
    slug: "buyback-recovery",
    title: "Buyback recovery",
    description: "The one hand-entered value of each buyback order, per completion date.",
  },
  {
    slug: "returns-revenue",
    title: "Returns revenue",
    description:
      "Return orders count each part's price as revenue the moment the order completes — booked, no manual entry.",
  },
  {
    slug: "batches-completed",
    title: "Batches completed",
    description: "Batches closed in the range with device outcome counts.",
  },
  {
    slug: "shrink",
    title: "Shrink",
    description: "Damaged by Tech and audit-failed parts at price, cause-separated.",
  },
  {
    slug: "tech-stats",
    title: "Per-tech stats",
    description: "Repairs completed, average repair time, and attributed damage per tech.",
  },
];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function firstOfMonth(): string {
  return `${today().slice(0, 7)}-01`;
}

async function downloadCsv(report: ReportDefinition, from: string, to: string): Promise<void> {
  // A raw fetch (the download needs a blob, not JSON) — it must prefix
  // through the sandbox seam itself, like the api client does.
  const response = await fetch(
    `${apiBase}/api/reports/${report.slug}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
  if (!response.ok) {
    let message = `request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) {
        message = body.error;
      }
    } catch {
      // non-JSON error body; keep the generic message
    }
    throw new ApiError(response.status, message);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${report.slug}_${from}_${to}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export function ReportsPage() {
  const { user } = useAuth();
  const [from, setFrom] = useState(firstOfMonth);
  const [to, setTo] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (user && user.role !== "manager") {
    return (
      <section>
        <h2>Reports</h2>
        <p className="status-error">Reports are manager-only.</p>
      </section>
    );
  }

  function onDownload(event: FormEvent<HTMLFormElement>, report: ReportDefinition) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    void downloadCsv(report, from, to)
      .catch((err) => setError(err instanceof ApiError ? err.message : "the download failed"))
      .finally(() => setBusy(false));
  }

  return (
    <section>
      <h2>Reports</h2>
      <p className="placeholder">
        Every report covers its date range inclusively (both from and to) and downloads as a CSV
        that Excel and PowerBI import cleanly.
      </p>
      {error && <p className="status-error">{error}</p>}
      <table className="table">
        <thead>
          <tr>
            <th>Report</th>
            <th>From</th>
            <th>To</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {REPORTS.map((report) => (
            <tr key={report.slug}>
              <td>
                <strong>{report.title}</strong>
                <br />
                <small>{report.description}</small>
              </td>
              <td>
                <input
                  type="date"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                  aria-label={`From date for ${report.title}`}
                />
              </td>
              <td>
                <input
                  type="date"
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                  aria-label={`To date for ${report.title}`}
                />
              </td>
              <td className="table-actions">
                <form onSubmit={(event) => onDownload(event, report)}>
                  <button type="submit" disabled={busy}>
                    Download CSV
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
