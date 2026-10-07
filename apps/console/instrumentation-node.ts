import { consoleStartupProblems } from '@repo/core/startup/console-startup';

/**
 * In production the console REFUSES TO START when integrations are
 * misconfigured: the dev-only stub provider is switched on, or there is no
 * INTEGRATION_TOKEN_KEY (docs/adr/0020, docs/DEPLOY.md → Integrations) — or
 * NEXT_PUBLIC_UI_PREVIEW=1, which would skip sign-in on every page. A
 * server that cannot read its stored tokens, or that hands out pretend
 * connections, must not serve. Messages name variables, never values.
 */
const problems = consoleStartupProblems(process.env);
if (problems.length) {
  const message = `[console] Refusing to start: ${problems.join(' ')}`;
  console.error(message);
  if (process.env.NODE_ENV === 'production') {
    // Not just a throw — a thrown error here is logged and the server carries on.
    process.exit(1);
  }
}
