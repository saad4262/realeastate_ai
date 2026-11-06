import * as Sentry from '@sentry/nextjs';
import { sentryOptions } from '@repo/core/observability';

/**
 * Error monitoring on the server (ADR 0082). Much of this app catches a failure and logs it so the page can carry on, and those
 * never reach `onRequestError`, so a logged error is captured too. The shared rules remove anything personal first.
 */
Sentry.init({
  ...sentryOptions({ dsn: process.env.NEXT_PUBLIC_SENTRY_DSN, environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV, app: 'console' }),
  integrations: [Sentry.captureConsoleIntegration({ levels: ['error'] })],
});
