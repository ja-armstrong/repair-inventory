-- 0026: audits.close_kind (ticket 02, automatic window lifecycle; spec
-- decision 7 of .scratch/audit-window-lifecycle, ADR-0002).
--
-- The close kind is COMPUTED, never declared: nothing due-and-non-exempt
-- left unaccounted-for → 'complete', anything left → 'shortfall'. It holds
-- for manager closes and the new boundary auto-closes alike, so a "clean"
-- close with remaining due parts is unrecordable. The column is stamped at
-- close by the one close core (audits lifecycle) and stays NULL while the
-- window is open; SQLite cannot ADD a CHECK via ALTER, so the
-- complete/shortfall vocabulary is domain-guaranteed (the same pattern as
-- migration 0021).
--
-- Backfill: every already-closed audit gets its kind computed from its own
-- outcome buckets — a 'failed' outcome is a due part that did not survive
-- the audit, so any failed row means shortfall. Open windows keep NULL
-- until they close.

ALTER TABLE audits ADD COLUMN close_kind TEXT;

UPDATE audits
   SET close_kind = CASE
         WHEN EXISTS (
           SELECT 1 FROM audit_parts ap
            WHERE ap.audit_id = audits.id AND ap.outcome = 'failed'
         ) THEN 'shortfall'
         ELSE 'complete'
       END
 WHERE closed_at IS NOT NULL;
