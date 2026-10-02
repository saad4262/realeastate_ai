'use server';

import { headers } from 'next/headers';
import { after } from 'next/server';
import { noticeMailFromEnv } from '@repo/core/email';
import {
  createEnquiry,
  EnquiryError,
  notifyNewLead,
  type EnquiryResult,
} from '@repo/core/leads';
import { getWebDb } from './db';

/**
 * Enquiries per IP per minute.
 *
 * The same shape as the chat route's limiter and with the same honest limit:
 * an in-process counter is a ceiling on ACCIDENTAL volume, not a security
 * control. A determined caller rotates IPs, and behind several instances the
 * real ceiling is this times the instance count. What it does stop is a stuck
 * retry loop or a bored visitor filling an agency's inbox in a minute.
 *
 * Lower than the chat's ten, because nobody enquires about five properties a
 * minute in good faith.
 */
const LIMIT = 5;
const WINDOW_MS = 60_000;

type Bucket = { count: number; resetAt: number };
const BUCKETS = Symbol.for('@repo/web.enquiry-rate-limit');

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
 * Send an enquiry to the agency marketing a listing.
 *
 * `listingId` is the only thing the browser chooses. The agency is looked up
 * from that listing in packages/core, and status, kind and assignment are set
 * there too — see createEnquiry, which is where the rule lives so that a
 * second caller cannot get it wrong.
 *
 * Returns a result rather than throwing, because every failure here is
 * something the visitor can act on and a thrown server action reaches them as
 * "an error occurred".
 */
export async function sendEnquiryAction(
  listingId: string,
  input: unknown,
): Promise<EnquiryResult> {
  if (await overLimit()) {
    return { ok: false, error: 'Too many enquiries just now. Please try again in a minute.' };
  }

  try {
    const { leadId } = await createEnquiry(getWebDb(), listingId, input);
    // Tell the listing's agents — after the response, so the visitor never
    // waits on Resend, and outside the write, so a mail outage loses no lead.
    after(() => emailListingAgents(leadId));
    return { ok: true };
  } catch (err) {
    if (err instanceof EnquiryError || (err as Error)?.name === 'EnquiryError') {
      const e = err as EnquiryError;
      return { ok: false, error: e.message, field: e.field };
    }
    // Never hand a raw database error to a public page.
    return { ok: false, error: 'Could not send that just now. Please try again.' };
  }
}

async function emailListingAgents(leadId: string) {
  const mail = noticeMailFromEnv();
  if (!mail) return;
  try {
    await notifyNewLead(getWebDb(), mail, leadId);
  } catch (err) {
    console.error(`[lead-notice] new-lead notice for lead ${leadId} failed`, err);
  }
}
