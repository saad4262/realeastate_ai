import { browserMonitoring } from '@repo/core/observability/browser';
import { sentryOptions } from '@repo/core/observability';

/**
 * This app's browser monitoring (ADR 0082). The import is dynamic on purpose: a top-level one costs every page 37 kB of first load.
 */
export const monitoring = browserMonitoring(
  () => import('@sentry/nextjs'),
  sentryOptions({ dsn: process.env.NEXT_PUBLIC_SENTRY_DSN, environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV, app: 'console' }),
);
