import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { consoleStartupProblems } from './console-startup';

/**
 * NEXT_PUBLIC_UI_PREVIEW=1 makes the console's middleware skip authentication
 * (UI mocks only). In production that would open every console page to
 * anyone, so the console refuses to start with it — and, as a second line,
 * the middleware ignores it in production.
 */
const goodKey = Buffer.alloc(32, 7).toString('base64');
const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;
const ROOT = join(__dirname, '..', '..', '..', '..');

describe('the console refuses to start with the UI preview switch in production', () => {
  it('refuses NEXT_PUBLIC_UI_PREVIEW=1 in production, naming the variable', () => {
    const p = consoleStartupProblems(env({ NODE_ENV: 'production', INTEGRATION_TOKEN_KEY: goodKey, NEXT_PUBLIC_UI_PREVIEW: '1' }));
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/NEXT_PUBLIC_UI_PREVIEW/);
  });

  it('allows it in development, and keeps every integration check', () => {
    expect(consoleStartupProblems(env({ NODE_ENV: 'development', NEXT_PUBLIC_UI_PREVIEW: '1' }))).toEqual([]);
    expect(consoleStartupProblems(env({ NODE_ENV: 'production', INTEGRATION_TOKEN_KEY: goodKey }))).toEqual([]);
    expect(consoleStartupProblems(env({ NODE_ENV: 'production', INTEGRATIONS_STUB: '1', INTEGRATION_TOKEN_KEY: goodKey })).join(' ')).toMatch(/INTEGRATIONS_STUB/);
  });

  it('the console runs this check at startup, and its middleware ignores the switch in production', () => {
    const boot = readFileSync(join(ROOT, 'apps', 'console', 'instrumentation-node.ts'), 'utf8');
    expect(boot).toMatch(/consoleStartupProblems\(process\.env\)/);
    expect(boot).toMatch(/process\.exit\(1\)/);
    const middleware = readFileSync(join(ROOT, 'apps', 'console', 'middleware.ts'), 'utf8');
    expect(middleware).toMatch(/NEXT_PUBLIC_UI_PREVIEW === '1' && process\.env\.NODE_ENV !== 'production'/);
  });
});
