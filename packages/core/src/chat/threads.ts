import { and, asc, desc, eq, lt, sql } from 'drizzle-orm';
import { chatMessage, chatThread, type Db, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';

/**
 * How long a saved conversation is kept.
 *
 * Privacy Act / APP 11.2: personal information that is no longer needed must
 * be destroyed or de-identified. A property search transcript says where
 * somebody wants to live and what they can spend, and it stops being useful
 * to them long before it stops being sensitive.
 *
 * 90 days, enforced by `pruneOldChatMessages` on the scheduler tick rather
 * than by a policy nobody runs. A person can delete a thread sooner, and
 * deleting their account takes everything with it by cascade.
 */
export const CHAT_RETENTION_DAYS = 90;

/** Turns kept per thread when replaying to the model. Matches the client's cap. */
const MAX_REPLAY_TURNS = 12;

export class ChatError extends Error {
  constructor(
    message: string,
    readonly code: 'refused' | 'not_found',
  ) {
    super(message);
    this.name = 'ChatError';
  }
}

export type ThreadSummary = {
  id: string;
  title: string;
  lastMessageAt: Date;
  createdAt: Date;
};

/**
 * One stored turn.
 *
 * `searches` is the citation shape `chatRequestSchema` already accepts from
 * a browser. `resultsFrame` is display-only and deliberately separate — see
 * the note on the table, and `threadForModel` below, which does not read it.
 */
export type StoredTurn = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  searches: unknown;
  resultsFrame: unknown;
  /** Display-only, like `resultsFrame`. Never replayed to the model. */
  salesFrame: unknown;
  deepLink: string | null;
  createdAt: Date;
};

