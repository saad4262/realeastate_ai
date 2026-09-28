'use server';

import { revalidatePath } from 'next/cache';
import { acceptScheduleDraft, requireDraftSecret, ScheduleError } from '@repo/core/schedules';
import { ensureConsumerAccount } from '../../lib/account';
import { getWebDb } from '../../lib/db';

export type AcceptResult = { ok: true } | { ok: false; error: string };

/**
 * Turn a proposed schedule into a real one.
 *
 * The browser sends the signed token and nothing else — not the search, not
 * the frequency, not a user id. What gets stored is what the signature
 * covers, so the row can only be the schedule that was on the card; and
 * whose it is comes from the session, the way ADR 0006 requires.
 */
export async function acceptScheduleDraftAction(token: string): Promise<AcceptResult> {
  try {
    const user = await ensureConsumerAccount();
    if (!user) return { ok: false, error: 'Sign in to start this schedule.' };

    await acceptScheduleDraft(getWebDb(), { userId: user.id }, token, requireDraftSecret());

    revalidatePath('/alerts');
    return { ok: true };
  } catch (err) {
    if (err instanceof ScheduleError) return { ok: false, error: err.message };
    return { ok: false, error: 'That could not be started. Try asking the guide again.' };
  }
}
