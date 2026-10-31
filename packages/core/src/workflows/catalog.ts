import { z } from 'zod';
import { CONTACT_ROLES } from '../contacts/contact-schema';

/**
 * The workflow catalog (ADR 0041 Part B): every trigger, condition and action a workflow may be made
 * of. A workflow is a SPEC of these — validated here, run by the engine — never code or SQL. Pure:
 * the assistant's card, the screen and the engine all read this one file.
 */

// ── Triggers ────────────────────────────────────────────────────────────────

export const TRIGGER_KINDS = [
  'lead.created',
  'lead.status_changed',
  'lead.no_reply',
  'appointment.booked',
  'listing.status_changed',
  'contact.created',
  // ADR 0066 (ROADMAP 4.1): deals, buyer matches, appointments and past clients.
  'deal.stage_reached',
  'deal.settled',
  'buyer.matched',
  'appointment.upcoming',
  'appointment.completed',
  'appraisal.not_listed',
  'sale.anniversary',
  // ADR 0074 (ROADMAP 3.4): a call an agent missed, forwarded to their Twilio number.
  'call.missed',
] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'closed'] as const;
const LISTING_STATUSES = ['live', 'under_offer', 'sold', 'withdrawn'] as const;
const APPOINTMENT_TYPES = ['appraisal', 'phone_call', 'zoom', 'inspection', 'meeting'] as const;
/** The deal pipeline's seven stages (ADR 0063), repeated so this file stays pure data. */
export const DEAL_TRIGGER_STAGES = ['appraisal', 'listing', 'marketing', 'offers', 'negotiation', 'contract', 'settlement'] as const;
/** Which side of a deal a deal workflow acts on (ADR 0066, the user's decision 2): chosen per workflow. */
export const DEAL_SIDES = ['vendor', 'buyer'] as const;
export type DealSide = (typeof DEAL_SIDES)[number];
/** ADR 0074: whether a missed caller is already a contact (`known`) or a number nobody has (`new`). Omitted: either. */
export const CALLER_KINDS = ['known', 'new'] as const;
export const TRIGGER_LIMITS = { upcomingHours: { min: 1, max: 72 }, notListedDays: { min: 1, max: 30 }, anniversaryYears: { min: 1, max: 20 } } as const;

export const triggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('lead.created'), source: z.enum(['website', 'manual']).optional() }).strict(),
  z.object({ kind: z.literal('lead.status_changed'), to: z.enum(LEAD_STATUSES) }).strict(),
  z.object({ kind: z.literal('lead.no_reply'), days: z.number().int().min(1).max(14) }).strict(),
  z.object({ kind: z.literal('appointment.booked'), type: z.enum(APPOINTMENT_TYPES).optional() }).strict(),
  z.object({ kind: z.literal('listing.status_changed'), to: z.enum(LISTING_STATUSES) }).strict(),
  z.object({ kind: z.literal('contact.created'), source: z.enum(['manual', 'import']).optional() }).strict(),
  z.object({ kind: z.literal('deal.stage_reached'), to: z.enum(DEAL_TRIGGER_STAGES), who: z.enum(DEAL_SIDES).default('vendor') }).strict(),
  z.object({ kind: z.literal('deal.settled'), who: z.enum(DEAL_SIDES).default('vendor') }).strict(),
  z.object({ kind: z.literal('buyer.matched') }).strict(),
  z
    .object({
      kind: z.literal('appointment.upcoming'),
      hours: z.number().int().min(TRIGGER_LIMITS.upcomingHours.min).max(TRIGGER_LIMITS.upcomingHours.max),
      type: z.enum(APPOINTMENT_TYPES).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('appointment.completed'), type: z.enum(APPOINTMENT_TYPES).optional() }).strict(),
  z.object({ kind: z.literal('appraisal.not_listed'), days: z.number().int().min(TRIGGER_LIMITS.notListedDays.min).max(TRIGGER_LIMITS.notListedDays.max) }).strict(),
  z.object({ kind: z.literal('sale.anniversary'), years: z.number().int().min(TRIGGER_LIMITS.anniversaryYears.min).max(TRIGGER_LIMITS.anniversaryYears.max) }).strict(),
  z.object({ kind: z.literal('call.missed'), caller: z.enum(CALLER_KINDS).optional() }).strict(),
]);
export type Trigger = z.infer<typeof triggerSchema>;

