/**
 * Failure-counting throttle for login, invite acceptance, and other
 * password checks. The web layer keys it by normalized email and/or client
 * address; the service consults it before verifying credentials and records
 * failures afterwards.
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
  /**
   * Upper bound on tracked keys. Anonymous callers can mint unlimited distinct
   * keys (emails, addresses), so the map is swept of expired windows and, if
   * still full, the oldest window is evicted before a new key is admitted.
   */
  maxKeys?: number;
}

export const DEFAULT_LOGIN_THROTTLE = {
  maxFailures: 5,
  windowMs: 15 * 60_000,
  maxKeys: 10_000,
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
  const maxKeys = options.maxKeys ?? DEFAULT_LOGIN_THROTTLE.maxKeys;
  if (!Number.isInteger(maxKeys) || maxKeys < 1) {
    throw new RangeError("maxKeys must be a positive integer");
  }
  // Insertion order doubles as eviction order: a key is re-inserted when its window restarts.
  const state = new Map<string, WindowState>();

  const isExpired = (entry: WindowState, now: Date): boolean =>
    now.getTime() - entry.windowStart >= options.windowMs;

  const current = (key: string, now: Date): WindowState | undefined => {
    const entry = state.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (isExpired(entry, now)) {
      state.delete(key);
      return undefined;
    }
    return entry;
  };

  const makeRoom = (now: Date): void => {
    if (state.size < maxKeys) {
      return;
    }
    for (const [key, entry] of state) {
      if (isExpired(entry, now)) {
        state.delete(key);
      }
    }
    while (state.size >= maxKeys) {
      const oldest = state.keys().next();
      if (oldest.done) {
        return;
      }
      state.delete(oldest.value);
    }
  };

  return {
    allows(key, now) {
      const entry = current(key, now);
      return entry === undefined || entry.failures < options.maxFailures;
    },
    recordFailure(key, now) {
      const entry = current(key, now);
      if (entry === undefined) {
        makeRoom(now);
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
