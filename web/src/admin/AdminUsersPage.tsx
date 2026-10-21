import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError } from "../api";
import { adminApi, adminJson, type AdminUser } from "./api";
import { allowedEmailDomains } from "../emailDomains";

/**
 * The admin panel's user & role management: the owner's surface for the
 * user base itself — create users, change roles (tech / manager / admin),
 * deactivate and reactivate, and mint login links. There is no bootstrap
 * manager anymore: THIS page is how a fresh or wiped database gets its
 * first user, and how anyone gets back in when email delivery is not
 * configured. Every write goes through the auth domain's shared cores, so
 * the rules (allowlisted emails, the last-active-manager guard, the
 * timeline events) are exactly the manager API's rules.
 */

const ROLES = ["tech", "manager", "admin"] as const;

export function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<"tech" | "manager" | "admin">("tech");
  const [loginLink, setLoginLink] = useState<{ email: string; url: string } | null>(null);

  const reload = useCallback(async () => {
    try {
      const body = await adminApi<{ users: AdminUser[] }>("/api/admin/users");
      setUsers(body.users);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not load users");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function act(action: () => Promise<unknown>, done: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = (await action()) as { users?: AdminUser[] };
      if (body.users) {
        setUsers(body.users);
      } else {
        await reload();
      }
      setNotice(done);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await act(
      () => adminJson("/api/admin/users", { email: newEmail.trim(), role: newRole }),
      `Created ${newEmail.trim()}. Send them a login link below.`,
    );
    if (ok) {
      setNewEmail("");
    }
  }

  async function onRoleChange(userId: number, email: string, role: string) {
    await act(
      () => adminJson(`/api/admin/users/${userId}/role`, { role }, "PATCH"),
      `${email} is now ${role === "admin" ? "an admin" : `a ${role}`}.`,
    );
  }

  async function onActiveToggle(user: AdminUser) {
    await act(
      () =>
        adminJson(`/api/admin/users/${user.id}/active`, { active: !user.active }, "PATCH"),
      user.active ? `Deactivated ${user.email}.` : `Reactivated ${user.email}.`,
    );
  }

  async function onMintLink(user: AdminUser) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = await adminJson<{ loginUrl: string; note: string }>(
        `/api/admin/users/${user.id}/login-link`,
        {},
      );
      setLoginLink({ email: user.email, url: body.loginUrl });
      setNotice(body.note);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Users & roles</h2>
      <p className="placeholder">
        Roles: <strong>tech</strong> repairs devices; <strong>manager</strong> approves batches and
        orders and manages users; <strong>admin</strong> has every manager power today (separate in
        name, reserved for later). The last active manager or admin can never be demoted or
        deactivated — the system would strand itself.
      </p>
      {notice && <p className="status-ok">{notice}</p>}
      {error && <p className="status-error">{error}</p>}
      {loginLink && (
        <p className="status-ok">
          Login link for {loginLink.email} (expires in 15 minutes):{" "}
          <a href={loginLink.url}>{loginLink.url}</a>
        </p>
      )}

      <form className="form" onSubmit={onCreate}>
        <label>
          New user email
          <input
            value={newEmail}
            onChange={(event) => setNewEmail(event.target.value)}
            placeholder={`name@${allowedEmailDomains[0]}`}
            type="email"
            required
          />
        </label>
        <label>
          Role
          <select value={newRole} onChange={(event) => setNewRole(event.target.value as typeof newRole)}>
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={busy}>
          Create user
        </button>
      </form>

      <table className="table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Email</th>
            <th>Role</th>
            <th>Active</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id}>
              <td>#{user.id}</td>
              <td>{user.email}</td>
              <td>
                <select
                  value={user.role}
                  disabled={busy}
                  onChange={(event) => void onRoleChange(user.id, user.email, event.target.value)}
                >
                  {ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                {user.active ? (
                  <span className="status-ok">active</span>
                ) : (
                  <span className="status-error">deactivated</span>
                )}
              </td>
              <td className="table-actions">
                <button
                  type="button"
                  disabled={busy || !user.active}
                  onClick={() => void onMintLink(user)}
                >
                  Send login link
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onActiveToggle(user)}
                >
                  {user.active ? "Deactivate" : "Reactivate"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
