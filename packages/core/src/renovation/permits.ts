import { AU_DUTY_STATES, type DutySource, type DutyState } from '../affordability/duty-rates';
import { PERMIT_TRIGGERS, renovationCategory, type PermitTrigger, type RenovationCategoryKey } from './categories';

/**
 * Permit and approval notes per state (ADR 0080, C3 decision 5): what a trigger in categories.ts means in one
 * state, in our words, from that state's official page — every rule carries its own source and the day it was
 * checked. A state (or a trigger) without a verified rule says so and links nothing it has not checked.
 *
 * "Usually": the council or a registered building surveyor decides; the page says that every time.
 *
 * Empty today, on purpose: each state's rules are filled from its official pages (building authority, planning
 * portal, Fair Trading / Consumer Affairs, asbestos agency) as the next step, the way the duty rates and the
 * buyer checklists were, and re-checked with them every 1 July (`renovationRulesDue`).
 */

export type PermitRule = { trigger: PermitTrigger; note: string; source: DutySource };

export type StatePermitRules = {
  state: DutyState;
  rules: readonly PermitRule[];
};

export const STATE_PERMIT_RULES: Readonly<Record<DutyState, StatePermitRules>> = Object.freeze(
  Object.fromEntries(AU_DUTY_STATES.map((state) => [state, { state, rules: [] }])) as unknown as Record<DutyState, StatePermitRules>,
);

export type PermitNote =
  | { trigger: PermitTrigger; verified: true; note: string; source: DutySource }
  | { trigger: PermitTrigger; verified: false };

/**
 * The notes for a plan in one state: every trigger its categories raise, once, in the order PERMIT_TRIGGERS
 * lists them, each with its verified rule or marked not verified. Pure.
 */
export function permitNotesFor(state: DutyState, categories: readonly RenovationCategoryKey[], rules: Readonly<Record<DutyState, StatePermitRules>> = STATE_PERMIT_RULES): PermitNote[] {
  const raised = new Set(categories.flatMap((k) => renovationCategory(k).triggers));
  const byTrigger = new Map(rules[state].rules.map((r) => [r.trigger, r]));
  return PERMIT_TRIGGERS.filter((tr) => raised.has(tr)).map((trigger) => {
    const rule = byTrigger.get(trigger);
    return rule ? { trigger, verified: true, note: rule.note, source: rule.source } : { trigger, verified: false };
  });
}

/** Re-checked with the duty rates every 1 July (ROADMAP technical debt). Pure — `now` is passed in. */
export function renovationRulesDue(now: Date, rules: Readonly<Record<DutyState, StatePermitRules>> = STATE_PERMIT_RULES): { stale: { state: DutyState; source: DutySource }[]; unverifiedStates: DutyState[] } {
  const year = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const lastFirstOfJuly = `${year}-07-01`;
  const all = Object.values(rules);
  return {
    stale: all.flatMap((s) => s.rules.filter((r) => r.source.checkedOn < lastFirstOfJuly).map((r) => ({ state: s.state, source: r.source }))),
    unverifiedStates: all.filter((s) => !s.rules.length).map((s) => s.state),
  };
}
