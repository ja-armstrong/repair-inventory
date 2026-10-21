/**
 * The app clock. Production code reads time through this interface — never
 * `new Date()` / `Date.now()` directly — so tests can inject a `FakeClock`
 * (see `server/tests/harness.ts`) and exercise time-dependent rules
 * (login-link expiry, price expiry, audit due-ness) without sleeping.
 */
export interface Clock {
  now(): Date;
}

export function systemClock(): Clock {
  return {
    now: () => new Date(),
  };
}
