import type { DbOrTx } from '@repo/db';
import type { Actor } from '../permissions';
import { capUsd, checkAiBudget, platformCapUsd, type BudgetWindow } from '../ai-budget';

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

/** The limits as the server reads them: the checks below and the admin's AI cost page must agree. */
export function aiBudgetCaps(env: NodeJS.ProcessEnv = process.env): { platform: number; person: number; agency: number } {
  return {
    platform: platformCapUsd(env),
    person: capUsd(env.ASSISTANT_DAILY_BUDGET_USD_PER_USER, 1),
    agency: capUsd(env.ASSISTANT_DAILY_BUDGET_USD_PER_AGENCY, 10),
  };
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
  db: DbOrTx,
  actor: Actor,
  opts: { now?: Date; env?: NodeJS.ProcessEnv } = {},
): Promise<AssistantBudget> {
  const env = opts.env ?? process.env;
  const caps = aiBudgetCaps(env);
  const agencyId = actor.agencyId ?? '00000000-0000-0000-0000-000000000000';
  const b = await checkAiBudget(db, {
    ...(opts.now ? { now: opts.now } : {}),
    env,
    user: { id: actor.userId, features: [ASSISTANT_FEATURE], capUsd: caps.person },
    agency: { id: agencyId, features: [ASSISTANT_FEATURE], capUsd: caps.agency },
  });
  const global = b.global;
  const person = b.user!;
  const agency = b.agency!;

  if (b.reason === 'global_cap') {
    return { allowed: false, reason: 'global_cap', message: 'The assistant has reached today’s platform limit. Try again tomorrow.', global, person, agency };
  }
  if (b.reason === 'user_cap') {
    return { allowed: false, reason: 'person_cap', message: 'You have reached your assistant limit for today. It resets over the next 24 hours.', global, person, agency };
  }
  if (b.reason === 'agency_cap') {
    return { allowed: false, reason: 'agency_cap', message: 'Your agency has reached its assistant limit for today.', global, person, agency };
  }
  return { allowed: true, reason: null, message: null, global, person, agency };
}
