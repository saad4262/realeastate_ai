import { tokenKeysFromEnv, TokenKeyError } from './crypto';

/**
 * What would make it unsafe to serve integrations in production (ADR 0020):
 *  - `INTEGRATIONS_STUB=1` — the pretend provider would hand out fake
 *    connections (it is also refused at runtime there; this refuses to boot);
 *  - no `INTEGRATION_TOKEN_KEY`, or one of the wrong shape — nothing could be
 *    connected, and stored tokens could not be read.
 *  - a provider's client id without its secret, or the other way round.
 * Outside production, only a malformed key or half a client is a problem.
 *
 * Messages name the variable, never its value.
 */
export function integrationStartupProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const production = env.NODE_ENV === 'production';
  const problems: string[] = [];
  if (production && env.INTEGRATIONS_STUB === '1') {
    problems.push('INTEGRATIONS_STUB=1 is set in production — remove it (it is a development-only pretend provider).');
  }
  // Half a client is a typo, not a choice: the provider would silently fall back.
  for (const name of ['GOOGLE', 'ZOOM'] as const) {
    const id = Boolean(env[`${name}_OAUTH_CLIENT_ID`]?.trim());
    const secret = Boolean(env[`${name}_OAUTH_CLIENT_SECRET`]?.trim());
    if (id !== secret) {
      problems.push(`${name}_OAUTH_CLIENT_ID and ${name}_OAUTH_CLIENT_SECRET must be set together (only one is).`);
    }
  }
  try {
    const keys = tokenKeysFromEnv(env);
    if (!keys && production) {
      problems.push('INTEGRATION_TOKEN_KEY is missing — production needs its own key (docs/DEPLOY.md → Integrations).');
    }
  } catch (err) {
    problems.push(err instanceof TokenKeyError ? err.message : 'INTEGRATION_TOKEN_KEY could not be read.');
  }
  return problems;
}

/** Throws, naming every problem, so a misconfigured production server refuses to start. */
export function assertIntegrationStartup(env: NodeJS.ProcessEnv = process.env): void {
  const problems = integrationStartupProblems(env);
  if (problems.length) {
    throw new Error(`Refusing to start: ${problems.join(' ')}`);
  }
}
