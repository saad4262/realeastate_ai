import { z } from 'zod';

/**
 * Automation (ADR 0080, C8 decisions 8–10; mock docs/mocks/consumer-acting.html#automations). Fixed lists, in code: a
 * "when" about homes the buyer follows, a "then" that stops at their own account. There is no "then" that writes to an
 * agency — not an enquiry, a booking or an offer — and adding one is an ADR, not an entry here. Pure.
 */

export const TRIGGERS = ['price_reduced', 'open_home_added', 'under_offer', 'sold', 'not_advertised', 'listed', 'new_match'] as const;
export type Trigger = (typeof TRIGGERS)[number];
export const SCOPES = ['shortlist', 'watched', 'both', 'search'] as const;
export type Scope = (typeof SCOPES)[number];
export const ACTIONS = ['tell', 'shortlist_add', 'shortlist_remove'] as const;
export type AutomationAction = (typeof ACTIONS)[number];
export const DELIVERIES = ['daily', 'instant'] as const;
export type Delivery = (typeof DELIVERIES)[number];

export const MAX_AUTOMATIONS = 20;
/** Each automation is checked at most this often. */
export const CHECK_MINUTES = 55;
/** The daily email's hour, local — Property Monitor's. */
export const DAILY_HOUR = 8;
/** "As it happens" is held between these local hours (decision 10). */
export const QUIET_FROM = 21;
export const QUIET_TO = 7;

/** For each "when": the homes it may watch and what it may do. */
export const ALLOWED: Record<Trigger, { scopes: readonly Scope[]; actions: readonly AutomationAction[] }> = {
  price_reduced: { scopes: ['shortlist', 'watched', 'both'], actions: ['tell'] },
  open_home_added: { scopes: ['shortlist', 'watched', 'both'], actions: ['tell'] },
  under_offer: { scopes: ['shortlist', 'watched', 'both'], actions: ['tell'] },
  sold: { scopes: ['shortlist', 'watched', 'both'], actions: ['tell', 'shortlist_remove'] },
  not_advertised: { scopes: ['shortlist', 'watched', 'both'], actions: ['tell', 'shortlist_remove'] },
  listed: { scopes: ['watched'], actions: ['tell', 'shortlist_add'] },
  new_match: { scopes: ['search'], actions: ['tell', 'shortlist_add'] },
};

export const TRIGGER_TEXT: Record<Trigger, string> = {
  price_reduced: 'has its price reduced',
  open_home_added: 'gets a new open home time',
  under_offer: 'goes under offer',
  sold: 'sells or is leased',
  not_advertised: 'is no longer advertised',
  listed: 'is listed',
  new_match: 'matches',
};
export const SCOPE_TEXT: Record<Scope, string> = { shortlist: 'a home on my shortlist', watched: 'an address I watch', both: 'a home on my shortlist or an address I watch', search: 'a new home' };
export const ACTION_TEXT: Record<AutomationAction, string> = { tell: 'Tell me', shortlist_add: 'Add it to my shortlist, and tell me', shortlist_remove: 'Take it off my shortlist, and tell me' };
export const DELIVERY_TEXT: Record<Delivery, string> = { daily: 'once a day at 8 am', instant: 'as it happens (not 9 pm–7 am)' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const automationInputSchema = z
  .object({
    trigger: z.enum(TRIGGERS),
    scope: z.enum(SCOPES),
    searchId: z.string().regex(UUID).optional(),
    action: z.enum(ACTIONS),
    delivery: z.enum(DELIVERIES).default('daily'),
    timeZone: z.string().trim().min(3).max(64).default('Australia/Sydney'),
  })
  .strict()
  .superRefine((v, ctx) => {
    const allowed = ALLOWED[v.trigger];
    if (!allowed.scopes.includes(v.scope)) ctx.addIssue({ code: 'custom', message: `“${TRIGGER_TEXT[v.trigger]}” can’t be about ${SCOPE_TEXT[v.scope]}`, path: ['scope'] });
    if (!allowed.actions.includes(v.action)) ctx.addIssue({ code: 'custom', message: `“${ACTION_TEXT[v.action]}” doesn’t fit “${TRIGGER_TEXT[v.trigger]}”`, path: ['action'] });
    if (v.scope === 'search' && !v.searchId) ctx.addIssue({ code: 'custom', message: 'Choose the saved search', path: ['searchId'] });
    if (v.scope !== 'search' && v.searchId) ctx.addIssue({ code: 'custom', message: 'Only a new match has a saved search', path: ['searchId'] });
    try {
      new Intl.DateTimeFormat('en-AU', { timeZone: v.timeZone });
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Unknown time zone', path: ['timeZone'] });
    }
  });
export type AutomationInput = z.infer<typeof automationInputSchema>;

/** "When a home on my shortlist has its price reduced → Tell me · once a day at 8 am". Pure. */
export function describeAutomation(a: { trigger: string; scope: string; action: string; delivery: string }, searchName?: string | null): { when: string; then: string } {
  const trigger = a.trigger as Trigger;
  const when = trigger === 'new_match' ? `When a new home matches “${searchName ?? 'your saved search'}”` : `When ${SCOPE_TEXT[a.scope as Scope] ?? 'a home'} ${TRIGGER_TEXT[trigger] ?? 'changes'}`;
  return { when, then: `${ACTION_TEXT[a.action as AutomationAction] ?? 'Tell me'} · ${DELIVERY_TEXT[a.delivery as Delivery] ?? DELIVERY_TEXT.daily}` };
}

/** The local hour in a zone. Pure. */
export function localHour(now: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-AU', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(now));
}

/** Whether an event waiting for this delivery may be emailed now (decision 10). Pure. */
export function sendableNow(delivery: string, now: Date, timeZone: string): boolean {
  const h = localHour(now, timeZone);
  if (delivery === 'instant') return !(h >= QUIET_FROM || h < QUIET_TO);
  return h === DAILY_HOUR;
}
