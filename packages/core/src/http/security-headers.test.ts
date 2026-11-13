import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { securityHeaders, type SecurityApp } from './security-headers';

const PROD = { NODE_ENV: 'production', NEXT_PUBLIC_SUPABASE_URL: 'https://abcd.supabase.co/' } as NodeJS.ProcessEnv;
const DEV = { NODE_ENV: 'development', NEXT_PUBLIC_SUPABASE_URL: 'https://abcd.supabase.co' } as NodeJS.ProcessEnv;

function header(app: SecurityApp, key: string, env = PROD): string | undefined {
  return securityHeaders(app, env).find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;
}

/** A CSP as { directive: sources }. */
function csp(value: string | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of (value ?? '').split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out[name] = sources;
  }
  return out;
}

describe.each<SecurityApp>(['web', 'console'])('securityHeaders(%s)', (app) => {
  it('refuses to be framed by another site (clickjacking), in both the old header and CSP', () => {
    expect(header(app, 'X-Frame-Options')).toBe('SAMEORIGIN');
    expect(csp(header(app, 'Content-Security-Policy'))['frame-ancestors']).toEqual(["'self'"]);
  });

  it('enforces the directives that cannot break a page', () => {
    const enforced = csp(header(app, 'Content-Security-Policy'));
    expect(enforced['object-src']).toEqual(["'none'"]);
    expect(enforced['base-uri']).toEqual(["'self'"]);
    // Resource directives are report-only until a browser pass has read the violations (see the module).
    for (const d of ['default-src', 'script-src', 'img-src', 'connect-src', 'frame-src', 'style-src']) expect(enforced[d], d).toBeUndefined();
  });

  it('sends nosniff, a referrer policy, HSTS and a permissions policy', () => {
    expect(header(app, 'X-Content-Type-Options')).toBe('nosniff');
    expect(header(app, 'Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(Number(header(app, 'Strict-Transport-Security')?.match(/max-age=(\d+)/)?.[1])).toBeGreaterThanOrEqual(31_536_000);
    const perms = header(app, 'Permissions-Policy') ?? '';
    for (const p of ['camera=()', 'microphone=()', 'geolocation=()']) expect(perms).toContain(p);
    // The video embeds go fullscreen and autoplay on a click: never switched off here.
    expect(perms).not.toMatch(/fullscreen|autoplay/);
  });

  it('reports a full resource policy that allows this app’s own media and auth host', () => {
    const ro = csp(header(app, 'Content-Security-Policy-Report-Only'));
    expect(ro['default-src']).toEqual(["'self'"]);
    expect(ro['img-src']).toContain('https://abcd.supabase.co');
    expect(ro['connect-src']).toEqual(expect.arrayContaining(['https://abcd.supabase.co', 'wss://abcd.supabase.co']));
    expect(ro['frame-ancestors']).toEqual(["'self'"]);
    expect(ro['form-action']).toEqual(["'self'"]);
  });

  it('allows eval only in development, where Next’s dev server needs it', () => {
    expect(csp(header(app, 'Content-Security-Policy-Report-Only'))['script-src']).not.toContain("'unsafe-eval'");
    expect(csp(header(app, 'Content-Security-Policy-Report-Only', DEV))['script-src']).toContain("'unsafe-eval'");
  });

  it('writes nothing broken when Supabase is not configured', () => {
    for (const h of securityHeaders(app, { NODE_ENV: 'production' } as NodeJS.ProcessEnv)) {
      expect(h.value, h.key).not.toMatch(/undefined|null|\n/);
    }
  });
});

describe('wiring', () => {
  it.each<SecurityApp>(['web', 'console'])('apps/%s/next.config.ts sends them on every path', (app) => {
    const src = readFileSync(resolve(__dirname, `../../../../apps/${app}/next.config.ts`), 'utf8');
    expect(src).toMatch(new RegExp(`source: '/:path\\*', headers: securityHeaders\\('${app}'\\)`));
  });
});

describe('per-app sources', () => {
  it('web: the three video and tour hosts the listing page embeds', () => {
    const frames = csp(header('web', 'Content-Security-Policy-Report-Only'))['frame-src'];
    expect(frames).toEqual(expect.arrayContaining(['https://www.youtube-nocookie.com', 'https://player.vimeo.com', 'https://my.matterport.com']));
  });

  it('console: Google’s picker script for the Sheets import', () => {
    expect(csp(header('console', 'Content-Security-Policy-Report-Only'))['script-src']).toContain('https://apis.google.com');
    expect(csp(header('web', 'Content-Security-Policy-Report-Only'))['script-src']).not.toContain('https://apis.google.com');
  });
});
