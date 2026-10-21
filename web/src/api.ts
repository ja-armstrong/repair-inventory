/**
 * Thin API client: JSON in, JSON out (or 204 → undefined), non-2xx responses
 * become `ApiError` carrying the server's `{ error }` message.
 */
import { apiBase } from "./sandbox";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  // The sandbox seam: every request path is prefixed at this single call
  // site, so the ~30 call-sites throughout the app never mention the env.
  const response = await fetch(
    `${apiBase}${path}`,
    init?.body !== undefined
      ? { ...init, headers: { "content-type": "application/json" } }
      : init,
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
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export function apiJson<T>(path: string, body: unknown, method = "POST"): Promise<T> {
  return api<T>(path, { method, body: JSON.stringify(body) });
}
