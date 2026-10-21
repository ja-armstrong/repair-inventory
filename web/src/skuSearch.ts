/**
 * SKU fuzzy matcher (ticket 20) — a pure, deterministic ranking module.
 *
 * The picker feeds every catalog SKU through `searchSkus`; the UI never
 * re-encodes the ranking. RANKING (best tier first):
 *
 *   1. substring   — the whole query (trimmed, lowercased, whitespace
 *                    collapsed to single spaces) appears as one contiguous
 *                    run inside the SKU name. Exact typing wins.
 *   2. all-words   — every whitespace-separated query token equals a whole
 *                    word of the name (words split on non-alphanumerics, so
 *                    "(Grade B)" yields "grade" and "b"). Order-independent.
 *   3. word-prefix — every query token is a prefix of some whole word of the
 *                    name ("13 scre" → "scre" prefixes "Screen").
 *   4. subsequence — the query's characters, spaces ignored, appear in order
 *                    anywhere in the name ("ip13 scr" → "iPhone 13 Screen").
 *
 * A name is classified by the FIRST tier its whole query satisfies — a query
 * that qualifies at multiple tiers counts only at its best one, so the tier
 * order above is also the result order. Within one tier, ties break
 * alphabetically by name (case-insensitive, compared by Unicode code point —
 * never the runtime's locale, so the order is identical on every machine),
 * then by id — the same input always produces the same output. An empty (or
 * whitespace-only) query filters nothing and returns the items in their given
 * order unranked.
 */

export type SkuSearchTier = "substring" | "all-words" | "word-prefix" | "subsequence";

/** Tier rank: lower is better; -1 = no match. */
const TIER_RANK: Record<SkuSearchTier, number> = {
  substring: 0,
  "all-words": 1,
  "word-prefix": 2,
  subsequence: 3,
};

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");
}

function isSubsequence(needle: string, haystack: string): boolean {
  let at = 0;
  for (const char of haystack) {
    if (char === needle[at]) {
      at += 1;
      if (at === needle.length) {
        return true;
      }
    }
  }
  return at === needle.length;
}

/**
 * The best tier at which `query` matches `name`, or null when it does not
 * match at all. Pure and case-insensitive.
 */
export function matchTier(query: string, name: string): SkuSearchTier | null {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === "") {
    return null; // an empty query is "no filter", not a match class
  }
  const lowerName = name.toLowerCase();
  const tokens = trimmed.split(/\s+/).filter((token) => token !== "");
  const nameWords = words(name);
  // internal runs of whitespace collapse, so "iPhone   13" == "iphone 13"
  const normalized = tokens.join(" ");

  if (lowerName.includes(normalized)) {
    return "substring";
  }
  if (tokens.every((token) => nameWords.includes(token))) {
    return "all-words";
  }
  if (tokens.every((token) => nameWords.some((word) => word.startsWith(token)))) {
    return "word-prefix";
  }
  // Spaces in the query are positional noise for the subsequence fallback —
  // "ip13 scr" and "ip13scr" must behave identically.
  const squeezed = tokens.join("");
  if (squeezed !== "" && isSubsequence(squeezed, lowerName)) {
    return "subsequence";
  }
  return null;
}

/**
 * Locale-independent codepoint comparison (final review F6): `localeCompare`
 * follows the runtime's default locale/ICU build, which would make the
 * module's "same input, same output" contract machine-dependent. `<`/`>` on
 * JS strings is specified as UTF-16 code-unit order — deterministic
 * everywhere. Only ever called with toLowerCase()ed strings.
 */
function compareCodePoints(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * Rank `items` against `query`: best tier first, ties alphabetical by name
 * then id. Non-matching items are dropped. With no query, every item is
 * returned in its given order (the server already lists SKUs alphabetically).
 */
export function searchSkus<T extends { id: number; name: string }>(
  query: string,
  items: T[],
): T[] {
  const trimmed = query.trim();
  if (trimmed === "") {
    return items;
  }
  return items
    .map((item) => ({ item, tier: matchTier(trimmed, item.name) }))
    .filter((entry): entry is { item: T; tier: SkuSearchTier } => entry.tier !== null)
    .sort((a, b) => {
      const byTier = TIER_RANK[a.tier] - TIER_RANK[b.tier];
      if (byTier !== 0) {
        return byTier;
      }
      const byName = compareCodePoints(
        a.item.name.toLowerCase(),
        b.item.name.toLowerCase()
      );
      if (byName !== 0) {
        return byName;
      }
      return a.item.id - b.item.id;
    })
    .map((entry) => entry.item);
}
