import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../api";
import { adminApi, type SystemInfo } from "./api";

/** System info (spec story 86): row counts per table, applied migrations, uptime, database file. */
export function AdminSystemPage() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setInfo(await adminApi<SystemInfo>("/api/admin/system"));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not load system info");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (error) {
    return (
      <section>
        <h2>System info</h2>
        <p className="status-error">{error}</p>
      </section>
    );
  }
  if (!info) {
    return null;
  }

  const size =
    info.dbSizeBytes === null ? "unknown" : `${(info.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`;

  return (
    <section>
      <h2>System info</h2>

      <h3>Database</h3>
      <table className="table">
        <tbody>
          <tr>
            <th>App version</th>
            <td>{info.appVersion}</td>
          </tr>
          <tr>
            <th>Node</th>
            <td>{info.nodeVersion}</td>
          </tr>
          <tr>
            <th>Uptime</th>
            <td>{formatUptime(info.uptimeSeconds)}</td>
          </tr>
          <tr>
            <th>Database file</th>
            <td>{info.dbPath}</td>
          </tr>
          <tr>
            <th>Database size</th>
            <td>{size}</td>
          </tr>
          <tr>
            <th>Backups directory</th>
            <td>{info.backupsDirectory}</td>
          </tr>
        </tbody>
      </table>

      <h3>Row counts</h3>
      <table className="table">
        <thead>
          <tr>
            <th>Table</th>
            <th>Rows</th>
          </tr>
        </thead>
        <tbody>
          {info.tables.map((table) => (
            <tr key={table.name}>
              <td>{table.name}</td>
              <td>{table.rows}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Applied migrations</h3>
      <table className="table">
        <thead>
          <tr>
            <th>Migration</th>
            <th>Applied at</th>
          </tr>
        </thead>
        <tbody>
          {info.migrations.map((migration) => (
            <tr key={migration.name}>
              <td>{migration.name}</td>
              <td>{migration.applied_at}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function formatUptime(seconds: number): string {
  const totalMinutes = Math.floor(seconds / 60);
  const days = Math.floor(totalMinutes / 60 / 24);
  const hours = Math.floor((totalMinutes - days * 24 * 60) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}
