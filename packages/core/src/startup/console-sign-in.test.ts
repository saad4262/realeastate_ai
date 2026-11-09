import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Signing in, signing up and signing out of the console, read from source: the
 * console has no test runner, and each of these broke in a browser while every
 * unit test passed.
 */

const ROOT = join(__dirname, '..', '..', '..', '..');
const read = (...p: string[]) => readFileSync(join(ROOT, 'apps', 'console', ...p), 'utf8');

describe('console sign-in flow', () => {
  it('middleware sends a signed-in visitor off /login and /signup only on a page visit, never a Server Action POST', () => {
    const middleware = read('middleware.ts');
    // The forms set the session, then POST syncAccountAction to /login or /signup.
    // Redirecting that POST ran the action against /overview and painted it into the form.
    expect(middleware).toMatch(/const isPageVisit = request\.method === 'GET' \|\| request\.method === 'HEAD';/);
    expect(middleware).toMatch(/if \(userId && isAuthEntry && isPageVisit && /);
  });

  it("middleware's surface cookie takes the host-aware domain, not COOKIE_DOMAIN as-is", () => {
    const middleware = read('middleware.ts');
    expect(middleware).toMatch(/const cookieDomain = cookieDomainFor\(host\);/);
    expect(middleware).not.toMatch(/=\s*process\.env\.COOKIE_DOMAIN/);
  });

  it('after registering on the agency host, the console opens on that same host', () => {
    // vercel.app hosts share no cookie domain: an absolute agency URL naming another host arrived signed out.
    const page = read('app', '(shared)', 'get-started', 'page.tsx');
    expect(page).toMatch(/\(await currentSurface\(\)\) === 'agency' \? '' :/);
  });

  it("sign-out ends this browser's session only", () => {
    const route = read('app', '(shared)', 'sign-out', 'route.ts');
    expect(route).toMatch(/signOut\(\{ scope: 'local' \}\)/);
  });

  it('sign-out sits in the Settings group of both consoles, not the profile footer', () => {
    const surfaces = read('components', 'shell', 'surfaces.ts');
    const settingsGroups = surfaces.match(/label: 'Settings',[\s\S]*?\]\s*\}/g) ?? [];
    expect(settingsGroups).toHaveLength(2);
    for (const group of settingsGroups) expect(group).toContain('SIGN_OUT');
    expect(read('components', 'shell', 'console-shell.tsx')).not.toContain('SignOutButton');
  });
});
