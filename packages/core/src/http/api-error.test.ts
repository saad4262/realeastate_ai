import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { apiError, apiErrorMessage } from './api-error';

describe('apiError (PLATFORM-PLAN 1.16)', () => {
  it('answers { error: { code, message } } with the status, the code from it, and the headers given', async () => {
    const r = apiError(404, 'That document was not found.', { headers: { 'cache-control': 'no-store' } });
    expect(r.status).toBe(404);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toEqual({ error: { code: 'not_found', message: 'That document was not found.' } });
    expect((await apiError(429, 'Slow down').json()).error.code).toBe('rate_limited');
    expect((await apiError(418, 'x').json()).error.code).toBe('bad_request');
    expect((await apiError(504, 'x').json()).error.code).toBe('server_error');
    expect((await apiError(403, 'x', { code: 'unavailable' }).json()).error.code).toBe('unavailable');
  });
  it('apiErrorMessage reads the new shape, the old string, and falls back', () => {
    expect(apiErrorMessage({ error: { code: 'forbidden', message: 'No.' } }, 'fb')).toBe('No.');
    expect(apiErrorMessage({ error: 'Old.' }, 'fb')).toBe('Old.');
    for (const b of [null, undefined, {}, { error: {} }, { error: '' }, 'text']) expect(apiErrorMessage(b, 'fb')).toBe('fb');
  });
});

describe('every API route answers errors in the one shape', () => {
  const repo = resolve(__dirname, '../../../..');
  const routes = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      if (n === 'node_modules' || n.startsWith('.next')) return [];
      return statSync(p).isDirectory() ? routes(p) : n === 'route.ts' ? [p] : [];
    });
  it('no route builds a `{ error: <string> }` JSON body by hand (use apiError)', () => {
    const offenders = ['web', 'console'].flatMap((app) =>
      routes(join(repo, 'apps', app, 'app')).flatMap((f) =>
        readFileSync(f, 'utf8')
          .split('\n')
          .map((l, i) => (/\.json\(\s*\{\s*error\s*(:\s*[^{\s]|[,}])/.test(l) ? `${relative(repo, f)}:${i + 1}` : null))
          .filter((x): x is string => x !== null),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
