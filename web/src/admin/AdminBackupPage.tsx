import { apiBase, isSandbox } from "../sandbox";

/**
 * One-click backup (spec story 82): the server takes a consistent online
 * backup (WAL-safe), saves it under data/backups, and streams the same file
 * as a timestamped download. A plain link is enough — the admin cookie
 * authenticates it and the browser handles the download. The filename stem
 * is the instance's (sandbox ticket 04): the sandbox panel saves
 * `sandbox-…sqlite`, production `repair-inventory-…sqlite` — same folder,
 * so the prefix says which database a file holds.
 */
const BACKUP_STEM = isSandbox ? "sandbox" : "repair-inventory";

export function AdminBackupPage() {
  return (
    <section>
      <h2>Backup</h2>
      <p>
        Downloads a consistent copy of {isSandbox ? "the SANDBOX database" : "the database"} as
        <code> {BACKUP_STEM}-YYYYMMDD-HHMMSS.sqlite</code> and saves the same file under{" "}
        <code>data/backups/</code>. The backup is taken with SQLite's online backup API, so it is
        safe to click while the shop is using the app. Keep copies of that folder somewhere off
        this computer —{" "}
        {isSandbox
          ? "for the sandbox these files are the safety net behind Reset and Clear, not disaster recovery."
          : "these backups are the disaster recovery."}
      </p>
      <p>
        {/* This anchor bypasses the api client (a plain download link, not
            fetch), so it prefixes through the sandbox seam itself. */}
        <a className="admin-button" href={`${apiBase}/api/admin/backup`} download>
          Download backup
        </a>
      </p>
    </section>
  );
}
