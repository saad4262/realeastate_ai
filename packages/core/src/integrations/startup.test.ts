import { describe, expect, it } from 'vitest';
import { integrationStartupProblems, assertIntegrationStartup } from './startup';

const goodKey = Buffer.alloc(32, 7).toString('base64');
const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;

describe('refusing to start a misconfigured production server', () => {
  it('refuses the stub in production', () => {
    const p = integrationStartupProblems(env({ NODE_ENV: 'production', INTEGRATIONS_STUB: '1', INTEGRATION_TOKEN_KEY: goodKey }));
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/INTEGRATIONS_STUB/);
  });

  it('refuses production without a key', () => {
    expect(() => assertIntegrationStartup(env({ NODE_ENV: 'production' }))).toThrow(/INTEGRATION_TOKEN_KEY is missing/);
  });

  it('refuses a malformed key anywhere, without printing it', () => {
    const p = integrationStartupProblems(env({ NODE_ENV: 'development', INTEGRATION_TOKEN_KEY: 'not-a-real-key' }));
    expect(p[0]).toMatch(/32 bytes/);
    expect(p.join(' ')).not.toContain('not-a-real-key');
  });

  it('starts a correctly configured production server, and a development one with the stub', () => {
    expect(integrationStartupProblems(env({ NODE_ENV: 'production', INTEGRATION_TOKEN_KEY: goodKey }))).toEqual([]);
    expect(integrationStartupProblems(env({ NODE_ENV: 'development', INTEGRATIONS_STUB: '1' }))).toEqual([]);
  });

  it('refuses half a provider client, naming the variables and never the value', () => {
    const p = integrationStartupProblems(env({ NODE_ENV: 'development', ZOOM_OAUTH_CLIENT_ID: 'zoom-id-value' }));
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/ZOOM_OAUTH_CLIENT_SECRET/);
    expect(p[0]).not.toContain('zoom-id-value');
    expect(integrationStartupProblems(env({ NODE_ENV: 'development', GOOGLE_OAUTH_CLIENT_ID: 'a', GOOGLE_OAUTH_CLIENT_SECRET: 'b' }))).toEqual([]);
  });
});
