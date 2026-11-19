export * from './plans';
export * from './credits';
export * from './stripe';
export * from './service';
export * from './seats';

import { stripeClient, type StripeApi } from './stripe';

/** Stripe from env (STRIPE_SECRET_KEY, test mode until the owner switches); none → billing is not set up. */
export function stripeFromEnv(env: NodeJS.ProcessEnv = process.env): StripeApi | null {
  const key = env.STRIPE_SECRET_KEY?.trim();
  return key ? stripeClient(key) : null;
}
