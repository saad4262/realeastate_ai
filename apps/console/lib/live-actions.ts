'use server';

import { consoleLiveStamp } from '@repo/core/mail';
import { getConsoleDb } from './db';
import { loadListingActor } from './load-actor';
import { requireActionUserId } from './auth-account';

/**
 * The open console's "anything new?" (ADR 0035, instant delivery). Returns a
 * stamp, never data: the browser refreshes when it changes. The actor is
 * rebuilt from the session — with listing links, as the inbox's scope needs.
 */
export async function liveStampAction(): Promise<{ stamp: string }> {
  try {
    const actor = await loadListingActor(await requireActionUserId());
    if (!actor) return { stamp: '' };
    return { stamp: await consoleLiveStamp(getConsoleDb(), actor) };
  } catch {
    // A missed tick is retried on the next one.
    return { stamp: '' };
  }
}
