import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../auth";
import { api, apiJson, ApiError } from "../api";
import { allowedEmailDomains, allowedEmailLabel } from "../emailDomains";

interface ManagedUser {
  id: number;
  email: string;
  role: "manager" | "tech";
  active: boolean;
  createdAt: string;
}

/**
 * User management (manager-only): create allowlisted users, change roles
 * between manager and tech, deactivate users. Techs never see this route in
 * the nav; arriving here directly shows the refusal.
 */
export function UsersPage() {
  const { user } = useAuth();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<"manager" | "tech">("tech");

  const reload = useCallback(async () => {
    try {
      setUsers(await api<ManagedUser[]>("/api/users"));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not load users");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function run(action: () => Promise<unknown>, done: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(done);
      await reload();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "the request failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function onCreateUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const created = await run(
      () => apiJson("/api/users", { email: newEmail, role: newRole }),
      `Created ${newEmail}.`,
    );
    if (created) {
      setNewEmail("");
    }
  }

  if (user && user.role !== "manager") {
    return (
      <section>
        <h2>Users</h2>
        <p className="status-error">User management is manager-only.</p>
      </section>
    );
  }

  return (
    <section>
      <h2>Users</h2>
      {notice && <p className="status-ok">{notice}</p>}
      {error && <p className="status-error">{error}</p>}

      <form className="form" onSubmit={onCreateUser}>
        <label>
          Email ({allowedEmailLabel()})
          <input
            type="email"
            value={newEmail}
            onChange={(event) => setNewEmail(event.target.value)}
            placeholder={`new.tech@${allowedEmailDomains[0]}`}
            required
          />
        </label>
        <label>
          Role
          <select
            value={newRole}
            onChange={(event) => setNewRole(event.target.value as "manager" | "tech")}
          >
            <option value="tech">Tech</option>
            <option value="manager">Manager</option>
          </select>
        </label>
        <button type="submit" disabled={busy}>
          Add user
        </button>
      </form>

      <table className="table">
        <thead>
          <tr>
            <th>Email</th>
            <th>Role</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((managed) => (
            <tr key={managed.id}>
              <td>{managed.email}</td>
              <td>{managed.role}</td>
              <td>{managed.active ? "Active" : "Deactivated"}</td>
              <td className="table-actions">
                {managed.active && (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            apiJson(
                              `/api/users/${managed.id}/role`,
                              { role: managed.role === "tech" ? "manager" : "tech" },
                              "PATCH",
                            ),
                          `${managed.email} is now ${managed.role === "tech" ? "a manager" : "a tech"}.`,
                        )
                      }
                    >
                      {managed.role === "tech" ? "Make manager" : "Make tech"}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => apiJson(`/api/users/${managed.id}/deactivate`, {}),
                          `${managed.email} was deactivated.`,
                        )
                      }
                    >
                      Deactivate
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
