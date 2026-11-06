import * as Sentry from '@sentry/nextjs';
import { sentryOptions } from '@repo/core/observability';

/** Error monitoring in middleware (ADR 0082). */
Sentry.init(sentryOptions({ dsn: process.env.NEXT_PUBLIC_SENTRY_DSN, environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV, app: 'console' }));