/** What each trigger's record gives a run to act on. */
export const TRIGGER_RECORDS: Record<TriggerKind, { lead: boolean; contact: boolean; listing: boolean; appointment: boolean }> = {
  'lead.created': { lead: true, contact: true, listing: true, appointment: false },
  'lead.status_changed': { lead: true, contact: true, listing: true, appointment: false },
  'lead.no_reply': { lead: true, contact: true, listing: true, appointment: false },
  'appointment.booked': { lead: false, contact: true, listing: false, appointment: true },
  'listing.status_changed': { lead: false, contact: false, listing: true, appointment: false },
  'contact.created': { lead: false, contact: true, listing: false, appointment: false },
  'deal.stage_reached': { lead: false, contact: true, listing: true, appointment: false },
  'deal.settled': { lead: false, contact: true, listing: true, appointment: false },
  'buyer.matched': { lead: false, contact: true, listing: true, appointment: false },
  'appointment.upcoming': { lead: false, contact: true, listing: false, appointment: true },
  'appointment.completed': { lead: false, contact: true, listing: false, appointment: true },
  'appraisal.not_listed': { lead: false, contact: true, listing: false, appointment: true },
  'sale.anniversary': { lead: false, contact: true, listing: true, appointment: false },
  // The caller's contact when the number is in Contacts; none for a new number (see recordsOf).
  'call.missed': { lead: false, contact: true, listing: false, appointment: false },
};

/** What THIS trigger gives a run: a missed call from a `new` number has no contact to act on. */
export function recordsOf(t: Trigger): (typeof TRIGGER_RECORDS)[TriggerKind] {
  const has = TRIGGER_RECORDS[t.kind];
  return t.kind === 'call.missed' && t.caller === 'new' ? { ...has, contact: false } : has;
}

// ── Conditions ──────────────────────────────────────────────────────────────

export const CONDITION_FIELDS = ['listing.suburb', 'listing.channel', 'lead.kind', 'lead.source', 'assignee', 'contact.role', 'appointment.type', 'contact.name', 'listing'] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number];

/** ADR 0048: within N km of a place the server geocoded — never coordinates from the model. */
export const NEAR_FIELD = 'listing.near';
export const NEAR_KM = { min: 0.1, max: 100 } as const;

/** The values a field may be compared with, where the list is fixed. `null`: free words (a suburb, a name) or an id (a member, a listing). */
export const CONDITION_VALUES: Record<ConditionField, readonly string[] | null> = {
  'listing.suburb': null,
  'listing.channel': ['sale', 'rent'],
  'lead.kind': ['enquiry', 'inspection', 'appraisal'],
  'lead.source': ['website', 'manual'],
  assignee: null,
  'contact.role': CONTACT_ROLES,
  'appointment.type': APPOINTMENT_TYPES,
  'contact.name': null,
  listing: null,
};

type RecordKind = 'lead' | 'contact' | 'listing' | 'appointment';

/** Which record a field is read from — a condition is only allowed where its trigger has that record. */
const FIELD_RECORD: Record<ConditionField | typeof NEAR_FIELD, RecordKind> = {
  'listing.suburb': 'listing',
  'listing.channel': 'listing',
  'lead.kind': 'lead',
  'lead.source': 'lead',
  assignee: 'contact',
  'contact.role': 'contact',
  'appointment.type': 'appointment',
  'contact.name': 'contact',
  listing: 'listing',
  [NEAR_FIELD]: 'listing',
};

/** Fields whose values are ids, resolved from references and checked against the database. */
export const ID_FIELDS: readonly ConditionField[] = ['assignee', 'listing'];
/** `contains` / `not_contains`: any of the words appears in the text. Names only. */
const TEXT_OPS = ['contains', 'not_contains'] as const;
const TEXT_FIELDS: readonly ConditionField[] = ['contact.name'];

