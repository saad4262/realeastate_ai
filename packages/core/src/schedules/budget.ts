import { and, gte, sql } from 'drizzle-orm';
import { aiRun, type Db } from '@repo/db';

export type BudgetWindow = {
  spentUsd: number;
  capUsd: number;
  remainingUsd: number;
  exceeded: boolean;
};

export type BudgetDecision = {
  global: BudgetWindow;
  user: BudgetWindow | null;
  allowed: boolean;
  reason?: 'global_cap' | 'user_cap';
};

/** The arithmetic, separated so it is testable without a database. */
export function decideBudget(spentUsd: number, capUsd: number): BudgetWindow {
  const remaining = Math.max(0, capUsd - spentUsd);
  return {
    spentUsd,
    capUsd,
    remainingUsd: remaining,
    // `>=` rather than `>`: at exactly the cap the budget is spent. A cap of
    // zero must refuse everything, and `0 > 0` is false.
    exceeded: spentUsd >= capUsd,
  };
}

/**
 * `numeric` comes back from postgres.js as a STRING.
 *
 * `cost_usd` is `numeric(12,6)`, so `sum()` returns something like
 * `"0.004688"`. `"0.004688" >= 5` is false and `"0.004688" + 0.1` is
 * `"0.0046880.1"` — a budget that silently never triggers and a total that
 * grows by concatenation. This is the third shape of the bug ARCHITECTURE
 * § 6 names by class, so the test asserts the TYPE and not just the value.
 */
function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What has been spent on the model in the last 24 hours, against the caps.
 *
 * ## What this is for
 *
 * Every cost ceiling that existed before this one is an in-process `Map`
 * keyed on an IP address — the chat's 10/min limiter and
 * `AI_CHAT_DAILY_TURN_CAP`. A cron tick has no IP and may not even share the
 * process, so neither applies to it at all. This one is a query over
 * `ai_run`, so it is durable, shared between processes and survives a
 * restart, which is exactly what those are not.
 *
 * ## What it is not
 *
 * Advisory, and the honesty matters as much as the query. Two runs can both
 * read the total before either writes its own row, so this is a ceiling on
 * drift rather than a hard limit. The backstop that actually holds is a
 * spend cap set in the Anthropic console — the same conclusion the chat
 * route's comment reaches, for the same reason.
 *
 * No new table. `ai_run` already records `feature`, `cost_usd`, `user_id`
 * and `created_at`; a second ledger would be a second copy of one fact and
 * the two would disagree the first time a call was metered but not budgeted.
 */
export async function checkAiBudget(
  db: Db,
  opts: { userId?: string; now?: Date; env?: NodeJS.ProcessEnv } = {},
): Promise<BudgetDecision> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - DAY_MS);

  const globalCap = Number(env.AI_DAILY_BUDGET_USD ?? 5);
  const userCap = Number(env.AI_DAILY_BUDGET_USD_PER_USER ?? 0.25);

  const [globalRow] = await db
    .select({ total: sql<string>`coalesce(sum(${aiRun.costUsd}), 0)` })
    .from(aiRun)
    .where(gte(aiRun.createdAt, since));

  const global = decideBudget(toNumber(globalRow?.total), globalCap);

  let user: BudgetWindow | null = null;
  if (opts.userId) {
    const [userRow] = await db
      .select({ total: sql<string>`coalesce(sum(${aiRun.costUsd}), 0)` })
      .from(aiRun)
      .where(and(gte(aiRun.createdAt, since), sql`${aiRun.userId} = ${opts.userId}`));

    user = decideBudget(toNumber(userRow?.total), userCap);
  }

  if (global.exceeded) return { global, user, allowed: false, reason: 'global_cap' };
  if (user?.exceeded) return { global, user, allowed: false, reason: 'user_cap' };

  return { global, user, allowed: true };
}
