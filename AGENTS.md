# AGENTS.md

## Agent skills

### Issue tracker

Issues live as markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.

## Documentation

Every implementing agent writes, as part of its ticket:

- Inline comments on domain rules (status graphs, due-ness, invariants): the WHY, one line each.
- Accurate `## Comments` in its ticket file.

Standing documents — the agent whose change invalidates a line updates that line in the same commit:

- `README.md` — install, run, test, back up; written for a non-developer maintainer.
- `docs/logic-map.md` — each domain's routes, state machines, and cross-domain reads/writes.
- `docs/data-model.md` — every table, column, relationship, and invariant.
- `docs/manual.md` — Simple-English manual: program flow top to bottom, literal statements only, no analogies.

## Review standard

Code enforces the domain rule exactly: a single source of truth per rule, loud failure on inconsistency, and every seam an explicit contract (a plug with one implementation still fully isolates the concern). Silent fallbacks, existence-guessing, stubs, and TODOs are defects to fix, not flexibility.