export const valuesConditionSchema = z
  .object({
    field: z.enum(CONDITION_FIELDS),
    op: z.enum(['eq', 'in', 'not_in', ...TEXT_OPS]),
    values: z.array(z.string().trim().min(1).max(80)).min(1).max(20),
  })
  .strict();
export const nearConditionSchema = z
  .object({
    field: z.literal(NEAR_FIELD),
    op: z.literal('within'),
    km: z.number().min(NEAR_KM.min).max(NEAR_KM.max),
    /** As the geocoder found it, when the card was made. */
    place: z.object({ label: z.string().trim().min(1).max(200), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict(),
  })
  .strict();
export const conditionSchema = z.union([valuesConditionSchema, nearConditionSchema]);
export type ValuesCondition = z.infer<typeof valuesConditionSchema>;
export type NearCondition = z.infer<typeof nearConditionSchema>;
export type Condition = z.infer<typeof conditionSchema>;
export const isNear = (c: Condition): c is NearCondition => c.field === NEAR_FIELD;

// ── Actions ─────────────────────────────────────────────────────────────────

export const ACTION_TYPES = [
  'add_note',
  'set_next_action',
  'remind_owner',
  'set_lead_status',
  'assign_lead',
  'assign_contact',
  'message_colleagues',
  'send_template_email',
  'draft_email',
  'wait',
  'wait_until',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

const text = (max: number) => z.string().trim().min(1).max(max);
const uuid = z.string().uuid();
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a time as HH:mm, 24-hour');
const minuteOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
/** Steps that only hold the next one back. */
const WAITS: readonly ActionType[] = ['wait', 'wait_until'];

export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('add_note'), text: text(2000) }).strict(),
  z.object({ type: z.literal('set_next_action'), text: text(300), in_days: z.number().int().min(0).max(60) }).strict(),
  z.object({ type: z.literal('remind_owner'), text: text(300), mail_me: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal('set_lead_status'), to: z.enum(LEAD_STATUSES) }).strict(),
  z.object({ type: z.literal('assign_lead'), to: uuid }).strict(),
  z.object({ type: z.literal('assign_contact'), to: uuid }).strict(),
  z.object({ type: z.literal('message_colleagues'), to: z.array(uuid).min(1).max(10), subject: text(200), body: text(2000) }).strict(),
  z.object({ type: z.literal('send_template_email'), template_id: uuid }).strict(),
  /** What the AI should write about — the person's instructions. The email is a DRAFT for the owner (D1). */
  z.object({ type: z.literal('draft_email'), instructions: text(1000) }).strict(),
  z.object({ type: z.literal('wait'), hours: z.number().int().min(1).max(720) }).strict(),
  /** ADR 0048, on the agency's clock: with `to`, a window (now if inside it); without, the next `from`. */
  z.object({ type: z.literal('wait_until'), from: hhmm, to: hhmm.optional(), days: z.array(z.enum(WEEKDAYS)).min(1).max(7).optional() }).strict(),
]);
export type WorkflowAction = z.infer<typeof actionSchema>;

/** Which record an action needs — a `listing.status_changed` workflow, say, has no contact to email. */
export const ACTION_NEEDS: Record<ActionType, 'lead' | 'contact' | null> = {
  add_note: 'contact',
  set_next_action: 'contact',
  remind_owner: null,
  set_lead_status: 'lead',
  assign_lead: 'lead',
  assign_contact: 'contact',
  message_colleagues: null,
  send_template_email: 'contact',
  draft_email: 'contact',
  wait: null,
  wait_until: null,
};

/** Actions only an agency-wide workflow may have (D2: assigning is an admin's). */
export const AGENCY_ONLY_ACTIONS: readonly ActionType[] = ['assign_lead', 'assign_contact'];

/** Actions that reach a contact. `send_template_email` sends by itself (an approved template, D1); `draft_email` never does. */
export const REACHES_CONTACT: readonly ActionType[] = ['send_template_email', 'draft_email'];

export const WORKFLOW_LIMITS = { conditions: 5, actions: 6, perAgent: 10, perAgency: 50, runsPerDay: 200, draftDays: 7 } as const;

// ── AI decides (ADR 0067, ROADMAP 4.2) ──────────────────────────────────────

