import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@repo/db';
import type { SkillKey } from '../skill-switches/catalog';

/**
 * The plan map (ADR 0092, PLATFORM-PLAN 2.2): which skills each paid plan allows, in code; its numbers — credits a
 * month, seats, the Stripe Price ID — from env, because they are the owner's decision (decision 2), not code's.
 *
 * Only the three paid plans restrict. Any other value of `agency.plan` (`trial`, or a name a platform admin typed
 * before billing existed) allows every skill, so no agency loses a skill until it buys a plan through Stripe.
 */
export const PAID_PLANS = ['starter', 'growth', 'pro'] as const;
export type PaidPlan = (typeof PAID_PLANS)[number];

const STARTER: readonly SkillKey[] = [
  'bulk_email', 'ai_email_drafts', 'workflow_emails', 'ai_listing_copy', 'property_summaries', 'buyer_matching', 'ai_import',
  // The five opportunity alerts.
  'sale_anniversaries', 'cold_contacts', 'unanswered_emails', 'appraisal_follow_ups', 'repeat_interest',
];
const GROWTH: readonly SkillKey[] = [
  ...STARTER,
  'ai_understand_enquiries', 'ai_workflow_decisions', 'dashboards', 'knowledge_answers', 'team_meetings', 'bulk_sms', 'workflow_texts', 'missed_call_text',
];
const PRO: readonly SkillKey[] = [...GROWTH, 'agency_performance', 'team_activity', 'team_management', 'ai_callback'];

export const PLAN_SKILLS: Readonly<Record<PaidPlan, ReadonlySet<SkillKey>>> = Object.freeze({
  starter: new Set(STARTER),
  growth: new Set(GROWTH),
  pro: new Set(PRO),
});

export function isPaidPlan(plan: string | null | undefined): plan is PaidPlan {
  return (PAID_PLANS as readonly string[]).includes(plan ?? '');
}

/** Whether the agency's plan allows this skill. Anything but a paid plan allows every skill (see above). */
export function planAllowsSkill(plan: string | null | undefined, key: SkillKey): boolean {
  return isPaidPlan(plan) ? PLAN_SKILLS[plan].has(key) : true;
}

export type PlanNumbers = { credits: number | null; seats: number | null; stripePriceId: string | null };

const whole = (raw: string | undefined): number | null => {
  const s = raw?.trim() ?? '';
  return /^\d+$/.test(s) ? Number(s) : null;
};

/**
 * A paid plan's numbers from env: PLAN_STARTER_CREDITS, PLAN_STARTER_SEATS, STRIPE_PRICE_STARTER, and so on.
 * Unset or not a whole number → null: a plan without a Price ID cannot be bought, and nothing guesses a value.
 */
export function planNumbers(plan: PaidPlan, env: NodeJS.ProcessEnv = process.env): PlanNumbers {
  const P = plan.toUpperCase();
  return {
    credits: whole(env[`PLAN_${P}_CREDITS`]),
    seats: whole(env[`PLAN_${P}_SEATS`]),
    stripePriceId: env[`STRIPE_PRICE_${P}`]?.trim() || null,
  };
}

/**
 * When an agency's plan changes (the Stripe job, ADR 0092): switch off, in the same transaction, every skill switch
 * the new plan does not include. Not a paid plan → nothing changes. Returns how many switches went off.
 */
export async function applyPlanToSwitches(tx: DbOrTx, agencyId: string, plan: string | null): Promise<number> {
  if (!isPaidPlan(plan)) return 0;
  const allowed = [...PLAN_SKILLS[plan]];
  const off = await tx.execute(sql`
    update skill_switch set enabled = false, updated_at = now()
    where agency_id = ${agencyId} and enabled
      and skill_key not in (${sql.join(allowed.map((k) => sql`${k}`), sql`, `)})
    returning skill_key`);
  return off.length;
}

export const TOPUPS = ['small', 'large'] as const;
export type Topup = (typeof TOPUPS)[number];

/** A top-up pack's credits and Stripe Price ID from env (TOPUP_SMALL_CREDITS, STRIPE_PRICE_TOPUP_SMALL, …); unset → null. */
export function topupNumbers(t: Topup, env: NodeJS.ProcessEnv = process.env): { credits: number | null; stripePriceId: string | null } {
  const T = t.toUpperCase();
  return { credits: whole(env[`TOPUP_${T}_CREDITS`]), stripePriceId: env[`STRIPE_PRICE_TOPUP_${T}`]?.trim() || null };
}

/** Which paid plan or top-up a Stripe Price ID is, by the env above. Unknown → null. */
export function whatIsPrice(priceId: string | null, env: NodeJS.ProcessEnv = process.env): { plan: PaidPlan } | { topup: Topup; credits: number | null } | null {
  if (!priceId) return null;
  for (const p of PAID_PLANS) if (planNumbers(p, env).stripePriceId === priceId) return { plan: p };
  for (const t of TOPUPS) {
    const n = topupNumbers(t, env);
    if (n.stripePriceId === priceId) return { topup: t, credits: n.credits };
  }
  return null;
}
