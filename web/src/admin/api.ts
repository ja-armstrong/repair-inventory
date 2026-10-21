import { ApiError } from "../api";
import { apiBase } from "../sandbox";

/**
 * The admin surface's API client (ticket 18): same JSON-in/JSON-out contract
 * as the main `api.ts`, but never forcing a JSON content-type — the restore
 * upload sends raw bytes as `application/octet-stream`. Errors carry the
 * server's `{ error }` message verbatim; the SQL console shows it as-is.
 */
export async function adminApi<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const bodyIsBytes = init?.body instanceof Blob || init?.body instanceof ArrayBuffer;
  if (init?.body !== undefined && !bodyIsBytes && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  // The sandbox seam: same prefix rule as the main api.ts — both fetch call
  // sites in this file prefix, so admin call-sites never mention the env.
  const response = await fetch(`${apiBase}${path}`, { ...init, headers });
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
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export function adminJson<T>(path: string, body: unknown, method = "POST"): Promise<T> {
  return adminApi<T>(path, { method, body: JSON.stringify(body) });
}

export function adminUpload(path: string, filename: string, bytes: ArrayBuffer): Promise<Response> {
  return fetch(`${apiBase}${path}?filename=${encodeURIComponent(filename)}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: bytes,
  });
}

export interface AdminSetting {
  key: string;
  value: string;
  /** Minimum for numeric settings; null for text settings (ticket 19). */
  min: number | null;
  default: string;
}

export interface SettingsResponse {
  settings: AdminSetting[];
}

export interface SystemInfo {
  tables: Array<{ name: string; rows: number }>;
  migrations: Array<{ name: string; applied_at: string }>;
  uptimeSeconds: number;
  dbPath: string;
  dbSizeBytes: number | null;
  backupsDirectory: string;
  nodeVersion: string;
  appVersion: string;
}

export interface SqlResult {
  columns?: string[];
  rows?: Record<string, unknown>[];
  rowCount?: number;
  changes?: number;
  ok?: boolean;
  backup?: string;
}

// Ticket 22 — .env editor, restart, API console.

export interface EnvEntry {
  key: string;
  description: string;
  editable: boolean;
  secret: boolean;
  reason: string | null;
  value: string;
  pendingRestart: boolean;
}

export interface EnvState {
  file: { path: string; exists: boolean };
  entries: EnvEntry[];
  restartRequired: boolean;
  note: string;
  /** Which database THIS panel governs, resolved server-side (read-only). */
  instance: { dbPath: string; mountPrefix: string };
}

export interface RestartGate {
  allowed: boolean;
  mode: "dev" | "supervised" | "refused";
  explanation: string;
}

export interface ApiConsoleResult {
  status: number;
  headers: { "content-type": string | null; "content-disposition": string | null };
  body: unknown;
}

// User & role management (the admin panel owns the user base — there is no
// bootstrap manager).

export interface AdminUser {
  id: number;
  email: string;
  role: "admin" | "manager" | "tech";
  active: boolean;
  createdAt: string;
}

export interface AdminUsersResponse {
  users: AdminUser[];
}

// Sandbox reset (sandbox ticket 05): the trainer picks any .sqlite from
// data/backups/ (sandbox- snapshots included) or uploads one; both paths
// stage a swap of the SANDBOX database that takes effect at the next restart.

export interface ResetSource {
  filename: string;
  sizeBytes: number;
  modifiedAt: string;
  /** True when the file snapshots the SANDBOX database (`sandbox-` prefix). */
  sandboxSnapshot: boolean;
}

export interface ResetSourcesResponse {
  sources: ResetSource[];
  empty: boolean;
}

export interface ResetResponse {
  ok: true;
  /** The pre-reset backup of the current sandbox database (the undo path). */
  backup: string;
  staged: string;
  restartRequired: true;
  note: string;
}
