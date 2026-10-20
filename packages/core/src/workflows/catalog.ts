import { z } from 'zod';
import { CONTACT_ROLES } from '../contacts/contact-schema';

/**
 * The workflow catalog (ADR 0041 Part B): every trigger, condition and action a workflow may be made
 * of. A workflow is a SPEC of these — validated here, run by the engine — never code or SQL. Pure:
 * the assistant's card, the screen and the engine all read this one file.
 */

// ── Triggers ────────────────────────────────────────────────────────────────

export const TRIGGER_KINDS = ['lead.created', 'lead.status_changed', 'lead.no_reply', 'appointment.booked', 'listing.status_changed', 'contact.created'] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'closed'] as const;
const LISTING_STATUSES = ['live', 'under_offer', 'sold', 'withdrawn'] as const;
const APPOINTMENT_TYPES = ['appraisal', 'phone_call', 'zoom', 'inspection', 'meeting'] as const;

export const triggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('lead.created'), source: z.enum(['website', 'manual']).optional() }).strict(),
  z.object({ kind: z.literal('lead.status_changed'), to: z.enum(LEAD_STATUSES) }).strict(),
  z.object({ kind: z.literal('lead.no_reply'), days: z.number().int().min(1).max(14) }).strict(),
  z.object({ kind: z.literal('appointment.booked'), type: z.enum(APPOINTMENT_TYPES).optional() }).strict(),
  z.object({ kind: z.literal('listing.status_changed'), to: z.enum(LISTING_STATUSES) }).strict(),
  z.object({ kind: z.literal('contact.created'), source: z.enum(['manual', 'import']).optional() }).strict(),
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
};

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

export const workflowSpecSchema = z
  .object({
    trigger: triggerSchema,
    conditions: z.array(conditionSchema).max(WORKFLOW_LIMITS.conditions).default([]),
    actions: z.array(actionSchema).min(1).max(WORKFLOW_LIMITS.actions),
  })
  .strict();
export type WorkflowSpec = z.infer<typeof workflowSpecSchema>;
export type WorkflowScope = 'mine' | 'agency';

/**
 * Everything the schema cannot say: an action or a condition its trigger has no record for, a
 * value not in a field's list, an admin-only action on a personal workflow, a `wait` with nothing
 * after it. Null when the spec is usable. The message names the part, so it can be fixed.
 */
export function specProblem(spec: WorkflowSpec, scope: WorkflowScope): string | null {
  const has = TRIGGER_RECORDS[spec.trigger.kind];
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
  for (const [i, a] of spec.actions.entries()) {
    const need = ACTION_NEEDS[a.type];
    if (need && !has[need]) return `Action ${i + 1} (${ACTION_WORDS[a.type]}): a “${TRIGGER_WORDS[spec.trigger.kind]}” workflow has no ${need} to act on`;
    if (scope === 'mine' && AGENCY_ONLY_ACTIONS.includes(a.type)) return `Action ${i + 1} (${ACTION_WORDS[a.type]}): only an agency-wide workflow (owners and admins) may assign`;
    if (a.type === 'wait_until') {
      const next = spec.actions[i + 1];
      if (!next) break;
      if (WAITS.includes(next.type)) return `Action ${i + 1} (wait for a time): put any wait before it — the step after it must be a real step`;
      if (a.to !== undefined && minuteOf(a.to) <= minuteOf(a.from)) return `Action ${i + 1} (wait for a time): “to” must be later than “from” on the same day`;
      if (a.days && new Set(a.days).size !== a.days.length) return `Action ${i + 1} (wait for a time): a day is named twice`;
    }
  }
  const last = spec.actions[spec.actions.length - 1]!;
  if (WAITS.includes(last.type)) return 'A workflow cannot end with a wait — say what happens after it';
  if (spec.actions.every((a) => WAITS.includes(a.type))) return 'Give at least one action';
  // A wait_until holds a step back less than a week; the run's task lives 30 days.
  if (spec.actions.reduce((h, a) => h + (a.type === 'wait' ? a.hours : a.type === 'wait_until' ? 7 * 24 : 0), 0) > 29 * 24) return 'All the waits together must be under 29 days (a wait for a time counts as up to 7)';
  return null;
}

// ── Merge fields: filled from the database when an action runs, never by the model ─────────

export const MERGE_FIELDS = ['contact_name', 'contact_first_name', 'listing_address', 'agent_name'] as const;
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
      return t.type ? `When a ${STATUS(t.type)} appointment is booked` : 'When an appointment with a contact is booked';
    case 'listing.status_changed':
      return `When a listing becomes ${STATUS(t.to)}`;
    case 'contact.created':
      return t.source === 'import' ? 'When a contact is imported' : t.source === 'manual' ? 'When a contact is added by hand' : 'When a contact is added';
  }
}

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

export function specInWords(spec: WorkflowSpec, names: Record<string, string> = {}): { when: string; if: string[]; then: string[] } {
  return { when: triggerInWords(spec.trigger), if: spec.conditions.map((c) => conditionInWords(c, names)), then: spec.actions.map((a) => actionInWords(a, names)) };
}
