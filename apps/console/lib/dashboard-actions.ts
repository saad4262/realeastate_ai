'use server';

import { revalidatePath } from 'next/cache';
import { archiveDashboard, DashboardError } from '@repo/core/dashboards';
import { getConsoleDb } from './db';
import { loadActor } from './load-actor';
import { requireActionUserId } from './auth-account';

/** Remove a dashboard (ADR 0027): its creator or an admin — core decides. */
export async function archiveDashboardAction(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const actor = await loadActor(await requireActionUserId());
  if (!actor) return { ok: false, error: 'Database is not configured.' };
  try {
    await archiveDashboard(getConsoleDb(), actor, id);
    revalidatePath('/dashboards');
    revalidatePath('/projects');
    revalidatePath('/my-dashboards');
    return { ok: true };
  } catch (err) {
    if (err instanceof DashboardError) return { ok: false, error: err.message };
    throw err;
  }
}
