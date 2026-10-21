/**
 * The default-source-link feature's shared client logic (ticket 11, spec
 * decision 10). ONE module owns both decisions — whether a stored free-text
 * source/supplier renders as a clickable link, and what a new PO line
 * pre-fills — so the pages that show or pre-fill sources cannot drift.
 */

/**
 * The href a stored source/supplier renders as, or null when it must stay
 * plain text. STRICT on purpose (spec decision 10): a non-URL must never
 * render as a link.
 *
 * - An explicit scheme is accepted ONLY for http/https: anything else
 *   (javascript:, mailto:, file:, "Note: …") stays text, because the only
 *   thing worth opening from an ordering screen is a web page.
 * - Without a scheme, the value must be UNAMBIGUOUSLY URL-shaped: a dotted
 *   domain-like host containing at least one letter (so "3.5" is not a
 *   link), no whitespace anywhere (so a note like "see source.com list" is
 *   never mangled into a link), and an optional path/query. The ticket's
 *   own example — "source.com/part" — is unambiguous, so it is clickable
 *   with the https:// supplied at render time.
 *
 * Returns null for blank input too; callers render their own placeholder.
 */
export function urlHref(raw: string): string | null {
  const text = raw.trim();
  if (text === "") {
    return null;
  }
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(text);
  if (scheme) {
    const protocol = scheme[1].toLowerCase();
    if (protocol !== "http" && protocol !== "https") {
      return null;
    }
    try {
      new URL(text);
    } catch {
      return null;
    }
    return text;
  }
  if (/\s/.test(text)) {
    return null;
  }
  const host = /^([^/?#]+)([/?#].*)?$/.exec(text)?.[1] ?? "";
  if (!/^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/.test(host)) {
    return null;
  }
  if (!/[a-zA-Z]/.test(host)) {
    return null;
  }
  return `https://${text}`;
}

/**
 * What a new PO line's Source pre-fills: the SKU's default link when the
 * SKU has one, else the demand record's own supplier link (the pre-ticket
 * behavior), else blank. The default is a convenience — the field stays
 * editable either way.
 */
export function prefillLineSource(input: {
  skuDefaultSourceUrl: string | null | undefined;
  demandSupplier: string | null | undefined;
}): string {
  return input.skuDefaultSourceUrl ?? input.demandSupplier ?? "";
}
