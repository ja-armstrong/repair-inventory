import { useEffect } from "react";
import { isSandbox } from "../sandbox";

/**
 * The sandbox guardrail (sandbox spec decision 10): a fixed bar on EVERY
 * page — login and redeem included — so a trainee can never mistake the two
 * environments. Rendered at the app root, outside route content, so no page
 * can opt out; it exists only when the app was loaded under /sandbox.
 */
export function SandboxBanner() {
  useEffect(() => {
    if (!isSandbox) {
      return;
    }
    // The fixed bar overlays the page's own header; the body padding keeps
    // every page's content below it. Mirror-image cleanup for HMR.
    document.body.classList.add("sandbox");
    return () => document.body.classList.remove("sandbox");
  }, []);
  if (!isSandbox) {
    return null;
  }
  return (
    <div className="sandbox-banner">
      SANDBOX — training environment, not production data
    </div>
  );
}
