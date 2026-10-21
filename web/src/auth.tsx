import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Navigate } from "react-router-dom";
import { api } from "./api";

export interface AuthUser {
  id: number;
  email: string;
  role: "admin" | "manager" | "tech";
}

/**
 * Manager powers, the ONE client-side predicate (CONTEXT.md Admin; the same
 * rule the server's `requireManager` enforces): an admin passes everywhere a
 * manager does, so nothing may branch on the literal "manager" role when the
 * question is really "may this user do a manager's job".
 */
export function hasManagerPowers(role: AuthUser["role"]): boolean {
  return role === "manager" || role === "admin";
}

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  /** Re-resolves /api/auth/me — also used after link redemption. */
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setUser(await api<AuthUser>("/api/auth/me"));
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await api<void>("/api/auth/logout", { method: "POST" });
    } catch {
      // a stale session is just as logged-out; the cookie is cleared below
    } finally {
      setUser(null);
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, refresh, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used inside AuthProvider");
  }
  return context;
}

/** Route guard: everything except /login and /redeem requires a session. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return null;
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
