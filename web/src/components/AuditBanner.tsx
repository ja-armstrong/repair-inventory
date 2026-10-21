import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { bannerMessage, bannerState, type AuditStatusPayload } from "../auditBanner";

/**
 * The client polls the banner endpoint once a minute. That poll is also what
 * makes the lazy boundary processor timely (ADR-0002): every status request
 * settles a due boundary before it reads, so the payload below always
 * reflects the current lifecycle state.
 */
const POLL_MS = 60_000;

/**
 * The app-wide audit banner (ticket 04, ADR-0002): the two steady states of
 * the automatic window lifecycle — the open window naming itself and its
 * boundary, or the gap countdown to the next scheduled open. Rendered by the
 * AppLayout above every page.
 */
export function AuditBanner() {
  const [status, setStatus] = useState<AuditStatusPayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll(): Promise<void> {
      try {
        const loaded = await api<AuditStatusPayload>("/api/audits/status");
        if (!cancelled) {
          setStatus(loaded);
        }
      } catch {
        // no session yet, or a transient failure — the next poll retries
      }
    }
    void poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!status) {
    return null;
  }
  const message = bannerMessage(bannerState(status), new Date());
  if (message === null) {
    // The bootstrap state: no audits yet, nothing to nag about.
    return null;
  }
  return (
    <p className="audit-banner">
      {message} <Link to="/counting">Go to counting</Link>
    </p>
  );
}
