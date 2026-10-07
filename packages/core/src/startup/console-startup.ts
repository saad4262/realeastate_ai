import { integrationStartupProblems } from '../integrations/startup';

/**
 * Everything that must stop a console server from starting in production.
 * The integration checks (ADR 0020), plus NEXT_PUBLIC_UI_PREVIEW: in the
 * console it makes middleware skip authentication for UI mocks, so in
 * production it would open every page to anyone. Messages name variables,
 * never values.
 */
export function consoleStartupProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems = integrationStartupProblems(env);
  if (env.NODE_ENV === 'production' && env.NEXT_PUBLIC_UI_PREVIEW === '1') {
    problems.push('NEXT_PUBLIC_UI_PREVIEW=1 is set in production — remove it (it skips sign-in, for UI mocks only).');
  }
  return problems;
}
