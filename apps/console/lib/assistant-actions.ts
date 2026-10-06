'use server';

import {
  AssistantError,
  getAssistantConversation,
  listAssistantConversations,
  type ConversationSummary,
  type TurnView,
} from '@repo/core/assistant';
import { getConsoleDb } from './db';
import { loadActor } from './load-actor';
import { requireActionUserId } from './auth-account';

/**
 * The assistant panel's reads (docs/adr/0025). The actor is rebuilt from the
 * session; core decides — a conversation is its author's alone.
 */

async function actor() {
  const loaded = await loadActor(await requireActionUserId());
  if (!loaded) throw new AssistantError('forbidden', 'Database is not configured.');
  return loaded;
}

export async function listAssistantConversationsAction(): Promise<ConversationSummary[]> {
  return listAssistantConversations(getConsoleDb(), await actor());
}

export async function getAssistantConversationAction(
  id: string,
): Promise<{ ok: true; conversation: { id: string; title: string; turns: TurnView[]; full: boolean } } | { ok: false; error: string }> {
  try {
    return { ok: true, conversation: await getAssistantConversation(getConsoleDb(), await actor(), id) };
  } catch (err) {
    if (err instanceof AssistantError) return { ok: false, error: err.message };
    throw err;
  }
}
