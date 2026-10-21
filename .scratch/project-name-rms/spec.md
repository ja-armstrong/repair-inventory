# Spec: The project is called RMS

The app's name is **RMS**. All user-facing branding — window title, app and
admin headers, README/CONTEXT/manual titles — says RMS.

## Requirement

- Web: `<title>RMS</title>`, the app header (`AppLayout`), the admin header
  (`RMS — Admin`).
- Docs: README, CONTEXT.md, and the manual titled RMS.
- `package.json` name: `rms`.

## Deliberately unchanged (data continuity, not branding)

- `DB_PATH` default `data/repair-inventory.sqlite` — existing installs' data
  lives there; changing the default would orphan it.
- Backup filenames `repair-inventory-YYYYMMDD-HHMMSS.sqlite` — existing
  backups keep their names; the restore validator checks content, not names.
- The test harness temp-dir prefix — invisible to users.