/** The triggers whose record has words for the AI to read: an enquiry and its latest email, or an appointment's outcome. */
export const DECIDABLE_TRIGGERS: readonly TriggerKind[] = ['lead.created', 'lead.status_changed', 'lead.no_reply', 'appointment.completed'];
export const DECIDE_LIMITS = { choices: { min: 2, max: 4 }, label: 40, question: 200 } as const;
/** The label of the workflow's own steps when there is a decision: what runs when the AI is not sure, or was not asked. */
export const NOT_SURE = 'Not sure';

/**
 * At the start of a run, the AI reads the record and picks ONE of these labels (the user's decision 1); that
 * choice's steps run, and the workflow's own steps are "Not sure" (decision 3). The AI never writes a step.
 */
export const decideSchema = z
  .object({
    question: text(DECIDE_LIMITS.question),
    choices: z
      .array(z.object({ label: text(DECIDE_LIMITS.label), actions: z.array(actionSchema).min(1).max(WORKFLOW_LIMITS.actions) }).strict())
      .min(DECIDE_LIMITS.choices.min)
      .max(DECIDE_LIMITS.choices.max),
  })
  .strict();
export type Decide = z.infer<typeof decideSchema>;

export const workflowSpecSchema = z
  .object({
    trigger: triggerSchema,
    conditions: z.array(conditionSchema).max(WORKFLOW_LIMITS.conditions).default([]),
    /** The steps — or, with `decide`, the "Not sure" steps. */
    actions: z.array(actionSchema).min(1).max(WORKFLOW_LIMITS.actions),
    decide: decideSchema.optional(),
  })
  .strict();
export type WorkflowSpec = z.infer<typeof workflowSpecSchema>;

/** Every step a workflow may run, across its choices — for what a card warns about and what a run may need. */
export function allActions(spec: WorkflowSpec): WorkflowAction[] {
  return [...spec.actions, ...(spec.decide?.choices.flatMap((c) => c.actions) ?? [])];
}
export type WorkflowScope = 'mine' | 'agency';

/**
 * Everything the schema cannot say: an action or a condition its trigger has no record for, a
 * value not in a field's list, an admin-only action on a personal workflow, a `wait` with nothing
 * after it. Null when the spec is usable. The message names the part, so it can be fixed.
 */
export function specProblem(spec: WorkflowSpec, scope: WorkflowScope): string | null {
  const has = recordsOf(spec.trigger);
  for (const [i, c] of spec.conditions.entries()) {
    const rec = FIELD_RECORD[c.field];
    if (!has[rec]) return `Condition ${i + 1} (${c.field}): a “${TRIGGER_WORDS[spec.trigger.kind]}” workflow has no ${rec} to look at`;
    if (isNear(c)) continue;
    const allowed = CONDITION_VALUES[c.field];
    if (allowed) for (const v of c.values) if (!allowed.includes(v)) return `Condition ${i + 1} (${c.field}): “${v}” is not one of ${allowed.join(', ')}`;
    if (c.op === 'eq' && c.values.length !== 1) return `Condition ${i + 1}: “is” takes one value`;
    if ((TEXT_OPS as readonly string[]).includes(c.op) && !TEXT_FIELDS.includes(c.field)) return `Condition ${i + 1} (${c.field}): “contains” is only for a contact’s name`;
    if (c.field === 'assignee' && c.values.some((v) => !uuid.safeParse(v).success)) return `Condition ${i + 1}: the assignee must be a team member`;
    if (c.field === 'listing' && c.values.some((v) => !uuid.safeParse(v).success)) return `Condition ${i + 1}: the listing must be one of the agency’s listings`;
  }
  if (spec.decide) {
    if (!DECIDABLE_TRIGGERS.includes(spec.trigger.kind)) {
      return `The AI can only decide on a workflow whose trigger has words to read — a new lead, a lead's status change, no reply, or an appointment completed`;
    }
    const labels = spec.decide.choices.map((c) => c.label.trim().toLowerCase());
    if (new Set(labels).size !== labels.length) return 'Each of the AI’s choices needs its own label';
    if (labels.includes(NOT_SURE.toLowerCase())) return `“${NOT_SURE}” is the workflow’s own steps — give the choices other labels`;
  }
  const own = stepsProblem(spec.actions, spec, scope, spec.decide ? `${NOT_SURE}: ` : '');
  if (own) return own;
  for (const c of spec.decide?.choices ?? []) {
    const p = stepsProblem(c.actions, spec, scope, `${c.label}: `);
    if (p) return p;
  }
  return null;
}

