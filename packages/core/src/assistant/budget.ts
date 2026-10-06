import { gte, sql, and } from 'drizzle-orm';
import { aiRun, type Db } from '@repo/db';
import type { Actor } from '../permissions';
import { decideBudget, type BudgetWindow } from '../schedules/budget';

/** The `ai_run.feature` every assistant request is metered under. */
export const ASSISTANT_FEATURE = 'assistant';

export type AssistantBudget = {
  allowed: boolean;
  reason: 'global_cap' | 'person_cap' | 'agency_cap' | null;
  /** A sentence for the panel. */
  message: string | null;
  global: BudgetWindow;
  person: BudgetWindow;
  agency: BudgetWindow;
};

function cap(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * May this person ask the model one more thing today? (ADR 0025 §10, Q7.)
 *
 * Three windows over the last 24 hours of `ai_run`, in ONE statement: the
 * platform's whole spend (`AI_DAILY_BUDGET_USD`, default 5 — shared with every
 * feature), this person's assistant spend (`ASSISTANT_DAILY_BUDGET_USD_PER_USER`,
 * default 1.00) and their agency's (`ASSISTANT_DAILY_BUDGET_USD_PER_AGENCY`,
 * default 10.00). Asked before EVERY model request in a turn, not once per
 * turn, so a turn that would cross a cap stops at the next request.
 *
 * Advisory in the same way as `checkAiBudget`: two requests can read the total
 * before either writes. The hard ceiling is the spend limit in the Anthropic
 * console.
 */
export async function checkAssistantBudget(
  db: Db,
  actor: Actor,
  opts: { now?: Date; env?: NodeJS.ProcessEnv } = {},
): Promise<AssistantBudget> {
  const env = opts.env ?? process.env;
  const since = new Date((opts.now ?? new Date()).getTime() - 24 * 60 * 60 * 1000);
  const agencyId = actor.agencyId ?? '00000000-0000-0000-0000-000000000000';

  const [row] = await db
    .select({
      all: sql<string>`coalesce(sum(${aiRun.costUsd}), 0)`,
      person: sql<string>`coalesce(sum(${aiRun.costUsd}) filter (where ${aiRun.feature} = ${ASSISTANT_FEATURE} and ${aiRun.userId} = ${actor.userId}), 0)`,
      agency: sql<string>`coalesce(sum(${aiRun.costUsd}) filter (where ${aiRun.feature} = ${ASSISTANT_FEATURE} and ${aiRun.agencyId} = ${agencyId}), 0)`,
    })
    .from(aiRun)
    .where(and(gte(aiRun.createdAt, since)));

  const global = decideBudget(num(row?.all), cap(env.AI_DAILY_BUDGET_USD, 5));
  const person = decideBudget(num(row?.person), cap(env.ASSISTANT_DAILY_BUDGET_USD_PER_USER, 1));
  const agency = decideBudget(num(row?.agency), cap(env.ASSISTANT_DAILY_BUDGET_USD_PER_AGENCY, 10));

  if (global.exceeded) {
    return { allowed: false, reason: 'global_cap', message: 'The assistant has reached today’s platform limit. Try again tomorrow.', global, person, agency };
  }
  if (person.exceeded) {
    return { allowed: false, reason: 'person_cap', message: 'You have reached your assistant limit for today. It resets over the next 24 hours.', global, person, agency };
  }
  if (agency.exceeded) {
    return { allowed: false, reason: 'agency_cap', message: 'Your agency has reached its assistant limit for today.', global, person, agency };
  }
  return { allowed: true, reason: null, message: null, global, person, agency };
}
