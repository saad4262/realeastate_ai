import { captureRequestError } from '@sentry/nextjs';

/** Starts error monitoring where this request runs (ADR 0082). */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') await import('./sentry.server.config');
  if (process.env.NEXT_RUNTIME === 'edge') await import('./sentry.edge.config');
}

export const onRequestError = captureRequestError;
