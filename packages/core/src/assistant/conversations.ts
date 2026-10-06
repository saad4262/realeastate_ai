import { and, asc, desc, eq, gte, isNull, lt, or, sql } from 'drizzle-orm';
import { assistantConversation, assistantTurn, type Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { parseHandleMap, type HandleMap } from './handles';
import { ASSISTANT_LIMITS, type AssistantFrame } from './schema';

/**
 * Conversations with the console assistant (ADR 0025 §7, §9). Seen and
 * continued by their author only. One turn at a time per conversation.
 */

export class AssistantError extends Error {
  constructor(
    readonly code: 'forbidden' | 'not_found' | 'busy' | 'limit' | 'conflict' | 'expired',
    message: string,
  ) {
    super(message);
    this.name = 'AssistantError';
  }
}

const NOT_FOUND = () => new AssistantError('not_found', 'That conversation was not found');

/** A turn left claimed longer than this is assumed dead (a crashed request) and may be taken over. */
const CLAIM_STALE_MS = 3 * 60 * 1000;

export type Surface = 'agent' | 'agency';

export type ClaimedTurn = {
  conversationId: string;
  /** This turn's number in the conversation. */
  seq: number;
  handles: HandleMap;
  /**
   * Every earlier completed turn's API messages, in order and unchanged — the
   * model's history. Opaque here (core never imports the model SDK).
   */
  history: unknown[];
};

function conversationResource(c: { id: string; agencyId: string; userId: string }) {
  return { type: 'assistant_conversation', id: c.id, agencyId: c.agencyId, ownerId: c.userId };
}

function mayUse(actor: Actor): actor is Actor & { agencyId: string } {
  return Boolean(actor.agencyId) && can(actor, 'assistant:use', { type: 'assistant', agencyId: actor.agencyId });
}

/**
 * Start a turn: open (or create) the conversation and CLAIM it, so a second
 * tab or a double send cannot run two turns into one history. Returns the
 * history to replay. Throws `busy` while another turn runs, `limit` when the
 * conversation is full (it is never trimmed — that would edit history the
 * model already reasoned over), `not_found` for anyone but its author.
 */
export async function claimTurn(
  db: Db,
  actor: Actor,
  input: { conversationId?: string; message: string; surface: Surface },
  now = new Date(),
): Promise<ClaimedTurn> {
  if (!mayUse(actor)) throw new AssistantError('forbidden', 'You do not have access to the assistant');

  if (!input.conversationId) {
    const [created] = await db
      .insert(assistantConversation)
      .values({
        agencyId: actor.agencyId,
        userId: actor.userId,
        surface: input.surface,
        title: input.message.replace(/\s+/g, ' ').trim().slice(0, 80),
        turnStartedAt: now,
        lastTurnAt: now,
      })
      .returning({ id: assistantConversation.id });
    return { conversationId: created!.id, seq: 1, handles: {}, history: [] };
  }

  const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS);
  // The claim and the visibility check in one statement: only the author's
  // own row, in their agency, not already mid-turn.
  const [claimed] = await db
    .update(assistantConversation)
    .set({ turnStartedAt: now, updatedAt: sql`now()` })
    .where(
      and(
        eq(assistantConversation.id, input.conversationId),
        eq(assistantConversation.userId, actor.userId),
        eq(assistantConversation.agencyId, actor.agencyId),
        or(isNull(assistantConversation.turnStartedAt), lt(assistantConversation.turnStartedAt, staleBefore)),
      ),
    )
    .returning({
      id: assistantConversation.id,
      agencyId: assistantConversation.agencyId,
      userId: assistantConversation.userId,
      handles: assistantConversation.handles,
      turnCount: assistantConversation.turnCount,
    });

  if (!claimed) {
    // Busy, or not theirs: tell them only what they may know.
    const [mine] = await db
      .select({ id: assistantConversation.id })
      .from(assistantConversation)
      .where(and(eq(assistantConversation.id, input.conversationId), eq(assistantConversation.userId, actor.userId), eq(assistantConversation.agencyId, actor.agencyId)))
      .limit(1);
    if (mine) throw new AssistantError('busy', 'The assistant is still answering in this conversation. Wait for it to finish.');
    throw NOT_FOUND();
  }
  if (!can(actor, 'assistant_conversation:read', conversationResource(claimed))) {
    await releaseTurn(db, claimed.id);
    throw NOT_FOUND();
  }
  if (claimed.turnCount >= ASSISTANT_LIMITS.turnsPerConversation) {
    await releaseTurn(db, claimed.id);
    throw new AssistantError('limit', 'This conversation is full. Start a new one to keep going.');
  }

  const turns = await db
    .select({ apiMessages: assistantTurn.apiMessages })
    .from(assistantTurn)
    .where(and(eq(assistantTurn.conversationId, claimed.id), eq(assistantTurn.status, 'done')))
    .orderBy(asc(assistantTurn.seq));

  return {
    conversationId: claimed.id,
    seq: claimed.turnCount + 1,
    handles: parseHandleMap(claimed.handles),
    history: turns.flatMap((t) => (Array.isArray(t.apiMessages) ? t.apiMessages : [])),
  };
}

