'use server';

import { revalidatePath } from 'next/cache';
import { resumeAgencySends } from '@repo/core/safety';
import { getConsoleDb } from './db';
import { loadActor } from './load-actor';
import { requireActionUserId } from './auth-account';

/**
 * PLATFORM-PLAN 3.7: an owner or admin resumes the agency's paused sends. The actor comes from the session;
 * can('sends:resume') is checked inside core, and the resume is audited there.
 */
export async function resumeSendsAction(): Promise<{ ok: boolean; error?: string }> {
  const userId = await requireActionUserId();
  const actor = await loadActor(userId);
  if (!actor) return { ok: false, error: 'Database is not configured.' };
  try {
    await resumeAgencySends(getConsoleDb(), actor);
  } catch {
    return { ok: false, error: 'Only an owner or admin can resume sends.' };
  }
  revalidatePath('/', 'layout');
  return { ok: true };
}