function resourceFor(ownerId: string, id?: string) {
  return id ? { type: 'chat', id, ownerId } : { type: 'chat', ownerId };
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** A thread's name, from the first thing the person said. */
export function titleFrom(text: string): string {
  const cleaned = text.trim().replace(/\s+/g, ' ');
  if (cleaned.length <= 60) return cleaned || 'New conversation';
  return `${cleaned.slice(0, 57)}…`;
}

export async function listThreads(
  db: Db,
  actor: Actor,
  opts: { limit?: number } = {},
): Promise<ThreadSummary[]> {
  if (!can(actor, 'chat:read', resourceFor(actor.userId))) return [];

  const rows = await db
    .select({
      id: chatThread.id,
      title: chatThread.title,
      lastMessageAt: chatThread.lastMessageAt,
      createdAt: chatThread.createdAt,
    })
    .from(chatThread)
    .where(eq(chatThread.userId, actor.userId))
    // lastMessageAt is not unique, so the id is the tiebreaker (§ 5).
    .orderBy(desc(chatThread.lastMessageAt), desc(chatThread.id))
    .limit(opts.limit ?? 30);

  return rows.map((row) => ({
    ...row,
    lastMessageAt: asDate(row.lastMessageAt),
    createdAt: asDate(row.createdAt),
  }));
}

export async function getThread(
  db: Db,
  actor: Actor,
  threadId: string,
): Promise<{ thread: ThreadSummary; turns: StoredTurn[] } | null> {
  const [thread] = await db
    .select()
    .from(chatThread)
    .where(eq(chatThread.id, threadId))
    .limit(1);

  if (!thread) return null;
  // Decided against the row that was read, not the id that was asked for.
  if (!can(actor, 'chat:read', resourceFor(thread.userId, thread.id))) return null;

  const rows = await db
    .select()
    .from(chatMessage)
    .where(eq(chatMessage.threadId, threadId))
    .orderBy(asc(chatMessage.createdAt), asc(chatMessage.id));

  return {
    thread: {
      id: thread.id,
      title: thread.title,
      lastMessageAt: asDate(thread.lastMessageAt),
      createdAt: asDate(thread.createdAt),
    },
    turns: rows.map((row) => ({
      id: row.id,
      role: row.role,
      text: row.text,
      searches: row.searches,
      resultsFrame: row.resultsFrame,
      salesFrame: row.salesFrame,
      deepLink: row.deepLink,
      createdAt: asDate(row.createdAt),
    })),
  };
}

/**
 * A stored thread, in the shape that may be sent back to the model.
 *
 * This is the function that makes persistence safe, and the omission is the
 * point: it returns `role`, `text` and `searches` and **nothing else**.
 * `resultsFrame` — the listings, with their prices — is dropped on the
 * floor, because a tool result is the only legitimate source of a price
 * (#4) and a replayed transcript must not become a second one.
 *
 * What comes back is byte-for-byte the shape the browser already posts
 * today, so `chatRequestSchema` validates it unchanged and no new trust
 * surface opens. Anything added to this return value needs that sentence to
 * still be true.
 */
export async function threadForModel(
  db: Db,
  actor: Actor,
  threadId: string,
): Promise<ModelTurn[]> {
  const loaded = await getThread(db, actor, threadId);
  if (!loaded) return [];
  return toModelTurns(loaded.turns);
}

export type ModelTurn = { role: 'user' | 'assistant'; text: string; searches: unknown };

/**
 * The projection, on its own so it can be tested without a database.
 *
 * This is the whole safety argument in four lines, and it is worth being
 * able to break deliberately: `resultsFrame` — the listings, with their
 * prices — is dropped, and only `role`, `text` and `searches` survive.
 */
export function toModelTurns(turns: StoredTurn[]): ModelTurn[] {
  return turns
    .slice(-MAX_REPLAY_TURNS)
    .map((turn) => ({ role: turn.role, text: turn.text, searches: turn.searches }));
}

export type AppendTurnInput = {
  threadId?: string | null;
  role: 'user' | 'assistant';
  text: string;
  searches?: unknown;
  resultsFrame?: unknown;
  salesFrame?: unknown;
  deepLink?: string | null;
};

/**
 * Append a turn, creating the thread on the first one.
 *
 * Takes `DbOrTx` because the two turns of one exchange — what the person
 * said and what the guide answered — are written together, and half an
 * exchange in the record is worse than none.
 */
export async function appendTurn(
  db: DbOrTx,
  actor: Actor,
  input: AppendTurnInput,
): Promise<{ threadId: string }> {
  if (!can(actor, 'chat:write', resourceFor(actor.userId, input.threadId ?? undefined))) {
    throw new ChatError('Sign in to save this conversation', 'refused');
  }

  let threadId = input.threadId ?? null;

  if (threadId) {
    // Ownership is re-checked against the stored row: a threadId arrives
    // from the browser, and the session is the only thing that says whose
    // it is.
    const [existing] = await db
      .select({ id: chatThread.id, userId: chatThread.userId })
      .from(chatThread)
      .where(eq(chatThread.id, threadId))
      .limit(1);

    if (!existing || existing.userId !== actor.userId) {
      throw new ChatError('No such conversation', 'not_found');
    }
  } else {
    const [created] = await db
      .insert(chatThread)
      .values({ userId: actor.userId, title: titleFrom(input.text) })
      .returning({ id: chatThread.id });

    if (!created) throw new ChatError('Could not start a conversation', 'not_found');
    threadId = created.id;
  }

  await db.insert(chatMessage).values({
    threadId,
    userId: actor.userId,
    role: input.role,
    text: input.text,
    searches: input.searches ?? null,
    resultsFrame: input.resultsFrame ?? null,
    salesFrame: input.salesFrame ?? null,
    deepLink: input.deepLink ?? null,
  });

  await db
    .update(chatThread)
    .set({ lastMessageAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(chatThread.id, threadId));

  return { threadId };
}

export async function deleteThread(db: Db, actor: Actor, threadId: string): Promise<void> {
  const [existing] = await db
    .select({ id: chatThread.id, userId: chatThread.userId })
    .from(chatThread)
    .where(eq(chatThread.id, threadId))
    .limit(1);

  if (!existing) throw new ChatError('No such conversation', 'not_found');
  if (!can(actor, 'chat:write', resourceFor(existing.userId, existing.id))) {
    // Same message as a missing row: "you may not touch this" confirms it
    // exists and belongs to somebody.
    throw new ChatError('No such conversation', 'not_found');
  }

  await db.delete(chatThread).where(eq(chatThread.id, threadId));
}

/**
 * Destroy transcripts past the retention window.
 *
 * Called from the scheduler tick, which already runs on a clock — a
 * retention policy enforced by a cron nobody set up is a policy that exists
 * only in a document. Threads are deleted rather than emptied, so nothing is
 * left holding a title that was itself the person's first sentence.
 */
export async function pruneOldChats(
  db: Db,
  opts: { now?: Date; retentionDays?: number } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const days = opts.retentionDays ?? CHAT_RETENTION_DAYS;
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const deleted = await db
    .delete(chatThread)
    .where(and(lt(chatThread.lastMessageAt, cutoff)))
    .returning({ id: chatThread.id });

  return deleted.length;
}
