import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth";
import { apiJson, ApiError } from "../api";
import { allowedEmailDomains } from "../emailDomains";

/**
 * Passwordless login: request a magic link by email. The link arrives by
 * email (in this prototype it is also logged to the API server console) and
 * is redeemed on /redeem.
 */
export function LoginPage() {
  const { user } = useAuth();
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onRequestLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setSentTo(null);
    try {
      await apiJson("/api/auth/request-link", { email });
      setSentTo(email);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not request a login link");
    } finally {
      setSubmitting(false);
    }
  }

  if (user) {
    return (
      <section>
        <h2>Log in</h2>
        <p className="status-ok">
          You are already logged in as {user.email}.{" "}
          <Link to="/">Continue to the app</Link>
        </p>
      </section>
    );
  }

  return (
    <section className="login-page">
      <h2>Log in</h2>
      <p className="placeholder">
        Enter your email address and RMS will send
        you a login link. It expires after 15 minutes.
      </p>
      {sentTo && (
        <p className="status-ok">
          A login link for {sentTo} is on its way.
        </p>
      )}
      {error && <p className="status-error">{error}</p>}
      <form className="form" onSubmit={onRequestLink}>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder={`you@${allowedEmailDomains[0]}`}
            required
          />
        </label>
        <button type="submit" disabled={submitting}>
          Send login link
        </button>
      </form>
    </section>
  );
}
