import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../api";
import { adminApi, adminJson, type SettingsResponse } from "./api";

/**
 * The global settings editor (spec story 81): every setting with its current
 * value and minimum; the server validates (whole number of at least the
 * minimum) and records the change on the timeline. Invalid values are shown
 * with the server's reason verbatim.
 */
export function AdminSettingsPage() {
  const [settings, setSettings] = useState<SettingsResponse["settings"]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const body = await adminApi<SettingsResponse>("/api/admin/settings");
      setSettings(body.settings);
      setDrafts(Object.fromEntries(body.settings.map((setting) => [setting.key, setting.value])));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not load settings");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function save(key: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = await adminJson<SettingsResponse>("/api/admin/settings", { key, value: drafts[key] }, "PATCH");
      setSettings(body.settings);
      setDrafts(Object.fromEntries(body.settings.map((setting) => [setting.key, setting.value])));
      setNotice(`${key} updated.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Settings</h2>
      {notice && <p className="status-ok">{notice}</p>}
      {error && <p className="status-error">{error}</p>}
      <table className="table">
        <thead>
          <tr>
            <th>Setting</th>
            <th>Value</th>
            <th>Minimum</th>
            <th>Default</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {settings.map((setting) => (
            <tr key={setting.key}>
              <td>{setting.key}</td>
              <td>
                <input
                  value={drafts[setting.key] ?? setting.value}
                  onChange={(event) =>
                    setDrafts((current) => ({ ...current, [setting.key]: event.target.value }))
                  }
                  aria-label={setting.key}
                />
              </td>
              <td>{setting.min ?? "—"}</td>
              <td>{setting.default}</td>
              <td className="table-actions">
                <button type="button" disabled={busy} onClick={() => void save(setting.key)}>
                  Save
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
