'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ExportError, requestFullExport } from '@repo/core/exports';
import { getConsoleDb } from './db';
import { loadActor } from './load-actor';
import { requireActionUserId } from './auth-account';

/** The two pages that ask; the redirect never goes anywhere else. */
const PAGES = ['/settings/data', '/my-data'] as const;

/**
 * "Prepare my data" (ADR 0101 phase 3). The actor comes from the session; can('data:export'), the one-at-a-time
 * rule and the daily limit are core's. A refusal comes back to the page as a message.
 */
export async function requestExportAction(page: string): Promise<void> {
  const back = (PAGES as readonly string[]).includes(page) ? page : '/my-data';
  const userId = await requireActionUserId();
  const actor = await loadActor(userId);
  let error: string | null = actor ? null : 'Database is not configured.';
  if (actor) {
    try {
      await requestFullExport(getConsoleDb(), actor);
    } catch (err) {
      if (!(err instanceof ExportError)) throw err;
      error = err.message;
    }
  }
  revalidatePath(back);
  redirect(error ? `${back}?error=${encodeURIComponent(error)}` : back);
}
