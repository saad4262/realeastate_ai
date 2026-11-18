import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * PLATFORM-PLAN 1.15: every server-side call to a vendor has a timeout. A vendor that accepts the connection
 * and never answers otherwise holds the request, the tick or the job until the platform kills it, and with
 * it a database connection. The browser's calls to our own routes are not vendor calls and are not checked.
 * A wrapper that passes `init` through (`(url, init) => fetch(url, init)`) is checked where `init` is built.
 */
const repo = resolve(__dirname, '../../../..');
const ROOTS = ['packages/core/src', 'packages/ai/src', 'packages/auth/src'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === 'node_modules') return [];
    if (statSync(p).isDirectory()) return files(p);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !/-cli\.ts$/.test(name) ? [p] : [];
  });
}

function unbounded(src: string): number[] {
  const lines = src.split('\n');
  const out: number[] = [];
  lines.forEach((l, i) => {
    if (!/(^|[^.\w])fetch\(/.test(l)) return;
    if (/=>\s*fetch\(\s*\w+\s*,\s*\w+\s*\)/.test(l)) return; // a pass-through wrapper
    const call = lines.slice(i, i + 8).join('\n');
    if (!/signal\s*:/.test(call)) out.push(i + 1);
  });
  return out;
}

describe('vendor calls have a timeout', () => {
  it('every server-side fetch( carries a signal', () => {
    const offenders = ROOTS.flatMap((d) => files(join(repo, d)).flatMap((f) => unbounded(readFileSync(f, 'utf8')).map((l) => `${relative(repo, f)}:${l}`)));
    expect(offenders).toEqual([]);
  });
});
