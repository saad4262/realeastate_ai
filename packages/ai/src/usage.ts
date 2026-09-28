import { aiRun, type DbOrTx } from '@repo/db';
import { costUsd, type TokenUsage } from './models';

/**
 * Every LLM call writes a row here. Non-negotiable #3.
 *
 * One row per API request, not per conversational turn: a turn that calls a
 * tool is two requests with two different token counts, and averaging them
 * away is how a feature's real cost becomes unknowable. `entityId` correlates
 * the requests that belonged to one turn.
 */
export type AiRunInput = {
  feature: string;
  model: string;
  usage: TokenUsage;
  latencyMs: number;
  /** Correlates the several requests that made up one turn. */
  entityId?: string;
  /**
   * Whose call this was, when there is a whose.
   *
   * Null for the consumer chat, which is anonymous. Set by the scheduler, so
   * `checkAiBudget` can answer "how much has this account cost today" — a
   * question `entityId` cannot answer, because it identifies a turn.
   */
  userId?: string;
  promptVersion: string;
};

export async function trackAiRun(db: DbOrTx, input: AiRunInput): Promise<void> {
  await db.insert(aiRun).values({
    feature: input.feature,
    model: input.model,
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    costUsd: String(costUsd(input.model, input.usage)),
    latencyMs: input.latencyMs,
    entityId: input.entityId ?? null,
    userId: input.userId ?? null,
    promptVersion: input.promptVersion,
  });
}

/**
 * The same thing, for a caller that must not fail because metering failed.
 *
 * A visitor who asked about a house should still get their answer when the
 * accounting insert times out. The failure is reported to the server log and
 * swallowed — deliberately, because the alternative is a chat that breaks for
 * a reason that has nothing to do with the chat.
 */
export async function trackAiRunQuietly(db: DbOrTx, input: AiRunInput): Promise<void> {
  try {
    await trackAiRun(db, input);
  } catch (err) {
    console.error('[ai] failed to record ai_run', err);
  }
}
