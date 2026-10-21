import type { Express } from "express";

/**
 * How login links leave the system (the "email plug"). The auth domain only
 * ever calls this interface, so SMTP can be wired in later by supplying
 * another implementation — no call site changes. Today the sole
 * implementation logs each link: to the server console, and to a list
 * retrievable by tests (through the test harness).
 */
export interface EmailPlug {
  sendLoginLink(to: string, url: string, expiresAt: Date): void | Promise<void>;
}

/** One login link the logging plug delivered. */
export interface SentLoginLink {
  readonly to: string;
  readonly url: string;
  readonly expiresAt: string;
}

export interface LoggingEmailPlug extends EmailPlug {
  /** Links delivered so far — the retrieval path tests (and dev) use. */
  readonly sent: ReadonlyArray<SentLoginLink>;
}

/** The plug used today: console + an in-memory, test-retrievable outbox. */
export function createLoggingEmailPlug(): LoggingEmailPlug {
  const sent: SentLoginLink[] = [];
  return {
    get sent() {
      return sent;
    },
    sendLoginLink(to, url, expiresAt) {
      sent.push({ to, url, expiresAt: expiresAt.toISOString() });
      const line = `[email-plug] login link for ${to}: ${url} (expires ${expiresAt.toISOString()})\n`;
      // write(), not console.log: tsx watch on Windows often never flushes log()
      process.stdout.write(line);
    },
  };
}

/**
 * The EMAIL PLUG SELECTION both instances share, called by the composition
 * root once per context: RESEND_KEY selects the Resend implementation (real
 * delivery); without it, the logging plug is live — the link goes to the
 * server console. RESEND_FROM sets the sender (a domain verified in Resend
 * lifts the sandbox's own-address-only limit); the default is Resend's shared
 * test sender. The selection is environment configuration, never a runtime
 * fallback: a failing Resend send throws and the request fails loudly.
 *
 * The sandbox runs the SAME selection as production (spec: sandbox
 * environment, decision 7 — reversed 2026-10-06 by user request: training
 * exercises the real email path, so handing links over the console is not
 * smart). `label` only names the instance in the selection line, so the
 * console shows each context's pick.
 */
export function createEmailPlugFromEnv(label: string): EmailPlug {
  const resendKey = process.env.RESEND_KEY?.trim();
  const resendFrom = process.env.RESEND_FROM?.trim() || "RMS <onboarding@resend.com>";
  if (resendKey) {
    process.stdout.write(`[auth] email plug (${label}): Resend (sending as ${resendFrom})\n`);
    return createResendEmailPlug(resendKey, resendFrom);
  }
  process.stdout.write(
    `[auth] email plug (${label}): console logging (RESEND_KEY is not set)\n`,
  );
  return createLoggingEmailPlug();
}

/** The app's email plug, installed by the auth domain at registration. */
export function getEmailPlug(app: Express): LoggingEmailPlug {
  const plug = (app.locals as { emailPlug?: LoggingEmailPlug }).emailPlug;
  if (!plug) {
    throw new Error("the auth domain must be registered before the email plug is used");
  }
  return plug;
}

/**
 * The Resend plug: real email delivery through resend.com's HTTP API.
 *
 * `fromAddress` is configuration (RESEND_FROM). Resend's shared sandbox
 * sender delivers ONLY to the account owner's own email address; a sender
 * on a domain verified in Resend delivers anywhere. Rejections surface
 * loudly from sendLoginLink; the console plug remains the backstop for
 * undeliverable recipients. Node 24's global fetch keeps this
 * dependency-free.
 */
export function createResendEmailPlug(apiKey: string, fromAddress: string): EmailPlug {
  const FROM = fromAddress;
  return {
    async sendLoginLink(to, url, expiresAt) {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: FROM,
          to,
          subject: "Your RMS login link",
          text: [
            "Use this link to log in to RMS:",
            url,
            "",
            `The link expires at ${expiresAt.toISOString()}.`,
          ].join("\n"),
        }),
      });
      if (!response.ok) {
        // Loud, with Resend's own words: a failed login-link send must stop
        // the request (500), never silently degrade to "no email happened".
        const detail = await response.text().catch(() => "");
        throw new Error(`Resend rejected the login-link email (HTTP ${response.status}): ${detail}`);
      }
      const line = `[email-plug] login link sent via Resend to ${to} (expires ${expiresAt.toISOString()})\n`;
      process.stdout.write(line);
    },
  };
}