/** One list of steps: each needs a record its trigger has, assigning only agency-wide, no wait at the end. */
function stepsProblem(actions: readonly WorkflowAction[], spec: WorkflowSpec, scope: WorkflowScope, prefix: string): string | null {
  const has = recordsOf(spec.trigger);
  for (const [i, a] of actions.entries()) {
    const need = ACTION_NEEDS[a.type];
    if (need && !has[need]) {
      if (spec.trigger.kind === 'call.missed' && need === 'contact') return `${prefix}Action ${i + 1} (${ACTION_WORDS[a.type]}): a call from a new number has no contact yet — remind someone to call back instead`;
      return `${prefix}Action ${i + 1} (${ACTION_WORDS[a.type]}): a “${TRIGGER_WORDS[spec.trigger.kind]}” workflow has no ${need} to act on`;
    }
    if (scope === 'mine' && AGENCY_ONLY_ACTIONS.includes(a.type)) return `${prefix}Action ${i + 1} (${ACTION_WORDS[a.type]}): only an agency-wide workflow (owners and admins) may assign`;
    if (a.type === 'wait_until') {
      const next = actions[i + 1];
      if (!next) break;
      if (WAITS.includes(next.type)) return `${prefix}Action ${i + 1} (wait for a time): put any wait before it — the step after it must be a real step`;
      if (a.to !== undefined && minuteOf(a.to) <= minuteOf(a.from)) return `${prefix}Action ${i + 1} (wait for a time): “to” must be later than “from” on the same day`;
      if (a.days && new Set(a.days).size !== a.days.length) return `${prefix}Action ${i + 1} (wait for a time): a day is named twice`;
    }
  }
  const last = actions[actions.length - 1]!;
  if (WAITS.includes(last.type)) return `${prefix}A workflow cannot end with a wait — say what happens after it`;
  if (actions.every((a) => WAITS.includes(a.type))) return `${prefix}Give at least one action`;
  // A wait_until holds a step back less than a week; the run's task lives 30 days.
  if (actions.reduce((h, a) => h + (a.type === 'wait' ? a.hours : a.type === 'wait_until' ? 7 * 24 : 0), 0) > 29 * 24) return `${prefix}All the waits together must be under 29 days (a wait for a time counts as up to 7)`;
  return null;
}

// ── Merge fields: filled from the database when an action runs, never by the model ─────────

/** `caller_phone` (ADR 0074): a missed caller's number as Australians write it — for "call back …". */
export const MERGE_FIELDS = ['contact_name', 'contact_first_name', 'listing_address', 'agent_name', 'caller_phone'] as const;
export type MergeValues = Partial<Record<(typeof MERGE_FIELDS)[number], string>>;

/** `{{contact_first_name}}` → its value, or nothing when the record has none. Unknown fields stay as written. */
export function renderMerge(text: string, values: MergeValues): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (all, k: string) => ((MERGE_FIELDS as readonly string[]).includes(k) ? (values[k as keyof MergeValues] ?? '') : all)).replace(/[ \t]{2,}/g, ' ').trim();
}

// ── In words: the card, the screen and the run log say the same thing ──────────────────────

export const TRIGGER_WORDS: Record<TriggerKind, string> = {
  'lead.created': 'new lead',
  'lead.status_changed': 'lead status change',
  'lead.no_reply': 'no reply',
  'appointment.booked': 'appointment booked',
  'listing.status_changed': 'listing status change',
  'contact.created': 'new contact',
  'deal.stage_reached': 'deal stage',
  'deal.settled': 'deal settled',
  'buyer.matched': 'buyer match',
  'appointment.upcoming': 'before an appointment',
  'appointment.completed': 'appointment completed',
  'appraisal.not_listed': 'appraisal not listed',
  'sale.anniversary': 'sale anniversary',
  'call.missed': 'missed call',
};