/** Let go of a claim without recording a turn (the request died before it began). */
export async function releaseTurn(db: Db, conversationId: string): Promise<void> {
  await db
    .update(assistantConversation)
    .set({ turnStartedAt: null })
    .where(eq(assistantConversation.id, conversationId));
}

export type FinishedTurn = {
  /** Chosen before the first model request, so every `ai_run` row of the turn carries it as entity_id. */
  id: string;
  status: 'done' | 'failed';
  userText: string;
  answer: string;
  frames: AssistantFrame[];
  /** The exact messages of this turn, for replay. Null on a failed turn — shown, never replayed. */
  apiMessages: unknown[] | null;
  error: string | null;
  model: string | null;
  toolCalls: number;
  handles: HandleMap;
};

/** Record the turn and release the claim, together. */
export async function finishTurn(db: Db, claim: ClaimedTurn, turn: FinishedTurn, now = new Date()): Promise<{ turnId: string }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(assistantTurn)
      .values({
        id: turn.id,
        conversationId: claim.conversationId,
        seq: claim.seq,
        status: turn.status,
        userText: turn.userText,
        answer: turn.answer,
        frames: turn.frames,
        apiMessages: turn.status === 'done' ? turn.apiMessages : null,
        error: turn.error,
        model: turn.model,
        toolCalls: turn.toolCalls,
        createdAt: now,
      })
      .returning({ id: assistantTurn.id });
    await tx
      .update(assistantConversation)
      .set({
        handles: turn.handles,
        turnCount: claim.seq,
        turnStartedAt: null,
        lastTurnAt: now,
        updatedAt: sql`now()`,
      })
      .where(eq(assistantConversation.id, claim.conversationId));
    return { turnId: row!.id };
  });
}

export type ConversationSummary = { id: string; title: string; lastTurnAt: Date; turnCount: number };

/** This person's own conversations, newest first, within the retention window. One statement. */
export async function listAssistantConversations(db: Db, actor: Actor, now = new Date(), limit = 20): Promise<ConversationSummary[]> {
  if (!mayUse(actor)) return [];
  const keptSince = new Date(now.getTime() - ASSISTANT_LIMITS.retentionDays * 86_400_000);
  const rows = await db
    .select({
      id: assistantConversation.id,
      title: assistantConversation.title,
      lastTurnAt: assistantConversation.lastTurnAt,
      turnCount: assistantConversation.turnCount,
    })
    .from(assistantConversation)
    .where(
      and(
        eq(assistantConversation.userId, actor.userId),
        eq(assistantConversation.agencyId, actor.agencyId),
        gte(assistantConversation.lastTurnAt, keptSince),
      ),
    )
    .orderBy(desc(assistantConversation.lastTurnAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, lastTurnAt: new Date(r.lastTurnAt) }));
}

export type TurnView = {
  seq: number;
  status: 'done' | 'failed';
  userText: string;
  answer: string;
  frames: AssistantFrame[];
  error: string | null;
};

/** One conversation's turns for the panel — its author only; anyone else gets not-found. */
export async function getAssistantConversation(
  db: Db,
  actor: Actor,
  id: string,
): Promise<{ id: string; title: string; turns: TurnView[]; full: boolean }> {
  if (!mayUse(actor) || !/^[0-9a-f-]{36}$/i.test(id)) throw NOT_FOUND();
  const [c] = await db
    .select()
    .from(assistantConversation)
    .where(and(eq(assistantConversation.id, id), eq(assistantConversation.userId, actor.userId), eq(assistantConversation.agencyId, actor.agencyId)))
    .limit(1);
  if (!c || !can(actor, 'assistant_conversation:read', conversationResource(c))) throw NOT_FOUND();
  const turns = await db
    .select({
      seq: assistantTurn.seq,
      status: assistantTurn.status,
      userText: assistantTurn.userText,
      answer: assistantTurn.answer,
      frames: assistantTurn.frames,
      error: assistantTurn.error,
    })
    .from(assistantTurn)
    .where(eq(assistantTurn.conversationId, c.id))
    .orderBy(asc(assistantTurn.seq));
  return {
    id: c.id,
    title: c.title,
    full: c.turnCount >= ASSISTANT_LIMITS.turnsPerConversation,
    turns: turns.map((t) => ({
      seq: t.seq,
      status: t.status === 'failed' ? 'failed' : 'done',
      userText: t.userText,
      answer: t.answer,
      frames: (Array.isArray(t.frames) ? t.frames : []) as AssistantFrame[],
      error: t.error,
    })),
  };
}

/**
 * Delete conversations whose last turn is older than the retention window
 * (30 days, decided Q5). Their turns go with them (cascade). Run by the cron
 * tick. `ai_run` rows stay — they are the platform's accounting and hold no text.
 */
export async function purgeAssistantConversations(db: Db, now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - ASSISTANT_LIMITS.retentionDays * 86_400_000);
  const gone = await db
    .delete(assistantConversation)
    .where(lt(assistantConversation.lastTurnAt, before))
    .returning({ id: assistantConversation.id });
  return gone.length;
}
