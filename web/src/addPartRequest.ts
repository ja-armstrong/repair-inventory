/**
 * The add-part form's routing decision, as a pure function (the bug-fix seam
 * for the scan path): ONE form feeds two endpoints, routed by what the form
 * holds. A filled serial is a complete request on its own — the server
 * resolves the unit and its SKU from the serial (batchparts contract: SKU and
 * scanned serial are mutually exclusive, either alone works) — so a scan
 * without a SKU pick must route to the parts endpoint, never stall silently.
 * A picked consumable SKU routes to usage recording. Nothing routable is an
 * error the caller shows loudly: a silent no-op submit is a defect.
 */

export interface AddPartFormValues {
  skuId: string;
  serial: string;
  supplier: string;
  note: string;
  price: string;
  quantity: string;
}

export interface PickedSku {
  id: number;
  kind: string;
}

export type AddPartRequest =
  | {
      endpoint: "consumables";
      body: { skuId: number; quantity: number; note?: string };
    }
  | {
      endpoint: "parts";
      body: {
        skuId?: number;
        serial?: string;
        supplier?: string;
        note?: string;
        price?: string;
      };
    };

export function addPartRequest(
  form: AddPartFormValues,
  pickedSku: PickedSku | null,
): AddPartRequest | { error: string } {
  const note = form.note === "" ? undefined : form.note;
  // A consumable pick records usage — quantity × unit price, no units to
  // reserve (the serial field isn't even rendered for consumables).
  if (pickedSku?.kind === "consumable") {
    return {
      endpoint: "consumables",
      body: { skuId: pickedSku.id, quantity: Number(form.quantity), note },
    };
  }
  // The scan path: a filled serial replaces the SKU pick entirely. The price
  // field still applies — it is the scanned unit's own price override.
  const serial = form.serial.trim();
  if (serial !== "") {
    return {
      endpoint: "parts",
      body: {
        serial,
        supplier: form.supplier === "" ? undefined : form.supplier,
        note,
        price: form.price === "" ? undefined : form.price,
      },
    };
  }
  // The SKU pick path: reserve the oldest Available unit (or file a demand).
  if (form.skuId !== "") {
    return {
      endpoint: "parts",
      body: {
        skuId: Number(form.skuId),
        supplier: form.supplier === "" ? undefined : form.supplier,
        note,
        price: form.price === "" ? undefined : form.price,
      },
    };
  }
  return { error: "pick a SKU or scan a serial first" };
}
