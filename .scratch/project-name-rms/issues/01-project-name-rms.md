# 01 — Rename the project RMS (user-facing branding)

Status: ready-for-human
Labels: ready-for-human

Implements `.scratch/project-name-rms/spec.md`.

## Comments

### 2026-10-02 — implemented

- `web/index.html` `<title>RMS</title>`; `AppLayout` header `RMS`;
  `AdminLayout` header `RMS — Admin` (the login page already said RMS).
- `package.json` name → `rms`.
- `README.md` titled RMS with a one-line expansion ("the shop's repair
  management system"); `CONTEXT.md` titled RMS; `docs/manual.md` titled RMS
  and its intro line updated.
- Deliberately NOT renamed (data continuity, not branding — see spec):
  `DB_PATH` default `data/repair-inventory.sqlite`, backup filenames
  `repair-inventory-*.sqlite`, the harness temp-dir prefix. An existing
  install upgrades without its data file or backups moving.
- Verification: full suite 470/470; both typechecks clean. No grep hits for
  "Repair Inventory" remain outside those intentional storage paths.
