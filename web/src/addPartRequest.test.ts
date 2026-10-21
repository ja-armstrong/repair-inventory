import { describe, expect, it } from "vitest";
import { addPartRequest } from "./addPartRequest";

/**
 * The add-part form's routing contract. The regression at the heart of this
 * file: a serial scan with NO SKU pick is a complete request — the old
 * handler required a picked SKU before it would build anything, so scanning
 * a serial and clicking Add part silently did nothing (no request, no
 * error). The scan path routes on the serial alone.
 */

const FORM = {
  skuId: "",
  serial: "",
  supplier: "",
  note: "",
  price: "",
  quantity: "1",
};

const SCREEN = { id: 7, kind: "serialized" };
const ALCOHOL = { id: 9, kind: "consumable" };

describe("addPartRequest", () => {
  it("routes a serial scan with no SKU pick to the parts endpoint — the scan is the whole request", () => {
    const request = addPartRequest({ ...FORM, serial: "P00446", note: "screen swap" }, null);
    expect(request).toEqual({
      endpoint: "parts",
      body: { serial: "P00446", note: "screen swap" },
    });
  });

  it("routes a serial scan even when a SKU is also picked — the serial names the exact unit", () => {
    const request = addPartRequest({ ...FORM, skuId: "7", serial: "P00446" }, SCREEN);
    expect(request).toEqual({ endpoint: "parts", body: { serial: "P00446" } });
  });

  it("routes a SKU pick with no serial to the parts endpoint with that SKU", () => {
    const request = addPartRequest({ ...FORM, skuId: "7", price: "19.99" }, SCREEN);
    expect(request).toEqual({
      endpoint: "parts",
      body: { skuId: 7, price: "19.99" },
    });
  });

  it("carries the supplier link and price override on either serialized path", () => {
    const scanned = addPartRequest(
      { ...FORM, serial: "P00446", supplier: "MobileSentrix", price: "15.00" },
      null,
    );
    expect(scanned).toEqual({
      endpoint: "parts",
      body: { serial: "P00446", supplier: "MobileSentrix", price: "15.00" },
    });
    const picked = addPartRequest(
      { ...FORM, skuId: "7", supplier: "MobileSentrix", price: "15.00" },
      SCREEN,
    );
    expect(picked).toEqual({
      endpoint: "parts",
      body: { skuId: 7, supplier: "MobileSentrix", price: "15.00" },
    });
  });

  it("routes a picked consumable SKU to usage recording, never to reservation", () => {
    const request = addPartRequest({ ...FORM, skuId: "9", quantity: "3", note: "iso wipe" }, ALCOHOL);
    expect(request).toEqual({
      endpoint: "consumables",
      body: { skuId: 9, quantity: 3, note: "iso wipe" },
    });
  });

  it("errors loudly when the form has neither a SKU nor a serial — never a silent no-op", () => {
    const request = addPartRequest(FORM, null);
    expect(request).toEqual({ error: expect.any(String) });
    expect((request as { error: string }).error).not.toBe("");
  });

  it("trims the serial — a whitespace-only scan is not a request", () => {
    const request = addPartRequest({ ...FORM, serial: "   " }, null);
    expect(request).toEqual({ error: expect.any(String) });
  });
});
