import { describe, expect, it } from "vitest";
import { createFixedWindowThrottle, DEFAULT_LOGIN_THROTTLE, NO_THROTTLE } from "./rate-limit.js";

const T0 = new Date("2026-07-01T09:00:00.000Z");
const MINUTE = 60_000;

function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

describe("createFixedWindowThrottle", () => {
  it("allows up to maxFailures per window, then locks the key out", () => {
    const throttle = createFixedWindowThrottle({ maxFailures: 2, windowMs: 10 * MINUTE });
    expect(throttle.allows("k", T0)).toBe(true);
    throttle.recordFailure("k", T0);
    expect(throttle.allows("k", at(MINUTE))).toBe(true);
    throttle.recordFailure("k", at(MINUTE));
    expect(throttle.allows("k", at(2 * MINUTE))).toBe(false);
    // Other keys are independent.
    expect(throttle.allows("other", at(2 * MINUTE))).toBe(true);
  });

  it("rolls the window over from the first failure, not from the last one", () => {
    const throttle = createFixedWindowThrottle({ maxFailures: 1, windowMs: 10 * MINUTE });
    throttle.recordFailure("k", T0);
    // Further failures inside the window do not extend it.
    throttle.recordFailure("k", at(9 * MINUTE));
    expect(throttle.allows("k", at(10 * MINUTE - 1))).toBe(false);
    expect(throttle.allows("k", at(10 * MINUTE))).toBe(true);
    // A failure after rollover starts a fresh window.
    throttle.recordFailure("k", at(10 * MINUTE));
    expect(throttle.allows("k", at(10 * MINUTE + 1))).toBe(false);
    expect(throttle.allows("k", at(20 * MINUTE))).toBe(true);
  });

  it("reset clears a locked-out key immediately and is a no-op for unknown keys", () => {
    const throttle = createFixedWindowThrottle({ maxFailures: 1, windowMs: 10 * MINUTE });
    throttle.recordFailure("k", T0);
    expect(throttle.allows("k", at(1))).toBe(false);
    throttle.reset("k");
    expect(throttle.allows("k", at(1))).toBe(true);
    expect(() => throttle.reset("never-seen")).not.toThrow();
  });

  it("defaults to five failures per fifteen minutes", () => {
    expect(DEFAULT_LOGIN_THROTTLE).toEqual({ maxFailures: 5, windowMs: 15 * MINUTE });
    const throttle = createFixedWindowThrottle();
    for (let index = 0; index < 5; index += 1) {
      expect(throttle.allows("k", T0)).toBe(true);
      throttle.recordFailure("k", T0);
    }
    expect(throttle.allows("k", T0)).toBe(false);
    expect(throttle.allows("k", at(15 * MINUTE))).toBe(true);
  });

  it("rejects non-positive, fractional, or non-finite options", () => {
    for (const maxFailures of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createFixedWindowThrottle({ maxFailures, windowMs: MINUTE })).toThrow(
        /maxFailures/,
      );
    }
    for (const windowMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createFixedWindowThrottle({ maxFailures: 3, windowMs })).toThrow(/windowMs/);
    }
  });
});

describe("NO_THROTTLE", () => {
  it("never blocks regardless of recorded failures", () => {
    for (let index = 0; index < 100; index += 1) {
      NO_THROTTLE.recordFailure("k", T0);
    }
    expect(NO_THROTTLE.allows("k", T0)).toBe(true);
    expect(() => NO_THROTTLE.reset("k")).not.toThrow();
  });
});
