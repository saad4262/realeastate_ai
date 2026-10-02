'use server';

import { headers } from 'next/headers';
import {
  createPrivateOffer,
  OfferError,
  type PrivateOfferResult,
} from '@repo/core/leads';
import { agencyNotificationRecipients } from '@repo/core/agency';
import {
  buildPrivateOfferEmail,
  dryRunTransport,
  requireResendTransport,
  requireSenderIdentity,
} from '@repo/core/email';
import { getWebDb } from './db';
import { currentWebUser } from './session';

/**
 * Private offers per IP per minute.
 *
 * The same shape as the enquiry limiter and with the same honesty about what it
 * is: an in-process counter is a ceiling on ACCIDENTAL volume, not a security
 * control. Lower than the enquiry's five, because nobody makes three offers on
 * three houses in a minute in good faith — and because the real control here is
 * the sign-in requirement, which this only backs up.
 */
const LIMIT = 3;
const WINDOW_MS = 60_000;

type Bucket = { count: number; resetAt: number };
const BUCKETS = Symbol.for('@repo/web.offer-rate-limit');

function buckets(): Map<string, Bucket> {
  const g = globalThis as unknown as Record<symbol, Map<string, Bucket> | undefined>;
  return (g[BUCKETS] ??= new Map());
}

async function overLimit(): Promise<boolean> {
  const h = await headers();
  const ip =
    h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip') || 'unknown';

  const now = Date.now();
  const map = buckets();
  const current = map.get(ip);

  if (!current || current.resetAt < now) {
    map.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    // Bounded, or a long-lived process accumulates a bucket per visitor.
    if (map.size > 5000) {
      for (const [key, bucket] of map) if (bucket.resetAt < now) map.delete(key);
    }
    return false;
  }

  current.count += 1;
  return current.count > LIMIT;
}

/**
 * Tell the agency, after the offer is safely recorded.
 *
 * Deliberately after the write and outside it: a network call must never happen
 * inside a database write, and the ordering is the recoverable one. An offer in
 * the table with no email sent can be found and forwarded by hand; an email
 * about an offer that was never recorded cannot be turned back into one.
 *
 * So every failure here is swallowed and logged. The visitor is told their offer
 * was sent because it WAS — the row is the record, and a Resend outage is not
 * their problem to retry. This is the same reasoning `revalidateWeb` uses for
 * its own best-effort call.
 */
async function notify(
  agencyId: string,
  offer: {
    propertyAddress: string;
    propertyId: string;
    amount: number;
    name: string;
    email: string;
    phone: string | null;
    message: string;
  },
): Promise<void> {
  try {
    const sender = requireSenderIdentity();
    const recipients = await agencyNotificationRecipients(getWebDb(), agencyId);
    if (recipients.length === 0) {
      console.warn(`[offer] agency ${agencyId} has no owner or admin to notify`);
      return;
    }

    /**
     * `ALERTS_DRY_RUN=1` builds and formats everything and sends nothing — the
     * same switch the alert digest uses, in the same slot, so what is exercised
     * in dry mode is what ships.
     */
    const transport =
      process.env.ALERTS_DRY_RUN === '1' ? dryRunTransport() : requireResendTransport();

    const baseUrl = process.env.NEXT_PUBLIC_WEB_URL ?? 'http://web.lvh.me:3000';

    for (const recipient of recipients) {
      const message = buildPrivateOfferEmail({
        to: { email: recipient.email, ...(recipient.name ? { name: recipient.name } : {}) },
        from: { email: sender.from.email, name: sender.from.name },
        postalAddress: sender.postalAddress,
        propertyAddress: offer.propertyAddress,
        amount: offer.amount,
        offeredBy: { name: offer.name, email: offer.email, phone: offer.phone },
        message: offer.message,
        propertyUrl: `${baseUrl}/property/${offer.propertyId}`,
      });

      const result = await transport.send(message);
      if (!result.ok) {
        console.error(`[offer] could not notify ${recipient.email}: ${result.error}`);
      }
    }
  } catch (err) {
    // A missing sender identity, an unconfigured key, a provider outage. None of
    // them un-record the offer, so none of them reach the visitor.
    console.error('[offer] notification failed', err);
  }
}

/**
 * Make a private offer on a property that is not on the market.
 *
 * `propertyId` is the only thing the browser chooses. The agency is resolved
 * from the last recorded sale at that address inside `createPrivateOffer`, and
 * the offerer's identity comes from the session — which is why this refuses
 * outright when nobody is signed in rather than accepting an anonymous approach
 * to a private owner.
 *
 * `needsSignIn` is its own flag rather than an error string, because the page
 * answers it with a login link and not with a red message.
 *
 * Returns a result rather than throwing: every failure here is something the
 * visitor can act on, and a thrown server action reaches them as "an error
 * occurred".
 */
export async function sendPrivateOfferAction(
  propertyId: string,
  propertyAddress: string,
  input: unknown,
): Promise<PrivateOfferResult> {
  const user = await currentWebUser();
  if (!user?.email) {
    return {
      ok: false,
      error: 'Please sign in to make a private offer.',
      needsSignIn: true,
    };
  }

  if (await overLimit()) {
    return { ok: false, error: 'Too many offers just now. Please try again in a minute.' };
  }

  try {
    // `offer` is what was parsed and stored, not what arrived — so the email
    // quotes the trimmed name and the coerced number the row holds.
    const { agencyId, offer } = await createPrivateOffer(
      getWebDb(),
      propertyId,
      { userId: user.id, email: user.email },
      input,
    );

    await notify(agencyId, {
      propertyAddress,
      propertyId,
      amount: offer.offerAmount,
      name: offer.name,
      email: user.email,
      phone: offer.phone ?? null,
      message: offer.message,
    });

    return { ok: true };
  } catch (err) {
    if (err instanceof OfferError || (err as Error)?.name === 'OfferError') {
      const e = err as OfferError;
      return { ok: false, error: e.message, ...(e.field ? { field: e.field } : {}) };
    }
    // Never hand a raw database error to a public page.
    return { ok: false, error: 'Could not send that just now. Please try again.' };
  }
}