export const ACTION_WORDS: Record<ActionType, string> = {
  add_note: 'add a note',
  set_next_action: 'set the next action',
  remind_owner: 'remind you',
  set_lead_status: 'change the lead’s status',
  assign_lead: 'give the lead to',
  assign_contact: 'give the contact to',
  message_colleagues: 'message colleagues',
  send_template_email: 'send an email template',
  draft_email: 'write an email draft for you to approve',
  wait: 'wait',
  wait_until: 'wait for a time',
};

const STATUS = (s: string) => s.replace('_', ' ');
/** "an appraisal", "a zoom". */
const art = (w: string) => `${/^[aeiou]/i.test(w) ? 'an' : 'a'} ${w}`;
const FIELD_LABELS: Record<ConditionField, string> = {
  'listing.suburb': 'the listing’s suburb',
  'listing.channel': 'the listing',
  'lead.kind': 'the lead',
  'lead.source': 'the lead’s source',
  assignee: 'the assigned agent',
  'contact.role': 'the contact’s role',
  'appointment.type': 'the appointment type',
  'contact.name': 'the contact’s name',
  listing: 'the listing',
};
const VALUE_WORDS: Record<string, string> = { sale: 'for sale', rent: 'for lease', enquiry: 'an enquiry', inspection: 'an inspection request', appraisal: 'an appraisal request' };

export function triggerInWords(t: Trigger): string {
  switch (t.kind) {
    case 'lead.created':
      return t.source === 'website' ? 'When an enquiry arrives from the website' : t.source === 'manual' ? 'When a lead is recorded by hand' : 'When a new lead arrives';
    case 'lead.status_changed':
      return `When a lead is marked ${STATUS(t.to)}`;
    case 'lead.no_reply':
      return `When a buyer has had no reply for ${t.days} day${t.days === 1 ? '' : 's'}`;
    case 'appointment.booked':
      return t.type ? `When ${art(STATUS(t.type))} appointment is booked` : 'When an appointment with a contact is booked';
    case 'listing.status_changed':
      return `When a listing becomes ${STATUS(t.to)}`;
    case 'contact.created':
      return t.source === 'import' ? 'When a contact is imported' : t.source === 'manual' ? 'When a contact is added by hand' : 'When a contact is added';
    case 'deal.stage_reached':
      return `When a deal reaches ${STAGE_WORDS[t.to]} — the ${t.who}`;
    case 'deal.settled':
      return `When a deal settles — the ${t.who}`;
    case 'buyer.matched':
      return 'When a new listing fits a buyer’s brief — the buyer';
    case 'appointment.upcoming': {
      const when = t.hours % 24 === 0 ? `${t.hours / 24} day${t.hours === 24 ? '' : 's'}` : `${t.hours} hour${t.hours === 1 ? '' : 's'}`;
      return `${when} before ${t.type ? art(STATUS(t.type)) : 'an appointment with a contact'} starts`;
    }
    case 'appointment.completed':
      return t.type ? `When ${art(STATUS(t.type))} appointment is completed` : 'When an appointment with a contact is completed';
    case 'appraisal.not_listed':
      return `When an appraisal has had no listing for ${t.days} day${t.days === 1 ? '' : 's'} — the owner`;
    case 'sale.anniversary':
      return `${t.years === 1 ? 'A year' : `${t.years} years`} to the day after we sold an address — its owners and buyer`;
    case 'call.missed':
      return t.caller === 'new' ? 'When a call from a number not in Contacts is missed' : t.caller === 'known' ? 'When a call from a contact is missed' : 'When a call is missed';
  }
}

const STAGE_WORDS: Record<(typeof DEAL_TRIGGER_STAGES)[number], string> = {
  appraisal: 'Appraisal', listing: 'Listing', marketing: 'Marketing', offers: 'Offers', negotiation: 'Negotiation', contract: 'Contract', settlement: 'Settlement',
};

// ── The guide on the Automations tab (ADR 0066, docs/mocks/workflow-triggers.html) ─────────

