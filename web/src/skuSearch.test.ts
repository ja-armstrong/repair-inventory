/**
 * Tests for the SKU fuzzy matcher (ticket 20). The ranking contract:
 * substring > all-words > word-prefix > subsequence; deterministic;
 * ties within a tier break alphabetically by name (then id).
 */
import { describe, expect, it } from "vitest";
import { matchTier, searchSkus, type SkuSearchTier } from "./skuSearch";

const CATALOG = [
  { id: 1, name: "iPhone 13 Screen (Grade B)" },
  { id: 2, name: "iPhone 13 Battery" },
  { id: 3, name: "iPhone 12 Screen" },
  { id: 4, name: "Samsung S23 Screen" },
  { id: 5, name: "Screen Adhesive Tape" },
];

function names(items: { name: string }[]): string[] {
  return items.map((item) => item.name);
}

describe("matchTier", () => {
  it("ranks a case-insensitive contiguous substring highest", () => {
    expect(matchTier("phone 13 sc", "iPhone 13 Screen (Grade B)")).toBe("substring");
    expect(matchTier("IPHONE 13", "iPhone 13 Screen (Grade B)")).toBe("substring");
  });

  it("ranks all-words below substring when every token is a whole word", () => {
    // "iphone" and "screen" are each whole words, but the pair is not
    // contiguous — "13" sits between them.
    expect(matchTier("iphone screen", "iPhone 13 Screen (Grade B)")).toBe("all-words");
    // order-independent: words may appear in any order in the name
    expect(matchTier("screen iphone", "iPhone 13 Screen (Grade B)")).toBe("all-words");
  });

  it("ranks word-prefix below all-words when tokens are partial words", () => {
    // "13" is a whole word but "scre" only prefixes "Screen" → word-prefix
    // ("scre 13" is not contiguous, and "scre" is not a whole word).
    expect(matchTier("scre 13", "iPhone 13 Screen (Grade B)")).toBe("word-prefix");
  });

  it("ranks subsequence last (abbreviations/typos)", () => {
    // the ticket's example: "ip13 scr" finds "iPhone 13 Screen"
    expect(matchTier("ip13 scr", "iPhone 13 Screen (Grade B)")).toBe("subsequence");
    expect(matchTier("ipnscr", "iPhone 13 Screen (Grade B)")).toBe("subsequence");
  });

  it("returns null when nothing matches", () => {
    expect(matchTier("galaxy", "iPhone 13 Screen (Grade B)")).toBeNull();
    expect(matchTier("ip13 zzz", "iPhone 13 Screen (Grade B)")).toBeNull();
  });

  it("ignores punctuation when splitting words, so the (Grade B) suffix matches", () => {
    // "(Grade B)" — parentheses must not stop "grade"/"b" being whole words;
    // "b grade" is non-contiguous, so it lands exactly on all-words
    expect(matchTier("b grade", "iPhone 13 Screen (Grade B)")).toBe("all-words");
    // and the full suffix matches as a contiguous substring
    expect(matchTier("(grade b)", "iPhone 13 Screen (Grade B)")).toBe("substring");
  });

  it("is whitespace-tolerant in the query", () => {
    expect(matchTier("  iPhone   13  ", "iPhone 13 Screen (Grade B)")).toBe("substring");
  });

  it("requires every token to match (no partial all-words)", () => {
    // "battery" is nowhere in the Screen SKU → no tier matches
    expect(matchTier("13 battery", "iPhone 13 Screen (Grade B)")).toBeNull();
  });
});

