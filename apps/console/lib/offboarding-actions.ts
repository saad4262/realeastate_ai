'use server';

import { revalidatePath } from 'next/cache';
import { syncDepsFromEnv } from '@repo/core/appointments';
import { assignNeedsOwner, OffboardError, removeMember, restoreMember, type RemovalReport } from '@repo/core/team';
import { ContactError } from '@repo/core/contacts';
import { getConsoleDb } from './db';
import { loadActor } from './load-actor';
import { requireActionUserId } from './auth-account';

/**
 * Offboarding (docs/adr/0030 §5–8). Owner/admin; core decides everything —
 * who may be removed, that a choice was made, that the last owner stays.
 */

type Fail = { ok: false; error: string };

async function sessionActor() {
  return loadActor(await requireActionUserId());
}

function failure(err: unknown): Fail {
  if (err instanceof OffboardError || err instanceof ContactError) return { ok: false, error: err.message };
  if (err instanceof Error && err.name === 'LeadTriageError') return { ok: false, error: err.message };
  throw err;
}

function refresh() {
  revalidatePath('/team', 'layout');
  revalidatePath('/overview');
}

/** `choice`: `{ receiver: userId }` or `{ review: true }` — there is no default. */
export async function removeMemberAction(userId: string, choice: unknown): Promise<{ ok: true; report: RemovalReport } | Fail> {
  const actor = await sessionActor();
  if (!actor) return { ok: false, error: 'Database is not configured.' };
  try {
    const report = await removeMember(getConsoleDb(), actor, userId, choice, { sync: syncDepsFromEnv() });
    refresh();
    return { ok: true, report };
  } catch (err) {
    return failure(err);
  }
}

export async function restoreMemberAction(userId: string): Promise<{ ok: true } | Fail> {
  const actor = await sessionActor();
  if (!actor) return { ok: false, error: 'Database is not configured.' };
  try {
    await restoreMember(getConsoleDb(), actor, userId);
    refresh();
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
}

export async function assignNeedsOwnerAction(kind: string, id: string, userId: string): Promise<{ ok: true } | Fail> {
  const actor = await sessionActor();
  if (!actor) return { ok: false, error: 'Database is not configured.' };
  if (!['contact', 'lead', 'appointment', 'listing'].includes(kind)) return { ok: false, error: 'Unknown item' };
  try {
    await assignNeedsOwner(getConsoleDb(), actor, { kind: kind as 'contact', id, userId }, { sync: syncDepsFromEnv() });
    refresh();
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
}
