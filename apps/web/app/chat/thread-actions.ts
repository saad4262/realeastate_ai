'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ChatError, deleteThread } from '@repo/core/chat';
import { getWebDb } from '../../lib/db';
import { currentWebUser } from '../../lib/session';

/**
 * Delete one saved conversation.
 *
 * Identity from the session, never from the client — the same rule as
 * ADR 0006. The id does arrive from the browser, which is why
 * `deleteThread` re-reads the row and asks `can()` rather than trusting it.
 */
export async function deleteThreadAction(threadId: string): Promise<{ ok: boolean }> {
  const user = await currentWebUser();
  if (!user) return { ok: false };

  try {
    await deleteThread(getWebDb(), { userId: user.id }, threadId);
  } catch (err) {
    if (err instanceof ChatError) return { ok: false };
    throw err;
  }

  revalidatePath('/chat');
  // Back to the list, which no longer contains the row.
  redirect('/chat?history=1');
}