export const TRIGGER_GROUPS = ['Leads and contacts', 'Deals', 'Listings and buyers', 'Appointments', 'Past clients', 'Calls'] as const;
export type TriggerGroup = (typeof TRIGGER_GROUPS)[number];
export type TriggerGuide = { group: TriggerGroup; icon: string; title: string; description: string; example: string | null; isNew: boolean };

/** What each trigger is, in the person's words, with something they might say to the assistant. Pure data. */
export const TRIGGER_GUIDE: Record<TriggerKind, TriggerGuide> = {
  'lead.created': { group: 'Leads and contacts', icon: 'mail', title: 'A new lead arrives', description: 'From the website or recorded by hand.', example: null, isNew: false },
  'lead.status_changed': { group: 'Leads and contacts', icon: 'swap_horiz', title: 'A lead’s status changes', description: 'New, contacted, qualified, closed.', example: null, isNew: false },
  'lead.no_reply': { group: 'Leads and contacts', icon: 'schedule', title: 'No reply for N days', description: 'A buyer’s message still unanswered (1 to 14 days).', example: null, isNew: false },
  'contact.created': { group: 'Leads and contacts', icon: 'person_add', title: 'A contact is added', description: 'By hand or by an import.', example: null, isNew: false },
  'deal.stage_reached': {
    group: 'Deals', icon: 'flag', title: 'A deal reaches a stage', isNew: true,
    description: 'Any of the seven — by itself or moved by someone. The vendor or the buyer, you choose.',
    example: 'When a deal goes to Contract, email the buyer our conveyancing checklist.',
  },
  'deal.settled': {
    group: 'Deals', icon: 'handshake', title: 'A deal settles', isNew: true,
    description: 'When someone presses Settle on the Deal tab. The vendor or the buyer, you choose.',
    example: 'When a sale settles, draft a thank-you to the vendor, then a review request a week later.',
  },
  'listing.status_changed': { group: 'Listings and buyers', icon: 'sell', title: 'A listing’s status changes', description: 'Live, under offer, sold, withdrawn.', example: null, isNew: false },
  'buyer.matched': {
    group: 'Listings and buyers', icon: 'join_inner', title: 'A new listing fits a buyer’s brief', isNew: true,
    description: 'When a listing goes live: once for each buyer whose brief it fits — the same match as the listing’s Matching buyers tab. Only buyers who may be emailed get a template.',
    example: 'When a new sale listing matches a buyer, send them “Just listed for you” in office hours.',
  },
  'appointment.booked': { group: 'Appointments', icon: 'event_available', title: 'An appointment is booked', description: 'Optionally one type.', example: null, isNew: false },
  'appointment.upcoming': {
    group: 'Appointments', icon: 'alarm', title: 'N hours before an appointment', isNew: true,
    description: '1 to 72 hours before it starts; not for one that was cancelled, and a moved one counts from its new time.',
    example: 'A day before every inspection, send the client the “See you tomorrow” template.',
  },
  'appointment.completed': {
    group: 'Appointments', icon: 'task_alt', title: 'An appointment is completed', isNew: true,
    description: 'When it is marked done.',
    example: 'After a private inspection is done, remind me to call them the next morning.',
  },
  'appraisal.not_listed': {
    group: 'Appointments', icon: 'hourglass_bottom', title: 'An appraisal with no listing after N days', isNew: true,
    description: 'An appraisal held N days ago (1 to 30) and nothing listed at that address since.',
    example: 'If an appraisal hasn’t turned into a listing in a week, remind me.',
  },
  'sale.anniversary': {
    group: 'Past clients', icon: 'cake', title: 'A sale’s anniversary', isNew: true,
    description: '1 to 20 years after we sold an address, on the day — to its owners and the deal’s buyer (never the vendor).',
    example: 'Every year on the day we sold their home, send past clients “Happy home anniversary”.',
  },
  'call.missed': {
    group: 'Calls', icon: 'phone_missed', title: 'A call is missed', isNew: true,
    description: 'A call an agent didn’t answer, forwarded to their number (Phone & SMS). From a contact, from a new number, or either. A new number has no contact yet, so only reminders and messages to colleagues.',
    example: 'When I miss a call from a new number, remind me to call them back within the hour.',
  },
};

