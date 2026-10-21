import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth, type AuthUser } from "../auth";
import { apiJson, ApiError } from "../api";

/**
 * Link redemption: the /redeem?token=... page an emailed login link points
 * at. Redeems the token (establishing the session cookie), then redirects
 * to the main page.
 *
 * The redeem fires exactly once per token: React StrictMode runs this effect
 * mount → cleanup → mount in dev, and a second POST would hit the server's
 * single-use guard. A ref survives that remount; state updates after unmount
 * are safe no-ops, so the request result is kept without the old
 * cancelled-on-cleanup pattern (which discarded the surviving call's result).
 */
export function RedeemPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [state, setState] = useState<"redeeming" | "ok" | "error">("redeeming");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) {
      return;
    }
    started.current = true;
    async function redeem() {
      try {
        const redeemed = await apiJson<AuthUser>("/api/auth/redeem", { token });
        setUser(redeemed);
        setState("ok");
        await refresh();
        navigate("/", { replace: true });
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "could not redeem the login link");
        setState("error");
      }
    }
    void redeem();
  }, [token, refresh, navigate]);

  if (!token) {
    return (
      <section>
        <h2>Log in</h2>
        <p className="status-error">This link has no login token in it.</p>
        <p>
          <Link to="/login">Request a login link</Link>
        </p>
      </section>
    );
  }

  return (
    <section>
      <h2>Logging you in…</h2>
      {state === "redeeming" && <p className="placeholder">Redeeming your login link…</p>}
      {state === "ok" && user && (
        <p className="status-ok">
          You are logged in as {user.email}. <Link to="/">Continue</Link>
        </p>
      )}
      {state === "error" && (
        <p className="status-error">
          {error} <Link to="/login">Request a new link</Link>
        </p>
      )}
    </section>
  );
}
