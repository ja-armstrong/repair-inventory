/**
 * Tests for the default-source-link client logic (ticket 11, spec decision
 * 10). The strictness contract of `urlHref`: an explicit scheme only for
 * http/https; scheme-less values only when unambiguously URL-shaped; a
 * non-URL NEVER renders as a link. `prefillLineSource` pins the prefill
 * order: the SKU's default link first, the demand record's supplier as the
 * fallback, blank last.
 */
import { describe, expect, it } from "vitest";
import { prefillLineSource, urlHref } from "./sourceLink";

describe("urlHref — strict URL detection", () => {
  it("accepts explicit http/https URLs", () => {
    expect(urlHref("https://source.com/part")).toBe("https://source.com/part");
    expect(urlHref("http://source.com")).toBe("http://source.com");
    expect(urlHref("  https://source.com/part?p=1  ")).toBe("https://source.com/part?p=1");
  });

  it("accepts the ticket's scheme-less example and supplies https://", () => {
    expect(urlHref("source.com/part")).toBe("https://source.com/part");
    expect(urlHref("source.com")).toBe("https://source.com");
    expect(urlHref("example.co.uk/part?v=2#top")).toBe("https://example.co.uk/part?v=2#top");
    expect(urlHref("SOURCE.COM/PART")).toBe("https://SOURCE.COM/PART");
  });

  it("never links a non-http scheme — it stays plain text", () => {
    expect(urlHref("javascript:alert(1)")).toBeNull();
    expect(urlHref("mailto:person@example.com")).toBeNull();
    expect(urlHref("file:///C:/notes.txt")).toBeNull();
    expect(urlHref("data:text/html,hi")).toBeNull();
  });

  it("never links prose or notes, dotted or not", () => {
    expect(urlHref("MobileSentrix")).toBeNull();
    expect(urlHref("see source.com list")).toBeNull();
    expect(urlHref("iPhone 13 screen, grade B")).toBeNull();
    expect(urlHref("note: ask Bob about pricing")).toBeNull();
    expect(urlHref("part #4 replacement")).toBeNull();
  });

  it("never links a bare number that merely contains a dot", () => {
    // "contains a dot" is explicitly NOT the rule (ticket 11).
    expect(urlHref("3.5")).toBeNull();
    expect(urlHref("12.34")).toBeNull();
    expect(urlHref("1.2.3")).toBeNull();
  });

  it("rejects scheme-less values that are not unambiguous hosts", () => {
    expect(urlHref("localhost:3000/parts")).toBeNull();
    expect(urlHref("source.com.")).toBeNull();
    expect(urlHref("/relative/path")).toBeNull();
    expect(urlHref("192.168.0.1")).toBeNull();
  });

  it("treats blank as no link", () => {
    expect(urlHref("")).toBeNull();
    expect(urlHref("   ")).toBeNull();
  });
});

describe("prefillLineSource — the PO line's source prefill order", () => {
  it("prefers the SKU's default link over the demand record's supplier", () => {
    expect(
      prefillLineSource({ skuDefaultSourceUrl: "source.com/part", demandSupplier: "other.com/x" })
    ).toBe("source.com/part");
  });

  it("falls back to the demand record's supplier when the SKU has no default", () => {
    expect(prefillLineSource({ skuDefaultSourceUrl: null, demandSupplier: "other.com/x" })).toBe(
      "other.com/x"
    );
    expect(prefillLineSource({ skuDefaultSourceUrl: null, demandSupplier: "MobileSentrix" })).toBe(
      "MobileSentrix"
    );
  });

  it("pre-fills nothing when neither exists", () => {
    expect(prefillLineSource({ skuDefaultSourceUrl: null, demandSupplier: null })).toBe("");
    expect(prefillLineSource({ skuDefaultSourceUrl: undefined, demandSupplier: undefined })).toBe(
      ""
    );
  });
});
