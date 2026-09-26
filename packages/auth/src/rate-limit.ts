/**
 * Failure-counting throttle for login and invite acceptance. The web layer
 * keys it by normalized email and/or client address; the service consults it
 * before verifying credentials and records failures afterwards.
 */
export interface AttemptThrottle {
  /** True when the key may attempt right now. */
  allows(key: string, now: Date): boolean;
  recordFailure(key: string, now: Date): void;
  reset(key: string): void;
}

export interface FixedWindowThrottleOptions {
  /** Failures allowed per window before the key is locked out. */
  maxFailures: number;
  windowMs: number;
}

export const DEFAULT_LOGIN_THROTTLE = {
  maxFailures: 5,
  windowMs: 15 * 60_000,
} as const satisfies FixedWindowThrottleOptions;

interface WindowState {
  windowStart: number;
  failures: number;
}

/** In-memory fixed window; one instance per process. Hosted mode can swap in a shared store. */
export function createFixedWindowThrottle(
  options: FixedWindowThrottleOptions = DEFAULT_LOGIN_THROTTLE,
): AttemptThrottle {
  if (!Number.isInteger(options.maxFailures) || options.maxFailures < 1) {
    throw new RangeError("maxFailures must be a positive integer");
  }
  if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
    throw new RangeError("windowMs must be positive");
  }
  const state = new Map<string, WindowState>();

  const current = (key: string, now: Date): WindowState | undefined => {
    const entry = state.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (now.getTime() - entry.windowStart >= options.windowMs) {
      state.delete(key);
      return undefined;
    }
    return entry;
  };

  return {
    allows(key, now) {
      const entry = current(key, now);
      return entry === undefined || entry.failures < options.maxFailures;
    },
    recordFailure(key, now) {
      const entry = current(key, now);
      if (entry === undefined) {
        state.set(key, { windowStart: now.getTime(), failures: 1 });
      } else {
        entry.failures += 1;
      }
    },
    reset(key) {
      state.delete(key);
    },
  };
}

/** Throttle that never blocks; for tests and trusted local single-user mode. */
export const NO_THROTTLE: AttemptThrottle = {
  allows: () => true,
  recordFailure: () => undefined,
  reset: () => undefined,
};
