/**
 * Decimal-safe money for the parts catalog. The database stores integer
 * cents; dollars exist only at the edges — parsing request input and
 * formatting API output — so no floating-point drift ever reaches storage.
 */
export function parsePriceToCents(input: string | number): number | null {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) {
      return null;
    }
    const raw = input * 100;
    const cents = Math.round(raw);
    // anything further than rounding noise from a whole-cent value has more
    // than two decimal places (e.g. 12.345) and is refused, not rounded
    if (Math.abs(raw - cents) > 1e-6) {
      return null;
    }
    return cents;
  }
  const text = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    return null;
  }
  const separator = text.indexOf(".");
  if (separator === -1) {
    return Number(text) * 100;
  }
  const whole = Number(text.slice(0, separator));
  const fraction = text.slice(separator + 1).padEnd(2, "0");
  return whole * 100 + Number(fraction);
}

/** Formats integer cents as a dollar string, e.g. 10999 -> "109.99". */
export function formatCents(cents: number): string {
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  return `${whole}.${String(rest).padStart(2, "0")}`;
}
