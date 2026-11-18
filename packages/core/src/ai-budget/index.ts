import { sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '@repo/db';

/**
 * The AI budget: ONE place that reads the caps and ONE statement that reads what has been spent.
 *
 * Every model call is metered into `ai_run` (packages/ai/usage.ts). Before this module there were nine
 * copies of "sum ai_run over the last day and compare it with AI_DAILY_BUDGET_USD", each with its own
 * reading of the cap, and the public site's AI routes had none at all, so a visitor could spend past
 * the platform's $20 while every console feature had stopped. A copy that is never written is the
 * failure this shape invites; `ai-budget.test.ts` fails if a new one appears.
 *
 * ## What it is not
 *
 * Advisory: two requests can read the total before either writes its row, so it is a ceiling on drift,
 * not a lock. The limit that always holds is the spend cap in the Anthropic console.
 *
 * The window is the last 24 hours, rolling, not a calendar day: there is no midnight at which a whole
 * day's budget comes back at once.
 */

export type BudgetWindow = {
  spentUsd: number;
  capUsd: number;
  remainingUsd: number;
  exceeded: boolean;
};

/**
 * Which pool a call spends from (PLATFORM-PLAN 1.24). `public`: anonymous and consumer use (no agency on the
 * `ai_run` row). `trial`: agencies whose status is trial. `paying`: every other agency. Public and trial each have
 * a ceiling below the platform's, so neither can spend the share that keeps paying agencies running.
 */
export type AiPool = 'public' | 'trial' | 'paying';

export type AiBudget = {
  allowed: boolean;
  /** Which cap is spent; the platform's is named first, then the pool's, when more than one is. */
  reason: 'global_cap' | 'pool_cap' | 'user_cap' | 'agency_cap' | null;
  global: BudgetWindow;
  /** The pool's own ceiling (null for paying) and, for a trial agency, its share of the trial pool. */
  pool: { name: AiPool; window: BudgetWindow | null; agency: BudgetWindow | null };
  user: BudgetWindow | null;
  agency: BudgetWindow | null;
};

/** The name callers have used since the schedules' budget (ADR 0025). */
export type BudgetDecision = AiBudget;

/** The platform's default when AI_DAILY_BUDGET_USD is unset. Production sets 20. */
export const PLATFORM_DEFAULT_USD = 5;

/**
 * A cap from env, in dollars. Unset, blank, negative or not a number → the fallback.
 *
 * Never NaN: `Number('20$')` is NaN and `spent >= NaN` is false, so one copy turned a typo in Vercel
 * into no budget at all. Never a silent 0 for blank: another copy read '' as 0 and switched the
 * feature off. 0 written on purpose is 0, and refuses everything.
 */
export function capUsd(raw: string | undefined, fallback: number): number {
  const s = raw?.trim();
  if (!s) return fallback;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** The whole platform's daily AI spend cap (AI_DAILY_BUDGET_USD). */
export function platformCapUsd(env: NodeJS.ProcessEnv = process.env): number {
  return capUsd(env.AI_DAILY_BUDGET_USD, PLATFORM_DEFAULT_USD);
}

/**
 * The pools' ceilings. Unset, each is a share of the platform cap that leaves paying agencies at least 60% of it:
 * public 20%, trial 20%, one trial agency $2 (never more than the trial pool). The values are the owner's
 * decision (PLATFORM-PLAN decision 13); these defaults only keep the split safe until it is made.
 */
export function poolCapsUsd(env: NodeJS.ProcessEnv = process.env): { public: number; trial: number; trialPerAgency: number } {
  const platform = platformCapUsd(env);
  const trial = capUsd(env.AI_DAILY_BUDGET_USD_TRIAL, platform * 0.2);
  return {
    public: capUsd(env.AI_DAILY_BUDGET_USD_PUBLIC, platform * 0.2),
    trial,
    trialPerAgency: capUsd(env.AI_DAILY_BUDGET_USD_TRIAL_PER_AGENCY, Math.min(2, trial)),
  };
}

/** The arithmetic. `>=`: at exactly the cap the budget is spent, and a cap of 0 refuses everything. */
export function decideBudget(spentUsd: number, cap: number): BudgetWindow {
  return { spentUsd, capUsd: cap, remainingUsd: Math.max(0, cap - spentUsd), exceeded: spentUsd >= cap };
}

/** `numeric` comes back from postgres.js as a STRING; `'0.004688' >= 5` is false. */
function toNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Features that count towards a window: only these, all but these, or every one. */
type FeatureFilter = { features?: readonly string[]; exceptFeatures?: readonly string[] };

export type UserWindow = FeatureFilter & { id: string; capUsd: number };
export type AgencyWindow = FeatureFilter & { id: string; capUsd: number };

export type CheckAiBudgetOptions = {
  now?: Date;
  env?: NodeJS.ProcessEnv;
  /**
   * The skills' per-person cap (AI_DAILY_BUDGET_USD_PER_USER, $0.25), over everything this person ran
   * except the console assistant, which has its own caps (ADR 0025 §10). Shorthand for `user`.
   */
  userId?: string;
  user?: UserWindow;
  agency?: AgencyWindow;
  /**
   * The agency the call is for, when there is one but no agency window (a member's scheduled skill). It decides
   * the pool. Without an agency (here or in `agency`) the call is public.
   */
  agencyId?: string;
};

function featureClause(f: FeatureFilter): SQL {
  const parts: SQL[] = [];
  if (f.features) {
    parts.push(f.features.length ? sql`r.feature in (${sql.join(f.features.map((x) => sql`${x}`), sql`, `)})` : sql`false`);
  }
  if (f.exceptFeatures?.length) parts.push(sql`r.feature not in (${sql.join(f.exceptFeatures.map((x) => sql`${x}`), sql`, `)})`);
  return parts.length ? sql` and ${sql.join(parts, sql` and `)}` : sql``;
}

/**
 * May one more model call run? The platform's spend, the call's pool (public, trial or paying), and optionally one
 * person's and one agency's, over the last 24 hours of `ai_run`, in one statement on `ai_run_created_at_idx`.
 */
export async function checkAiBudget(db: DbOrTx, opts: CheckAiBudgetOptions = {}): Promise<AiBudget> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  // An ISO string: a Date cannot be bound into db.execute.
  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();

  const user: UserWindow | undefined =
    opts.user ?? (opts.userId ? { id: opts.userId, exceptFeatures: ['assistant'], capUsd: capUsd(env.AI_DAILY_BUDGET_USD_PER_USER, 0.25) } : undefined);
  const agency = opts.agency;

  const poolAgency = agency?.id ?? opts.agencyId ?? null;

  const personSum = user ? sql`coalesce(sum(r.cost_usd) filter (where r.user_id = ${user.id}${featureClause(user)}), 0)` : sql`0`;
  const agencySum = agency ? sql`coalesce(sum(r.cost_usd) filter (where r.agency_id = ${agency.id}${featureClause(agency)}), 0)` : sql`0`;
  const poolAgencySum = poolAgency ? sql`coalesce(sum(r.cost_usd) filter (where r.agency_id = ${poolAgency}), 0)` : sql`0`;
  const poolStatus = poolAgency ? sql`(select a.status::text from agency a where a.id = ${poolAgency})` : sql`null::text`;

  const [row] = await db.execute<{ total: string; person: string; agency: string; public_spend: string; trial_spend: string; pool_agency_spend: string; pool_status: string | null }>(sql`
    select coalesce(sum(r.cost_usd), 0) as total, ${personSum} as person, ${agencySum} as agency,
      coalesce(sum(r.cost_usd) filter (where r.agency_id is null), 0) as public_spend,
      coalesce(sum(r.cost_usd) filter (where r.agency_id in (select a.id from agency a where a.status = 'trial')), 0) as trial_spend,
      ${poolAgencySum} as pool_agency_spend, ${poolStatus} as pool_status
    from ai_run r
    where r.created_at >= ${since}`);

  const caps = poolCapsUsd(env);
  // An agency we cannot find is public, never paying: the safe direction.
  const name: AiPool = row?.pool_status == null ? 'public' : row.pool_status === 'trial' ? 'trial' : 'paying';
  const pool: AiBudget['pool'] =
    name === 'public'
      ? { name, window: decideBudget(toNumber(row?.public_spend), caps.public), agency: null }
      : name === 'trial'
        ? { name, window: decideBudget(toNumber(row?.trial_spend), caps.trial), agency: decideBudget(toNumber(row?.pool_agency_spend), caps.trialPerAgency) }
        : { name, window: null, agency: null };

  const global = decideBudget(toNumber(row?.total), platformCapUsd(env));
  const userWindow = user ? decideBudget(toNumber(row?.person), user.capUsd) : null;
  const agencyWindow = agency ? decideBudget(toNumber(row?.agency), agency.capUsd) : null;

  const reason = global.exceeded
    ? 'global_cap'
    : pool.window?.exceeded || pool.agency?.exceeded
      ? 'pool_cap'
      : userWindow?.exceeded
        ? 'user_cap'
        : agencyWindow?.exceeded
          ? 'agency_cap'
          : null;
  return { allowed: reason === null, reason, global, pool, user: userWindow, agency: agencyWindow };
}

/**
 * The public site's question, asked by every route that can reach a model: may one more call run?
 *
 * No when the platform's budget is spent, and no when the spend cannot be read: a model is never
 * called on a guess. Strict on purpose; the routes answer with their "resting for today" message and
 * every figure on the page still comes from SQL.
 */
export async function aiBudgetAllows(db: DbOrTx, opts: Pick<CheckAiBudgetOptions, 'now' | 'env'> = {}): Promise<boolean> {
  try {
    return (await checkAiBudget(db, opts)).allowed;
  } catch (err) {
    console.error('[ai-budget] could not read the spend; refusing', err instanceof Error ? err.message : err);
    return false;
  }
}
