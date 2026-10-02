'use server';

import { revalidatePath } from 'next/cache';
import {
  assignLead,
  LeadTriageError,
  updateLeadStatus,
  type LeadStatus,
  type TriageErrorCode,
} from '@repo/core/leads';
import { getConsoleDb } from './db';
import { loadListingActor } from './load-actor';
import { requireActionUserId } from './auth-account';

export type TriageActionResult =
  | { ok: true; status: LeadStatus; assignedTo: string | null }
  | { ok: false; error: string; code: TriageErrorCode | 'unknown' };

/**
 * The actor is rebuilt from the session on every call, never taken from the
 * browser — the same rule as the listing actions. Every decision about who may
 * do what is made by `can()` inside packages/core; this layer only translates
 * the outcome for the table.
 */
async function run(
  write: (actor: NonNullable<Awaited<ReturnType<typeof loadListingActor>>>) => Promise<{
    status: LeadStatus;
    assignedTo: string | null;
  }>,
): Promise<TriageActionResult> {
  // Outside the try: a missing session throws, and catching it would turn
  // "not signed in" into a confusing "could not update the lead".
  const userId = await requireActionUserId();

  try {
    // With listing links: an agent may work an unassigned lead that came
    // through a listing they are named on (ADR 0014), which can() can only
    // answer if it knows their listings.
    const actor = await loadListingActor(userId);
    if (!actor) return { ok: false, error: 'Database is not configured.', code: 'unknown' };

    const result = await write(actor);

    // The inbox and the nav badge beside it, which counts new offers.
    revalidatePath('/leads');
    revalidatePath('/my-leads');
    return { ok: true, status: result.status, assignedTo: result.assignedTo };
  } catch (err) {
    if (err instanceof LeadTriageError) return { ok: false, error: err.message, code: err.code };
    return { ok: false, error: 'Could not update the lead', code: 'unknown' };
  }
}

/** Move a lead along: new, contacted, qualified, closed. */
export async function setLeadStatusAction(
  leadId: string,
  status: LeadStatus,
): Promise<TriageActionResult> {
  return run((actor) => updateLeadStatus(getConsoleDb(), actor, leadId, status));
}

/** Give a lead to a member, or take it back with null. */
export async function assignLeadAction(
  leadId: string,
  assigneeUserId: string | null,
): Promise<TriageActionResult> {
  return run((actor) => assignLead(getConsoleDb(), actor, leadId, assigneeUserId));
}
