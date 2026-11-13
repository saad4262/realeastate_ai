import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { safeLocalPath } from './safe-path';

/** Every place a `next=` value decides where a person is sent. Each must go through safeLocalPath. */
const REDIRECT_SITES = [
  'apps/console/middleware.ts',
  'apps/console/app/(shared)/login/page.tsx',
  'apps/console/app/(shared)/login/login-form.tsx',
  'apps/console/app/(shared)/signup/page.tsx',
  'apps/console/app/(shared)/signup/signup-form.tsx',
  'apps/console/app/(shared)/sign-out/route.ts',
  'apps/web/middleware.ts',
  'apps/web/app/(auth)/actions.ts',
  'packages/auth/src/callback.ts',
];

describe('redirect sites', () => {
  const root = resolve(__dirname, '../../..');
  it.each(REDIRECT_SITES)('%s uses safeLocalPath and no rule of its own', (file) => {
    const src = readFileSync(resolve(root, file), 'utf8');
    expect(src).toMatch(/safeLocalPath\(/);
    // The old hand-written rule, in any of the spellings it was copied in.
    expect(src).not.toMatch(/\.startsWith\(['"]\/['"]\)/);
  });
});

const HOME = '/overview';

describe('safeLocalPath', () => {
  it('keeps an ordinary path, with its query and hash', () => {
    expect(safeLocalPath('/listings', HOME)).toBe('/listings');
    expect(safeLocalPath('/alerts?token=abc&x=1', HOME)).toBe('/alerts?token=abc&x=1');
    expect(safeLocalPath('/contacts/123#notes', HOME)).toBe('/contacts/123#notes');
    expect(safeLocalPath('/', HOME)).toBe('/');
  });

  it('falls back for nothing, or for something that is not a string', () => {
    for (const v of [undefined, null, '', 42, {}, ['/listings']]) expect(safeLocalPath(v, HOME)).toBe(HOME);
  });

  it('refuses absolute URLs and anything not starting with one slash', () => {
    for (const v of ['https://evil.example', 'http://evil.example/x', 'javascript:alert(1)', 'evil.example', 'listings', ' /listings', 'data:text/html,hi']) {
      expect(safeLocalPath(v, HOME), v).toBe(HOME);
    }
  });

  it('refuses protocol-relative URLs, however they are spelled', () => {
    // Each of these is read by a browser as "another host": a backslash is a slash in an http(s) URL, and
    // tab, newline and carriage return are stripped from a URL before it is parsed.
    for (const v of ['//evil.example', '/\\evil.example', '\\\\evil.example', '/\t/evil.example', '/\n/evil.example', '/\r\n/evil.example', '\\/evil.example', '///evil.example', '/\\/evil.example']) {
      expect(safeLocalPath(v, HOME), JSON.stringify(v)).toBe(HOME);
    }
  });

  it('refuses control characters anywhere', () => {
    for (const v of ['/listings\u0000', '/a\u0007b', '/listings\nSet-Cookie: x=1']) expect(safeLocalPath(v, HOME), JSON.stringify(v)).toBe(HOME);
  });

  it('keeps an encoded slash as a path, which a browser never turns into a host', () => {
    expect(safeLocalPath('/%2F%2Fevil.example', HOME)).toBe('/%2F%2Fevil.example');
  });
});
