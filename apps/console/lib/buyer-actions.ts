'use server';

import { BuyerMatchError, scheduleBuyerCallTask } from '@repo/core/buyer-matching';
import { getConsoleDb } from './db';
import { loadActor } from './load-actor';
import { requireActionUserId } from './auth-account';

/**
 * A listing's Matching buyers tab (ADR 0060). The actor is rebuilt from the session; core re-reads which
 * buyers fit and which this person may see — nothing is taken from the browser but ids.
 */

export type BuyerActionResult = { ok: true; at?: string; already?: boolean } | { ok: false; error: string };

/** Remind me to call: ONE task at 9 am tomorrow listing every picked buyer with their phone. */
export async function remindToCallBuyersAction(listingId: string, contactIds: string[]): Promise<BuyerActionResult> {
  const userId = await requireActionUserId();
  const who = await loadActor(userId);
  if (!who) return { ok: false, error: 'Database is not configured.' };
  try {
    if (!Array.isArray(contactIds) || contactIds.some((id) => typeof id !== 'string')) return { ok: false, error: 'Pick the buyers to call.' };
    const r = await scheduleBuyerCallTask(getConsoleDb(), who, String(listingId), contactIds);
    return { ok: true, at: r.at.toISOString(), already: r.already };
  } catch (err) {
    if (err instanceof BuyerMatchError) return { ok: false, error: err.message };
    console.error('[buyers] call task failed', err instanceof Error ? err.message : err);
    return { ok: false, error: 'Could not make the call list. Please try again.' };
  }
}