const km = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)} km`;

/** `names` turns member, listing and template ids into names, from the database, for the words. */
export function conditionInWords(c: Condition, names: Record<string, string> = {}): string {
  if (isNear(c)) return `the listing is within ${km(c.km)} of ${c.place.label} (listings without a map pin never match)`;
  const vals = c.values.map((v) => names[v] ?? (c.field === 'listing.suburb' ? v : c.field === 'contact.name' ? `“${v}”` : c.field === 'listing' ? 'a listing' : VALUE_WORDS[v] ?? STATUS(v)));
  const list = vals.length > 1 ? `${vals.slice(0, -1).join(', ')} or ${vals[vals.length - 1]}` : vals[0]!;
  const verb = { eq: 'is', in: 'is', not_in: 'is not', contains: 'contains', not_contains: 'does not contain' }[c.op];
  return `${FIELD_LABELS[c.field]} ${verb} ${list}`;
}

const DAY_SHORT: Record<(typeof WEEKDAYS)[number], string> = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };
function clockWords(t: string): string {
  const m = minuteOf(t);
  const h = Math.floor(m / 60);
  return `${((h + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}
function daysWords(days: readonly (typeof WEEKDAYS)[number][] | undefined): string {
  if (!days || days.length === 7) return 'any day';
  const set = new Set(days);
  if (set.size === 5 && ['mon', 'tue', 'wed', 'thu', 'fri'].every((d) => set.has(d as never))) return 'Monday to Friday';
  return WEEKDAYS.filter((d) => set.has(d)).map((d) => DAY_SHORT[d]).join(', ');
}

export function actionInWords(a: WorkflowAction, names: Record<string, string> = {}): string {
  switch (a.type) {
    case 'add_note':
      return `Add a note: “${a.text}”`;
    case 'set_next_action':
      return `Set the next action “${a.text}”, due ${a.in_days === 0 ? 'the same day' : `in ${a.in_days} day${a.in_days === 1 ? '' : 's'}`}`;
    case 'remind_owner':
      return `Remind you: “${a.text}”${a.mail_me ? ' (also by email)' : ''}`;
    case 'set_lead_status':
      return `Mark the lead ${STATUS(a.to)}`;
    case 'assign_lead':
      return `Give the lead to ${names[a.to] ?? 'a team member'}`;
    case 'assign_contact':
      return `Give the contact to ${names[a.to] ?? 'a team member'}`;
    case 'message_colleagues':
      return `Message ${a.to.map((id) => names[id] ?? 'a colleague').join(', ')}: “${a.subject}”`;
    case 'send_template_email':
      return `Send the template “${names[a.template_id] ?? 'template'}” to the contact (only if they may receive it then)`;
    case 'draft_email':
      return `Write an email draft for you to approve, about: “${a.instructions}”`;
    case 'wait':
      return a.hours % 24 === 0 ? `Wait ${a.hours / 24} day${a.hours === 24 ? '' : 's'}` : `Wait ${a.hours} hour${a.hours === 1 ? '' : 's'}`;
    case 'wait_until':
      return a.to
        ? `Wait until ${clockWords(a.from)}–${clockWords(a.to)}, ${daysWords(a.days)} (the agency’s time) — at once if it already is`
        : `Wait until the next ${clockWords(a.from)}, ${daysWords(a.days)} (the agency’s time)`;
  }
}

export type SpecWords = {
  when: string;
  if: string[];
  /** The steps — or, with a decision, the "Not sure" steps. */
  then: string[];
  decide?: { question: string; choices: { label: string; then: string[] }[] };
};

export function specInWords(spec: WorkflowSpec, names: Record<string, string> = {}): SpecWords {
  return {
    when: triggerInWords(spec.trigger),
    if: spec.conditions.map((c) => conditionInWords(c, names)),
    then: spec.actions.map((a) => actionInWords(a, names)),
    ...(spec.decide
      ? { decide: { question: spec.decide.question, choices: spec.decide.choices.map((c) => ({ label: c.label, then: c.actions.map((a) => actionInWords(a, names)) })) } }
      : {}),
  };
}
