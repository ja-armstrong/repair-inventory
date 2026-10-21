# 03 — Sandbox auth: prefixed login links, console-only email

Status: ready-for-human
Labels: ready-for-human
Blocked by: 01, 02

Implements `.scratch/sandbox-environment/spec.md` (decisions 6, 7).

Training must exercise the REAL login flow (link request → redeem → session)
and the REAL role gates. Email must never leave the machine from the sandbox.

## Requirement

- Login links are built in `server/domains/auth/index.ts` as
  `${origin}/redeem?token=...` (and again in the admin panel's mint-link
  route). Both build sites must honor the context's mount prefix from
  ticket 01: sandbox links are `${origin}/sandbox/redeem?token=...`. One
  shared helper, two call sites — no divergent copies of the rule.
- The email plug selection must become context-driven (explicit seam, prod
  default unchanged: Resend when `RESEND_KEY` is set, logging plug
  otherwise). The sandbox context ALWAYS gets the console-logging plug,
  regardless of `RESEND_KEY` — hard-derived, not configurable. A sandbox
  that emails is a defect, not a setting.
- End-to-end check with the cookie seam from ticket 01: a sandbox login
  sets `sandbox_session`, prod stays logged in (and vice versa); the
  sandbox admin cookie is `sandbox_admin_session`.
- The trainee path works: sandbox admin panel creates a user in the SANDBOX
  users table, mints a link, the link redeems into a sandbox session. The
  users table diverges freely from prod; the next reset re-copies prod's.

## Acceptance

- With `RESEND_KEY` set in `.env`, a sandbox link request still logs to the
  console and sends nothing (test asserts the logging plug captured it and
  no send was attempted).
- A sandbox login link opened in a browser lands on the sandbox redeem page
  (basename from ticket 02) and yields a sandbox session.
- Prod login flow unchanged: links unprefixed, cookie `session`, Resend
  still used when configured (existing tests keep passing untouched).

## Standing docs

`README.md` login/email section: one sentence that the sandbox never sends
email and prints links in the console.

## Comments

### 2026-10-06 — implemented

- **Email plug is now part of the app context** (`server/domain.ts`):
  `AppContext.emailPlug` — picked once by the composition root, never inside
  a domain. `createProdEmailPlug()` (`email-plug.ts`) is the production
  selection, moved verbatim out of the auth domain's `register`: Resend when
  `RESEND_KEY` is set (logging the same `[auth] email plug:` line as before),
  console logging otherwise; a failing send still throws loudly. The sandbox
  context ALWAYS gets `createLoggingEmailPlug()` — hard-derived, not
  configurable (spec decision 7). `createApp` wiring updated in
  `server/index.ts` and in the harness (harness prod context selects exactly
  as production does, so the existing Resend-selection tests keep working
  untouched); the auth domain now only installs `ctx.emailPlug` into
  `app.locals` (the `getEmailPlug` test/dev retrieval seam) and
  `handleRequestLink` sends through `ctx.emailPlug`.
- **One shared login-link builder** (`buildLoginLinkUrl` in
  `auth/index.ts`): both build sites go through it — the public
  `request-link` flow and the admin panel's mint route — so the rule exists
  exactly once: request Origin wins, `APP_ORIGIN` is the fallback, and the
  context's `mountPrefix` is part of the path (sandbox links are
  `${origin}/sandbox/redeem?token=...`, prod's stay unprefixed). The admin
  route's explicit body `origin` is the override parameter; the mint route
  now reads the plug from `ctx.emailPlug` (it always exists — `delivered` is
  constant true; response shape unchanged).
- **Tests** (`server/tests/sandbox-auth.test.ts`, 6 tests): sandbox links
  carry the prefix and prod's stay unprefixed (pinned `APP_ORIGIN`, anchored
  regexes); sandbox links follow a LAN request's Origin, prefixed; with
  `RESEND_KEY` set the prod request fires Resend exactly once and the sandbox
  request adds ZERO fetch calls — the sandbox console plug captured the link
  and the token lives in the sandbox DB; a prod session authorizes only prod
  and a sandbox session only the sandbox (401 both ways); ONE cookie jar
  holds both logins simultaneously (`session=` then `sandbox_session=`, both
  `/me` routes answer 200); the trainee path — sandbox admin session under
  `sandbox_admin_session`, user created in the SANDBOX users table only,
  minted link prefixed and captured by the sandbox plug, redeeming into a
  `sandbox_session` that reads back as the trainee. Full suite 577/577
  across 32 files; both typechecks clean; existing prod auth/admin tests
  untouched and passing (unprefixed links, Resend still used when
  configured).
- **Standing docs updated in the same change**: `README.md` (Logging in:
  one sentence — the sandbox never sends email, its links always print in
  the console and carry the `/sandbox` prefix), `docs/logic-map.md` (email
  plug paragraph: context-driven selection, sandbox always logging, the one
  shared link builder).

### 2026-10-06 — decision 7 reversed: sandbox emails through the same selection as prod

User request: "have the sandbox email links through the same resend process
as the real thing; handing off links isn't smart." The spec's decision 7
(console-only email in the sandbox) is reversed — recorded in `spec.md` with
the strikethrough kept visible.

- `createProdEmailPlug()` is now `createEmailPlugFromEnv(label)` — it is no
  longer prod-only, it is THE selection both composition roots call, once
  per context. The `label` ("production"/"sandbox") names the instance in
  the startup line, so the console shows each context's pick explicitly.
  `server/index.ts` and the test harness both wire the sandbox context with
  the same call as prod's. No domain changed: the auth domain still only
  calls `ctx.emailPlug`, so the rule changed in exactly one place.
- Behavior with `RESEND_KEY` set: a sandbox request-link or sandbox-admin
  mint now sends a real email through Resend — the ONLY difference from a
  prod email is the `/sandbox` prefix in the link, so the trainee's inbox
  link opens the sandbox. Without `RESEND_KEY` both instances log to the
  console as before.
- Tests: the old "sandbox adds zero fetch calls" assertion is now the
  opposite pin — with `RESEND_KEY` set, prod's request-link, the sandbox's
  request-link, AND the sandbox admin panel's mint route each fire Resend
  exactly once (three calls, all `api.resend.com/emails`), the sandbox
  emails' links carry `/sandbox/redeem?token=`, the prod link stays
  unprefixed, and the minted token lives in the SANDBOX login_tokens table.
  Without the key, the sandbox plug is still the logging plug, so the
  harness's `loginAsOnSandbox` outbox and the trainee-path test are
  unchanged. Full suite and both typechecks green.
- Review pass fixed three findings: the auth domain's inline comment still
  described the reversed rule (updated); the harness's new comments claimed
  a "default" nothing enforces (rewritten honestly — outbox-reading tests
  require RESEND_KEY unset, the Resend-selection tests pin it deliberately);
  and the mint-path claim above had no pin (the Resend test now exercises
  the mint route too). Rationale prose kept canonical in
  `email-plug.ts`, referenced elsewhere.
- Standing docs updated in the same change: `README.md` (Logging in — the
  sandbox logs in exactly the same way, same email setup, `/sandbox`
  prefix), `docs/logic-map.md` (email plug paragraph — one shared
  `createEmailPlugFromEnv` selection for both instances, reversal dated),
  `docs/manual.md` (sandbox login section — the trainee gets the link the
  same way a main-app user does).
