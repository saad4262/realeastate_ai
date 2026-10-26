'use server';

import { OpportunityError, resolveOpportunity } from '@repo/core/opportunities';
import { getConsoleDb } from './db';
import { loadActor } from './load-actor';
import { requireActionUserId } from './auth-account';

/**
 * Done / Dismiss on an opportunity (ADR 0054 §6). The actor is rebuilt from the session; core
 * narrows the change to the person's own open opportunity and asks can() — the id is all the
 * browser supplies.
 */
export async function resolveOpportunityAction(id: string, status: 'done' | 'dismissed'): Promise<{ ok: true } | { ok: false; error: string }> {
  const userId = await requireActionUserId();
  const actor = await loadActor(userId);
  if (!actor) return { ok: false, error: 'Database is not configured.' };
  try {
    await resolveOpportunity(getConsoleDb(), actor, id, status === 'done' ? 'done' : 'dismissed');
    return { ok: true };
  } catch (err) {
    if (err instanceof OpportunityError) return { ok: false, error: err.message };
    console.error('[opportunities] resolve failed', err instanceof Error ? err.message : err);
    return { ok: false, error: 'That could not be saved. Try again.' };
  }
}
