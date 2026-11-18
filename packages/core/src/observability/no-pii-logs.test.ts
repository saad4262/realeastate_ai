import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * PLATFORM-PLAN 1.7: no personal data in logs. Logs leave the database's protections (Vercel, Sentry, a
 * screenshot in a chat), so a log line names ids and reasons, never a person's address or number, and never a
 * whole error object (a vendor's error can carry the request it failed on). Operator CLIs are exempt: they
 * print to the person running them.
 */
const repo = resolve(__dirname, '../../../..');
const ROOTS = ['apps/web', 'apps/console', 'packages/core/src', 'packages/ai/src', 'packages/auth/src'];
const EXEMPT = /(-cli\.ts|\/seed\.ts|\/platform-admin\.ts|\.test\.tsx?)$/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === 'node_modules' || name.startsWith('.next')) return [];
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx?$/.test(name) && !EXEMPT.test(p) ? [p] : [];
  });
}

/** A log call's arguments, on one line or spread over the next few. */
function logCalls(src: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const lines = src.split('\n');
  lines.forEach((l, i) => {
    if (/console\.(log|info|warn|error)\(/.test(l)) out.push({ line: i + 1, text: lines.slice(i, i + 4).join(' ') });
  });
  return out;
}

const PERSONAL = /\$\{[^}]*\.(email|phone|e164|mobile|address)\b[^}]*\}|,\s*[a-zA-Z.]*\.(email|phone|e164|mobile)\s*[,)]/;
const WHOLE_ERROR = /,\s*(err|e|error)\s*\)/;

describe('no personal data in logs', () => {
  const calls = ROOTS.flatMap((d) => files(join(repo, d)).flatMap((f) => logCalls(readFileSync(f, 'utf8')).map((c) => ({ ...c, file: relative(repo, f) }))));

  it('finds the log calls it checks (the scan itself works)', () => {
    expect(calls.length).toBeGreaterThan(50);
  });

  it('no log line interpolates an email, phone number or address', () => {
    expect(calls.filter((c) => PERSONAL.test(c.text)).map((c) => `${c.file}:${c.line}`)).toEqual([]);
  });

  it('no log line passes a whole error object (use err.message)', () => {
    expect(calls.filter((c) => WHOLE_ERROR.test(c.text.split(');')[0] + ')')).map((c) => `${c.file}:${c.line}`)).toEqual([]);
  });
});
