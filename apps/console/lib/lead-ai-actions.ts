'use server';

import { proposeBriefCard } from '@repo/core/leads';
import { getConsoleDb } from './db';
import { loadListingActor } from './load-actor';
import { requireActionUserId } from './auth-account';

/**
 * ADR 0078: "Save to … brief" on a lead — a `save_buyer_brief` card for THIS person, never a change. can() decides
 * inside core (editing the contact, asked again on approval). One card per lead and person (same key twice: the
 * same card).
 */
export async function proposeLeadBriefAction(leadId: string): Promise<{ cardId: string } | { error: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(leadId)) return { error: 'That lead was not found.' };
  const userId = await requireActionUserId();
  const actor = await loadListingActor(userId);
  if (!actor) return { error: 'Database is not configured.' };
  const out = await proposeBriefCard(getConsoleDb(), actor, { leadId, key: `${leadId}:${actor.userId}`, origin: 'assistant' });
  return 'cardId' in out ? out : { error: out.briefError };
}
