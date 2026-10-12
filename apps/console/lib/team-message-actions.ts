'use server';

import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import {
  deliverTeamMessage,
  markTeamThreadRead,
  replyTeamThread,
  startTeamThread,
  teamMessageDepsFromEnv,
  TeamMessageError,
} from '@repo/core/team-messages';
import { getConsoleDb } from './db';
import { loadActor } from './load-actor';
import { requireActionUserId } from './auth-account';

/**
 * Team messages (ADR 0035 §3). The actor is rebuilt from the session on every
 * call; core decides who may read and write. The message is recorded in a
 * transaction; the others' bell and email follow the response (`after`), so a
 * slow mail provider never holds the Send button.
 */

export type TeamActionResult = { ok: true; threadId: string } | { ok: false; error: string };

async function actor() {
  const loaded = await loadActor(await requireActionUserId());
  if (!loaded) throw new TeamMessageError('forbidden', 'Database is not configured.');
  return loaded;
}

function refresh() {
  revalidatePath('/messages');
  revalidatePath('/my-messages');
}

function failure(err: unknown, fallback: string): TeamActionResult {
  if (err instanceof TeamMessageError) return { ok: false, error: err.message };
  console.error('[team] action failed', err);
  return { ok: false, error: fallback };
}

function deliverLater(messageId: string) {
  after(async () => {
    try {
      await deliverTeamMessage(getConsoleDb(), teamMessageDepsFromEnv(), messageId);
    } catch (err) {
      console.error('[team] delivery failed', err instanceof Error ? err.message : err);
    }
  });
}

export async function startTeamMessageAction(to: string[], subject: string, body: string): Promise<TeamActionResult> {
  const who = await actor();
  try {
    const db = getConsoleDb();
    const { threadId, messageId } = await db.transaction((tx) => startTeamThread(tx, who, { to, subject, body }));
    deliverLater(messageId);
    refresh();
    return { ok: true, threadId };
  } catch (err) {
    return failure(err, 'Could not send the message');
  }
}

export async function replyTeamMessageAction(threadId: string, body: string): Promise<TeamActionResult> {
  const who = await actor();
  try {
    const db = getConsoleDb();
    const { messageId } = await db.transaction((tx) => replyTeamThread(tx, who, threadId, { body }));
    deliverLater(messageId);
    refresh();
    return { ok: true, threadId };
  } catch (err) {
    return failure(err, 'Could not send the message');
  }
}

/** Called by the reader once it is on screen — never by a render, which a prefetch could trigger. */
export async function markTeamThreadReadAction(threadId: string): Promise<{ ok: boolean }> {
  try {
    await markTeamThreadRead(getConsoleDb(), await actor(), threadId);
    refresh();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
