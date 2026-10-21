import { AuditsPage } from "./AuditsPage";
import { CycleCountPage } from "./CycleCountPage";

/**
 * The counting page (ticket 26): the audit window and cycle counting under
 * one nav tab. Both halves keep their own headings and behavior — this is a
 * navigation merge, not a feature change; the old /audits and /cycle-count
 * routes redirect here.
 */
export function CountingPage() {
  return (
    <>
      <AuditsPage />
      <CycleCountPage />
    </>
  );
}
