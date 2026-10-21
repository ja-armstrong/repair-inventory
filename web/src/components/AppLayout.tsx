import { useState, type FormEvent } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { AuditBanner } from "./AuditBanner";

const NAV_ITEMS = [
  { to: "/batches", label: "Batches" },
  { to: "/inventory", label: "Inventory" },
  { to: "/inventory/intake", label: "Intake" },
  { to: "/orders", label: "Orders" },
  { to: "/rma", label: "RMA" },
  { to: "/buyback", label: "Buyback" },
  { to: "/counting", label: "Counting" },
] as const;

export function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  async function onLogout() {
    await logout();
    navigate("/login");
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>RMS</h1>
        <nav className="app-nav">
          {/* The one search box (ticket 11): submits to the grouped results page. */}
          <SearchBox />
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => (isActive ? "nav-link nav-link-active" : "nav-link")}
            >
              {item.label}
            </NavLink>
          ))}
          {user?.role === "manager" && (
            <NavLink
              to="/inventory/price-audit"
              className={({ isActive }) => (isActive ? "nav-link nav-link-active" : "nav-link")}
            >
              Price audit
            </NavLink>
          )}
          {user?.role === "manager" && (
            <NavLink
              to="/reports"
              className={({ isActive }) => (isActive ? "nav-link nav-link-active" : "nav-link")}
            >
              Reports
            </NavLink>
          )}
          {user?.role === "manager" && (
            <NavLink
              to="/users"
              className={({ isActive }) => (isActive ? "nav-link nav-link-active" : "nav-link")}
            >
              Users
            </NavLink>
          )}
          {user ? (
            <span className="nav-user">
              <span className="nav-user-email">{user.email}</span>
              <button type="button" className="nav-logout" onClick={onLogout}>
                Log out
              </button>
            </span>
          ) : (
            <NavLink to="/login" className="nav-link nav-link-login">
              Log in
            </NavLink>
          )}
        </nav>
      </header>
      <main className="app-main">
        <AuditBanner />
        <Outlet />
      </main>
    </div>
  );
}

/**
 * The scan-first search box in the navigation: scanners type into a focused
 * input, so it lives in the header on every page. Submitting lands on the
 * grouped results page; if the text is an exact part serial, the server's
 * `directHit` takes the user the rest of the way to the part.
 */
function SearchBox() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = q.trim();
    if (query === "") {
      return;
    }
    navigate(`/search?q=${encodeURIComponent(query)}`);
  }

  return (
    <form className="nav-search" role="search" onSubmit={submit}>
      <input
        value={q}
        onChange={(event) => setQ(event.target.value)}
        placeholder="Search — SKU, serial, IMEI, #batch"
        aria-label="Search"
      />
      <button type="submit">Search</button>
    </form>
  );
}
