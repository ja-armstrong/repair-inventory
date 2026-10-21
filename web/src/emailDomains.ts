/**
 * The email-domain allowlist as seen by the web client: a compile-time
 * constant injected by `vite.config.ts` (`define`), read from the same
 * `ALLOWED_EMAIL_DOMAINS` key of the project's `.env` that the API server
 * enforces. The server stays the authority — this copy only renders the hint
 * text on email forms (labels and placeholders); the server's own 400 message
 * names the configured domains when a request is refused.
 */
declare const __ALLOWED_EMAIL_DOMAINS__: string[];

export const allowedEmailDomains: string[] = __ALLOWED_EMAIL_DOMAINS__;

/** The "@a / @b" hint shown next to email inputs. */
export function allowedEmailLabel(): string {
  return allowedEmailDomains.map((domain) => `@${domain}`).join(" / ");
}
