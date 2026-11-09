'use server';

import { AssistantError, stopAssistantTask } from '@repo/core/assistant';
import { getConsoleDb } from './db';
import { loadListingActor } from './load-actor';
import { requireActionUserId } from './auth-account';

type R = { ok: true; cancelled: number } | { ok: false; error: string };

/** "Stop the rest" in the top bar's Automations panel (ADR 0088). Every decision is core's. */
export async function stopTaskAction(taskId: string): Promise<R> {
  try {
    const actor = await loadListingActor(await requireActionUserId());
    if (!actor) return { ok: false, error: 'Database is not configured.' };
    const { cancelled } = await stopAssistantTask(getConsoleDb(), actor, String(taskId));
    return { ok: true, cancelled };
  } catch (err) {
    if (err instanceof AssistantError) return { ok: false, error: err.message };
    console.error('[automations] stop failed', err instanceof Error ? err.message : 'unknown');
    return { ok: false, error: 'That did not work. Please try again.' };
  }
}
