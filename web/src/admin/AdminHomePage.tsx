import { NavLink } from "react-router-dom";

const SECTIONS = [
  { to: "/admin/users", title: "Users & roles", text: "Create users, set roles (tech / manager / admin), deactivate, and mint login links — this is how a fresh or wiped database gets its first user." },
  { to: "/admin/settings", title: "Settings", text: "Audit interval, price expiry, and label stock — validated server-side, every change lands on the timeline." },
  { to: "/admin/env", title: "Environment", text: "Edit the server's .env keys (secrets stay masked). Changes apply only after a restart — restart from here too." },
  { to: "/admin/backup", title: "Backup", text: "One click: a consistent backup is saved to data/backups and downloaded." },
  { to: "/admin/danger", title: "Danger zone", text: "Clear the database or restore a backup. Every action backs up first, asks for typed confirmation, and is logged." },
  { to: "/admin/sql", title: "SQL console", text: "Read-only SELECTs by default; writes need a typed confirmation and an automatic backup." },
  { to: "/admin/api-console", title: "API console", text: "Run real API calls against this server, as the bootstrap manager — same validation, same timeline." },
  { to: "/admin/system", title: "System info", text: "Row counts per table, applied migrations, uptime, and the database file." },
] as const;

export function AdminHomePage() {
  return (
    <section>
      <h2>Overview</h2>
      <div className="admin-cards">
        {SECTIONS.map((section) => (
          <NavLink key={section.to} to={section.to} className="admin-card">
            <strong>{section.title}</strong>
            <span>{section.text}</span>
          </NavLink>
        ))}
      </div>
    </section>
  );
}