describe("searchSkus", () => {
  it("orders results by tier: substring > all-words > word-prefix > subsequence", () => {
    // one query ("scr 13"), four names, each matching at a different tier:
    // - "SCR 13 Cover"      → substring ("scr 13" contiguous)
    // - "Glass 13 Scr"      → all-words ("scr" and "13" are whole words)
    // - "Screen 13 …"       → word-prefix ("scr" prefixes "Screen")
    // - "Disc Recorder 13"  → subsequence ("scr13" in order, no token is a
    //                         whole word or word-prefix)
    const catalog = [
      { id: 1, name: "Disc Recorder 13" },
      { id: 2, name: "Screen 13 Protector" },
      { id: 3, name: "Glass 13 Scr" },
      { id: 4, name: "SCR 13 Cover" },
    ];
    expect(names(searchSkus("scr 13", catalog))).toEqual([
      "SCR 13 Cover",
      "Glass 13 Scr",
      "Screen 13 Protector",
      "Disc Recorder 13",
    ]);
  });

  it("breaks ties within a tier alphabetically, case-insensitively", () => {
    const catalog = [
      { id: 1, name: "banana screen" },
      { id: 2, name: "Apple Screen" },
      { id: 3, name: "apple screen pro" },
    ];
    // all three match "screen" as a substring → alphabetical by name
    // ("apple screen" sorts before its own extension "apple screen pro")
    expect(names(searchSkus("screen", catalog))).toEqual([
      "Apple Screen",
      "apple screen pro",
      "banana screen",
    ]);
  });

  it("breaks ties by Unicode code point, not the runtime's locale", () => {
    // Final review F6: the tie-break must not depend on ICU/locale. 'z'
    // (U+007A) sorts before 'é' (U+00E9) by code point, while most locale
    // collations would place "éclair" before "zebra". Both names match "a"
    // as a substring, so the order below is decided purely by the tie-break.
    const catalog = [
      { id: 1, name: "Éclair Display" },
      { id: 2, name: "Zebra Mount" },
    ];
    expect(names(searchSkus("a", catalog))).toEqual(["Zebra Mount", "Éclair Display"]);
  });

  it("breaks alphabetical ties by id for full determinism", () => {
    const catalog = [
      { id: 9, name: "Screen" },
      { id: 2, name: "screen" },
    ];
    expect(searchSkus("screen", catalog).map((item) => item.id)).toEqual([2, 9]);
  });

  it("is deterministic — the same input yields the same order", () => {
    const first = searchSkus("ip13", CATALOG);
    const second = searchSkus("ip13", CATALOG);
    expect(first).toEqual(second);
  });

  it("returns every item for an empty or whitespace-only query, unranked", () => {
    expect(searchSkus("", CATALOG)).toEqual(CATALOG);
    expect(searchSkus("   ", CATALOG)).toEqual(CATALOG);
  });

  it("drops items that do not match at all", () => {
    expect(names(searchSkus("samsung", CATALOG))).toEqual(["Samsung S23 Screen"]);
    expect(names(searchSkus("zzz", CATALOG))).toEqual([]);
  });

  it("finds the ticket's example: 'ip13 scr' finds iPhone 13 Screen (subsequence)", () => {
    const results = searchSkus("ip13 scr", CATALOG);
    expect(results[0]?.name).toBe("iPhone 13 Screen (Grade B)");
  });

  it("prefers the exact SKU when abbreviations could match several", () => {
    // "ip13 bat" — subsequence only matches the Battery SKU
    const results = searchSkus("ip13 bat", CATALOG);
    expect(results.map((item) => item.name)).toEqual(["iPhone 13 Battery"]);
  });

  it("keeps matching through the (Grade B) suffix", () => {
    const results = searchSkus("grade", CATALOG);
    expect(names(results)).toEqual(["iPhone 13 Screen (Grade B)"]);
    // full name — suffix included — is what the caller receives
    expect(results[0]?.name).toContain("(Grade B)");
  });

  it("exposes the matched tier alongside the ranked order", () => {
    const catalog = [
      { id: 1, name: "Disc Recorder 13" },
      { id: 2, name: "Screen 13 Protector" },
      { id: 3, name: "Glass 13 Scr" },
      { id: 4, name: "SCR 13 Cover" },
    ];
    const tiers: SkuSearchTier[] = [];
    searchSkus("scr 13", catalog).forEach((item) => {
      const tier = matchTier("scr 13", item.name);
      if (tier) tiers.push(tier);
    });
    // every returned item reports a tier, and tiers never regress down the list
    expect(tiers).toEqual(["substring", "all-words", "word-prefix", "subsequence"]);
  });
});

/**
 * Ticket 07: the device-model picker reuses this module — the same
 * `searchSkus` ranks the models catalog, and the same `matchTier` decides
 * which SKUs are "suggested for" a chosen model (SkuPicker's `suggestFor`).
 * These tests pin that contract at the ranker level: model names through
 * the same four tiers and tie-breaks, and model→SKU suggestion matching.
 */
describe("ticket 07 — the shared ranker as the model picker uses it", () => {
  const MODELS = [
    { id: 1, name: "iPhone 13" },
    { id: 2, name: "iPhone 13 Pro Max" },
    { id: 3, name: "iPhone 15" },
    { id: 4, name: "Galaxy S23" },
    { id: 5, name: "iPad Air" },
  ];

  it("ranks model names through the same four tiers", () => {
    expect(matchTier("iphone 13", "iPhone 13")).toBe("substring");
    expect(matchTier("13 iphone", "iPhone 13")).toBe("all-words");
    expect(matchTier("ip pro", "iPhone 13 Pro Max")).toBe("word-prefix");
    expect(matchTier("ip13pm", "iPhone 13 Pro Max")).toBe("subsequence");
    expect(matchTier("pixel", "iPhone 13")).toBeNull();
  });

  it("searches the models catalog with identical ordering and tie-breaks", () => {
    // "ip 13" — both iPhones 13 match; "iPhone 13" is the tighter substring
    // (shorter name, same tier) so the codepoint tie-break puts it first.
    expect(searchSkus("ip 13", MODELS).map((model) => model.name)).toEqual([
      "iPhone 13",
      "iPhone 13 Pro Max",
    ]);
    // the abbreviation form finds the Pro Max too, ranked by tier
    expect(searchSkus("ip13 pm", MODELS).map((model) => model.name)).toEqual([
      "iPhone 13 Pro Max",
    ]);
    // empty query returns the catalog unranked, in the given order
    expect(searchSkus("", MODELS)).toEqual(MODELS);
  });

  it("decides model→SKU suggestions with the same matcher", () => {
    // SkuPicker's suggestFor: a SKU is suggested for the model exactly when
    // matchTier(modelName, skuName) matches — "iPhone 13" pulls the 13
    // parts and nothing else.
    const skus = [
      { id: 1, name: "iPhone 13 Screen (Grade B)" },
      { id: 2, name: "iPhone 13 Battery" },
      { id: 3, name: "iPhone 12 Screen" },
      { id: 4, name: "Screen Adhesive Tape" },
    ];
    const suggested = skus.filter((sku) => matchTier("iPhone 13", sku.name) !== null);
    expect(suggested.map((sku) => sku.id)).toEqual([1, 2]);
    // the generic adhesive does not claim the model — but a query that
    // matches it still finds it (suggestions reorder, they never hide)
    expect(matchTier("iPhone 13", "Screen Adhesive Tape")).toBeNull();
    expect(matchTier("adhesive", "Screen Adhesive Tape")).toBe("substring");
  });
});
