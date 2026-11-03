import type { NextRequest } from 'next/server';

/**
 * Per-IP and per-day ceilings for a public route in front of a metered model. As /api/chat says of its own copy:
 * an in-process counter is a ceiling on ACCIDENTAL cost, not a security control — a determined caller rotates
 * IPs, and behind several instances the real ceiling is this times the instance count. The spend cap in the
 * Anthropic console is the backstop. Each route gets its own buckets by name.
 */
type Bucket = { count: number; resetAt: number };

export function rateLimiter(name: string, opts: { perMinute: number; dailyCapEnv: string; dailyCapDefault: number }) {
  const BUCKETS = Symbol.for(`@repo/web.${name}-rate-limit`);
  const DAILY = Symbol.for(`@repo/web.${name}-daily-cap`);
  const g = globalThis as unknown as Record<symbol, unknown>;

  return {
    overLimit(request: NextRequest): boolean {
      const map = ((g[BUCKETS] as Map<string, Bucket> | undefined) ??= new Map()) as Map<string, Bucket>;
      g[BUCKETS] = map;
      const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown';
      const now = Date.now();
      const current = map.get(ip);
      if (!current || current.resetAt < now) {
        map.set(ip, { count: 1, resetAt: now + 60_000 });
        if (map.size > 5000) for (const [key, b] of map) if (b.resetAt < now) map.delete(key);
        return false;
      }
      current.count += 1;
      return current.count > opts.perMinute;
    },
    overDailyCap(): boolean {
      const cap = Number(process.env[opts.dailyCapEnv] ?? opts.dailyCapDefault);
      const now = Date.now();
      const current = g[DAILY] as Bucket | undefined;
      if (!current || current.resetAt < now) {
        g[DAILY] = { count: 1, resetAt: now + 86_400_000 };
        return false;
      }
      current.count += 1;
      return current.count > cap;
    },
  };
}
