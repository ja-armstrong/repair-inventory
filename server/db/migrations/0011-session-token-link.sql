-- 0011: link each session to the login token that created it, so a re-presented
-- already-used token can be recognized as the same browser's double-submit
-- (React StrictMode remount, double-click, network retry) and answered with
-- success instead of a dead-end error page. Portable SQL only, per ADR-0001.
ALTER TABLE sessions ADD COLUMN created_by_token TEXT;
