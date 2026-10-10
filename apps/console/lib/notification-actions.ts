'use server';

import { listNotifications, markNotificationsRead, type NotificationList } from '@repo/core/notifications';
import { getConsoleDb } from './db';
import { loadActor } from './load-actor';
import { requireActionUserId } from './auth-account';

/**
 * The console bell (ADR 0032 §4). The actor is rebuilt from the session on
 * every call; core narrows every read and write to the person's own rows and
 * asks can() — nothing here takes a user id from the browser.
 */

async function actor() {
  const loaded = await loadActor(await requireActionUserId());
  if (!loaded) throw new Error('Database is not configured.');
  return loaded;
}

/** The latest 20 and the unread count. A failure is an empty bell, never an error page. */
export async function listNotificationsAction(): Promise<NotificationList> {
  try {
    return await listNotifications(getConsoleDb(), await actor());
  } catch (err) {
    console.error('[notifications] list failed', err instanceof Error ? err.message : 'unknown');
    return { rows: [], unread: 0 };
  }
}

/** Mark these read, or all of them. Ids that are not the person's own are ignored by core. */
export async function markNotificationsReadAction(ids: string[] | 'all'): Promise<number> {
  try {
    return await markNotificationsRead(getConsoleDb(), await actor(), ids);
  } catch (err) {
    console.error('[notifications] mark read failed', err instanceof Error ? err.message : 'unknown');
    return 0;
  }
}
