import { poolOptions } from '@repo/db';
import { apiError } from './api-error';

/**
 * ADR 0098: load shedding. Polls and beacons may hold at most 40% of this process's pool at once; past that they
 * answer 503 at once instead of queueing for a connection a person's page needs.
 */
export type Gate = { enter(): (() => void) | null; readonly inFlight: number };

export function concurrencyGate(limit: number): Gate {
  let inFlight = 0;
  return {
    get inFlight() {
      return inFlight;
    },
    enter() {
      if (inFlight >= limit) return null;
      inFlight += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        inFlight -= 1;
      };
    },
  };
}

/** 2 of the default pool of 5; never 0, so a pool of 1 or 2 still serves its polls one at a time. */
export function lowPriorityLimit(env: Record<string, string | undefined> = process.env): number {
  return Math.max(1, Math.floor(poolOptions(env).max * 0.4));
}

const KEY = Symbol.for('@repo/core.low-priority-gate');

/** One per server process: the pool it protects is per process. */
function lowPriorityGate(): Gate {
  const g = globalThis as unknown as Record<symbol, Gate | undefined>;
  return (g[KEY] ??= concurrencyGate(lowPriorityLimit()));
}

/** Runs a low-priority route, or answers 503 Retry-After without touching the database when the gate is full. */
export async function withLowPriority(handler: () => Promise<Response>, gate: Gate = lowPriorityGate()): Promise<Response> {
  const release = gate.enter();
  if (!release) {
    return apiError(503, 'Busy for a moment. Trying again shortly.', { headers: { 'retry-after': '5', 'cache-control': 'no-store' } });
  }
  try {
    return await handler();
  } finally {
    release();
  }
}
