type FixedWindowLimit = {
  maxRequests: number;
  windowMs: number;
};

type Entry = {
  windowStart: number;
  count: number;
};

const START_LIMIT: FixedWindowLimit = {
  maxRequests: 5,
  windowMs: 10 * 60 * 1000,
};

const STATUS_LIMIT: FixedWindowLimit = {
  maxRequests: 60,
  windowMs: 60 * 1000,
};

const startStore = new Map<string, Entry>();
const statusStore = new Map<string, Entry>();

function take(store: Map<string, Entry>, key: string, limit: FixedWindowLimit):
  | { ok: true; remaining: number }
  | { ok: false; retryAfterSeconds: number } {
  const now = Date.now();
  const current = store.get(key);

  if (!current || now - current.windowStart >= limit.windowMs) {
    store.set(key, {
      windowStart: now,
      count: 1,
    });

    return {
      ok: true,
      remaining: limit.maxRequests - 1,
    };
  }

  if (current.count >= limit.maxRequests) {
    const retryAfterMs = Math.max(limit.windowMs - (now - current.windowStart), 0);
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
    };
  }

  current.count += 1;
  store.set(key, current);

  return {
    ok: true,
    remaining: limit.maxRequests - current.count,
  };
}

export function takeStartRateLimit(ip: string):
  | { ok: true; remaining: number }
  | { ok: false; retryAfterSeconds: number } {
  return take(startStore, ip, START_LIMIT);
}

export function takeStatusRateLimit(ip: string):
  | { ok: true; remaining: number }
  | { ok: false; retryAfterSeconds: number } {
  return take(statusStore, ip, STATUS_LIMIT);
}

export function resetRateLimitersForTests(): void {
  startStore.clear();
  statusStore.clear();
}
