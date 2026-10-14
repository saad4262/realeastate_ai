'use server';

import { revalidatePath } from 'next/cache';
import { pauseAllWorkflows, setWorkflowStatus, WorkflowError } from '@repo/core/workflows';
import { getConsoleDb } from './db';
import { loadListingActor } from './load-actor';
import { requireActionUserId } from './auth-account';

/** Workflows (ADR 0041 Part C): the screen's buttons. Every decision is core's (`workflow:manage`, `workflow:create_agency`). */
type R = { ok: true } | { ok: false; error: string };

async function actor() {
  const a = await loadListingActor(await requireActionUserId());
  if (!a) throw new WorkflowError('forbidden', 'Database is not configured.');
  return a;
}

function fail(err: unknown): { ok: false; error: string } {
  if (err instanceof WorkflowError) return { ok: false, error: err.message };
  console.error('[workflows] action failed', err);
  return { ok: false, error: 'That did not work. Please try again.' };
}

export async function setWorkflowStatusAction(id: string, status: 'active' | 'paused' | 'archived'): Promise<R> {
  try {
    if (!['active', 'paused', 'archived'].includes(status)) return { ok: false, error: 'Unknown change' };
    await setWorkflowStatus(getConsoleDb(), await actor(), String(id), status);
    revalidatePath('/workflows');
    revalidatePath('/my-workflows');
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function pauseAllWorkflowsAction(): Promise<R & { paused?: number }> {
  try {
    const paused = await pauseAllWorkflows(getConsoleDb(), await actor());
    revalidatePath('/workflows');
    return { ok: true, paused };
  } catch (err) {
    return fail(err);
  }
}
