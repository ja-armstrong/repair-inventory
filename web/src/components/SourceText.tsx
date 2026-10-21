import type { ReactNode } from "react";
import { urlHref } from "../sourceLink";

/**
 * A stored free-text source/supplier at the API edge of the screen (ticket
 * 11): renders as a clickable link exactly when the shared detector
 * (sourceLink.ts urlHref — the ONE decision point) says the value parses as
 * a web URL, and as plain text otherwise — free text remains fully valid.
 * The displayed text is the stored value verbatim, never the normalized
 * href.
 */
export function SourceText({ text, blank = "—" }: { text: string | null; blank?: ReactNode }) {
  if (text === null) {
    return <>{blank}</>;
  }
  const href = urlHref(text);
  return href ? (
    <a href={href} target="_blank" rel="noreferrer">
      {text}
    </a>
  ) : (
    <>{text}</>
  );
}
