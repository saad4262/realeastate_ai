import { z } from 'zod';
import { CONTACT_ROLES } from '../contacts/contact-schema';
import { INTEGRATION_PROVIDERS, type IntegrationProvider } from '../integrations/providers';
import { WIDGET_IDS, WIDGET_RANGES, type WidgetId, type WidgetTile } from '../widgets/registry';
import { DATASET_IDS, tileSpecSchema, type DatasetId } from '../semantic';
import { openTileSchema } from '../open-query/tile';
import { QUERY_MAX_CHARS } from '../open-query/guard';
import { AU_STATES, PROPERTY_TYPES } from '../listings/listing-schema';
import { SKILL_KEYS } from '../skill-switches/catalog';

/**
 * The console assistant's contract (docs/adr/0025). Phase A: read tools only.
 *
 * Everything the model may send is parsed here, and nothing it sends is a
 * database id. Rows are named by HANDLES — `C3`, `L1`, `A2`, `T1`, `S1` —
 * that the server issued to this conversation when a read tool returned the
 * row (or, for `S`, when the person selected it in the UI). A handle the
 * server never issued, or one for a row this person may no longer see, finds
 * nothing. A UUID, a name or an email address is not a handle and fails the
 * schema, so text in a contact's name or a listing's address can never be
 * turned into a reference to something the person was not shown.
 */

export const HANDLE_KINDS = {
  C: 'contact',
  L: 'lead',
  A: 'appointment',
  T: 'template',
  /** A contact the person selected in the console (the page they are on). */
  S: 'contact',
  /** A member of the agency — issued by find_team_members (owners/admins) and find_colleagues (everyone). */
  M: 'member',
  /** A pending agent invite — issued only by find_agents (owners/admins, ADR 0033). */
  I: 'invite',
  /** A listing — issued by find_listings (ADR 0040). */
  P: 'listing',
  /** An assistant task — issued by plan_task (ADR 0040). */
  K: 'task',
  /** One of the person's OWN saved contact lists — issued by find_saved_lists (ADR 0040 part 2). */
  F: 'filter',
  /** A skill of the library this person may use — issued by find_skills (ADR 0041). Their own copy is found by it. */
  Q: 'skill',
  /** A workflow this person may see — issued by find_workflows (ADR 0041 Part C). */
  W: 'workflow',
  /** A document this person may see — issued by search_documents (ADR 0053). */
  D: 'document',
} as const;
export type HandlePrefix = keyof typeof HANDLE_KINDS;
export type HandleKind = (typeof HANDLE_KINDS)[HandlePrefix];

export const handleSchema = z
  .string()
  .trim()
  .regex(/^[CLATSMIPKFQWD][1-9][0-9]{0,2}$/, 'Not a reference the assistant was given');

/** A handle that must name an appointment. */
export const appointmentHandleSchema = handleSchema.refine((h) => h.startsWith('A'), { message: 'Not an appointment reference' });

/** A handle that must name an approved template (from list_templates). */
export const templateHandleSchema = handleSchema.refine((h) => h.startsWith('T'), { message: 'Not a template reference' });

/** A handle that must name a contact. */
export const contactHandleSchema = handleSchema.refine((h) => h.startsWith('C') || h.startsWith('S'), {
  message: 'Not a contact reference',
});

/** A handle that must name a team member (from find_team_members). */
export const leadHandleSchema = handleSchema.refine((h) => h.startsWith('L'), { message: 'Not a lead reference' });
export const listingHandleSchema = handleSchema.refine((h) => h.startsWith('P'), { message: 'Not a listing reference' });
export const taskHandleSchema = handleSchema.refine((h) => h.startsWith('K'), { message: 'Not a task reference' });
export const listHandleSchema = handleSchema.refine((h) => h.startsWith('F'), { message: 'Not a saved list reference' });
export const memberHandleSchema = handleSchema.refine((h) => h.startsWith('M'), { message: 'Not a team member reference' });

/** A handle that must name a team member or a pending invite (from find_agents). */
export const agentHandleSchema = handleSchema.refine((h) => h.startsWith('M') || h.startsWith('I'), { message: 'Not a team member or invite reference' });

/** Caps that hold however the model asks (ADR 0025 §4, §10; decided Q7). */
export const ASSISTANT_LIMITS = {
  /** Tool calls in one turn, across every round. */
  toolCallsPerTurn: 8,
  /** …in a turn that works through a question with describe_data / query_data (ADR 0042 Part D; 30 for a request of many parts, ADR 0044 E). */
  toolCallsPerAnalysisTurn: 30,
  /** Output tokens a round may write once the turn works through data: a dashboard of many open tiles carries every query (ADR 0044 E). */
  outputTokensPerAnalysisRound: 32000,
  /** Items of a request a dashboard card accounts for (ADR 0044 A). */
  coverageItems: 24,
  /** Rows a read tool returns. */
  rowsPerTool: 20,
  /** Turns in one conversation. History is replayed append-only and never trimmed; a long one starts afresh. */
  turnsPerConversation: 30,
  /** Characters the person may type in one message. */
  messageChars: 2000,
  /** Contacts a selection may carry. */
  selection: 20,
  /** Days a conversation is kept after its last turn (decided Q5). */
  retentionDays: 30,
  /** Write proposals in one turn (ADR 0025 §4). */
  proposalsPerTurn: 3,
  /** Hours a proposal waits for Approve before it expires (as ADR 0022's batches). */
  proposalHours: 48,
  /** Contacts one assign or consent card may change — never "all" or a filter. */
  contactsPerCard: 20,
} as const;

const limit = z.number().int().min(1).max(ASSISTANT_LIMITS.rowsPerTool).default(10);
const text = z.string().trim().min(1).max(80);

export const findContactsInput = z
  .object({
    text: text.optional(),
    role: z.enum(CONTACT_ROLES).optional(),
    /** `me`: only contacts assigned to the person. Anything else: everyone they may see. */
    assigned: z.enum(['me', 'any']).default('any'),
    include_archived: z.boolean().default(false),
    limit,
  })
  .strict();

export const LEAD_SINCE = ['today', '7d', '30d', '90d'] as const;
export const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'closed'] as const;

export const findLeadsInput = z
  .object({
    status: z.enum(LEAD_STATUSES).optional(),
    since: z.enum(LEAD_SINCE).optional(),
    /** Part of the listing's address or suburb. */
    listing_text: text.optional(),
    contact: contactHandleSchema.optional(),
    limit,
  })
  .strict();

export const APPOINTMENT_RANGES = ['today', 'tomorrow', 'next_7_days', 'upcoming', 'past_30_days'] as const;
export type AppointmentRange = (typeof APPOINTMENT_RANGES)[number];

export const findAppointmentsInput = z
  .object({
    range: z.enum(APPOINTMENT_RANGES).default('upcoming'),
    contact: contactHandleSchema.optional(),
    limit,
  })
  .strict();

export const listTemplatesInput = z.object({}).strict();

/**
 * Search what was WRITTEN — notes, emails, enquiry messages (ADR 0031).
 * Returns references and short snippets only; the snippets are untrusted text.
 */
export const searchNotesAndEmailsInput = z
  .object({
    query: z.string().trim().min(2).max(200),
    contact: z.string().trim().regex(/^[CS][1-9][0-9]{0,2}$/, 'Not a contact reference').optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date as YYYY-MM-DD').optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date as YYYY-MM-DD').optional(),
  })
  .strict();

/** ADR 0053: search the documents (and the knowledge base) this person may read. */
export const searchDocumentsInput = z
  .object({
    query: z.string().trim().min(2).max(200),
    contact: z.string().trim().regex(/^[CS][1-9][0-9]{0,2}$/, 'Not a contact reference').optional(),
    knowledge_only: z.boolean().optional(),
  })
  .strict();

/** ADR 0053: pages of one document search_documents returned (a `D` reference). */
export const readDocumentInput = z
  .object({
    document: z.string().trim().regex(/^D[1-9][0-9]{0,2}$/, 'Not a document reference'),
    from_page: z.number().int().min(1).max(2000).optional(),
    to_page: z.number().int().min(1).max(2000).optional(),
  })
  .strict();

export const checkConnectionsInput = z
  .object({
    providers: z.array(z.enum(INTEGRATION_PROVIDERS)).min(1).max(INTEGRATION_PROVIDERS.length),
  })
  .strict();

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date as YYYY-MM-DD');
const timeString = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time as HH:mm, 24-hour');

/**
 * WRITE tools (Phases B and C). None of them writes: each resolves its
 * references, checks the person may, and stores a `proposed_action` with the
 * frozen, resolved arguments. Only the person's Approve runs it.
 */
export const addNoteInput = z
  .object({
    contact: contactHandleSchema,
    body: z.string().trim().min(1).max(5000),
    /** Private: only its author and admins can read it — the existing note rule. */
    private: z.boolean().default(false),
  })
  .strict();

export const setNextActionInput = z
  .object({
    contact: contactHandleSchema,
    /** Empty clears it. */
    text: z.string().trim().max(300),
    date: dateString.optional(),
    time: timeString.optional(),
  })
  .strict();

export const ASSISTANT_APPOINTMENT_TYPES = ['appraisal', 'phone_call', 'zoom', 'inspection', 'meeting'] as const;

export const scheduleAppointmentInput = z
  .object({
    contact: contactHandleSchema,
    type: z.enum(ASSISTANT_APPOINTMENT_TYPES),
    title: z.string().trim().min(1).max(160),
    date: dateString,
    time: timeString,
    duration_minutes: z.number().int().min(15).max(480).optional(),
    location: z.string().trim().max(300).optional(),
    send_invitation: z.boolean().optional(),
  })
  .strict();

export const rescheduleAppointmentInput = z
  .object({
    appointment: appointmentHandleSchema,
    date: dateString,
    time: timeString,
    duration_minutes: z.number().int().min(15).max(480).optional(),
  })
  .strict();

export const cancelAppointmentInput = z
  .object({
    appointment: appointmentHandleSchema,
    reason: z.string().trim().max(1000).optional(),
  })
  .strict();

/**
 * Phase D: send an approved template to contacts the person picked or found.
 * Recipients are REFERENCES only (C… from a result, S… from the console
 * selection) — there is no field for an address, a name or a filter.
 */
export const sendTemplateEmailInput = z
  .object({
    template: templateHandleSchema,
    recipients: z.array(contactHandleSchema).min(1).max(20).optional(),
    /** ADR 0040 part 2 §2: one of the person's OWN saved lists (an F reference) — never a query. */
    list: listHandleSchema.optional(),
  })
  .strict()
  .refine((v) => Boolean(v.recipients) !== Boolean(v.list), { message: 'Give either recipients or a list, not both', path: ['recipients'] });

/**
 * A list larger than one batch (ADR 0040 part 2 §2, decided option a): one card, at most
 * `maxPeople`, sent in parts of the batch size — the first at once, each later one `gapHours`
 * after the one before.
 */
export const LIST_SEND = { maxPeople: 100, gapHours: 24 } as const;

/** The person's own saved contact lists (the Bulk email screen's), as F references. Read only. */
export const findSavedListsInput = z.object({}).strict();

/**
 * Importing (ADR 0039 Phase 3, ADR 0029 amendment): puts the import's own buttons beside the answer —
 * upload a CSV/Excel file, or pick a Google Sheet. Nothing is read or written by the tool; the person
 * goes on through the import screens (match, check, import), and the model never sees a row.
 */
export const startImportInput = z.object({ what: z.enum(['listings', 'contacts']) }).strict();

// ── ADR 0041 Part A: skills from plain language ──────────────────────────────

export const skillHandleSchema = handleSchema.refine((h) => h.startsWith('Q'), { message: 'Not a skill reference' });
/** When a skill runs, on the person's clock (their browser's zone, from console_context). */
export const skillScheduleInput = z
  .object({
    cadence: z.enum(['daily', 'weekly', 'interval']),
    /** HH:mm, 24-hour. For `interval`, ignored. */
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time as HH:mm, 24-hour').default('07:00'),
    weekday: z.enum(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']).optional(),
    every_minutes: z.number().int().min(10).max(1440).optional(),
  })
  .strict()
  .refine((v) => v.cadence !== 'weekly' || v.weekday, { message: 'A weekly skill needs a weekday', path: ['weekday'] })
  .refine((v) => v.cadence !== 'interval' || v.every_minutes, { message: 'An interval skill needs every_minutes', path: ['every_minutes'] });
export const findSkillsInput = z.object({}).strict();

// ── ADR 0041 Part C: workflows by the assistant ──────────────────────────────

export const workflowHandleSchema = handleSchema.refine((h) => h.startsWith('W'), { message: 'Not a workflow reference' });
/**
 * A workflow as the model writes it: the catalog's parts (packages/core/src/workflows/catalog.ts) with
 * REFERENCES where the stored spec has ids — `member`/`members` (M), `template` (T). Flat objects with
 * a `type`/`kind`; the server checks each against the catalog and names the part that is wrong.
 * `lead_status`, never `status` or `to`: no field here reads as a card's status or a recipient.
 */
export const workflowTriggerInput = z
  .object({
    kind: z.enum(['lead.created', 'lead.status_changed', 'lead.no_reply', 'appointment.booked', 'listing.status_changed', 'contact.created']),
    source: z.enum(['website', 'manual', 'import']).optional(),
    lead_status: z.enum(['new', 'contacted', 'qualified', 'closed']).optional(),
    listing_status: z.enum(['live', 'under_offer', 'sold', 'withdrawn']).optional(),
    days: z.number().int().min(1).max(14).optional(),
    appointment_type: z.enum(['appraisal', 'phone_call', 'zoom', 'inspection', 'meeting']).optional(),
  })
  .strict();
export const workflowConditionInput = z
  .object({
    field: z.enum(['listing.suburb', 'listing.channel', 'lead.kind', 'lead.source', 'assignee', 'contact.role', 'appointment.type', 'contact.name', 'listing', 'listing.near']),
    op: z.enum(['eq', 'in', 'not_in', 'contains', 'not_contains', 'within']),
    /**
     * Words from the field's list, a suburb or name as the person said it, M references for `assignee`,
     * P references for `listing`, or for `listing.near` ONE place name — the server finds it on the map.
     */
    values: z.array(z.string().trim().min(1).max(80)).min(1).max(20),
    /** `listing.near` only: the distance the person said, in km. */
    km: z.number().min(0.1).max(100).optional(),
  })
  .strict();
export const workflowActionInput = z
  .object({
    type: z.enum(['add_note', 'set_next_action', 'remind_owner', 'set_lead_status', 'assign_lead', 'assign_contact', 'message_colleagues', 'send_template_email', 'draft_email', 'wait', 'wait_until']),
    text: z.string().trim().min(1).max(2000).optional(),
    in_days: z.number().int().min(0).max(60).optional(),
    mail_me: z.boolean().optional(),
    lead_status: z.enum(['new', 'contacted', 'qualified', 'closed']).optional(),
    member: memberHandleSchema.optional(),
    members: z.array(memberHandleSchema).min(1).max(10).optional(),
    subject: z.string().trim().min(1).max(200).optional(),
    body: z.string().trim().min(1).max(2000).optional(),
    template: templateHandleSchema.optional(),
    instructions: z.string().trim().min(1).max(1000).optional(),
    hours: z.number().int().min(1).max(720).optional(),
    /** wait_until: HH:mm on the agency's clock; with `until`, a window. `days` default every day. Never `to`: nothing here reads as a recipient. */
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time as HH:mm, 24-hour').optional(),
    until: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time as HH:mm, 24-hour').optional(),
    days: z.array(z.enum(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'])).min(1).max(7).optional(),
  })
  .strict();
export const createWorkflowInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    /** `mine`: only the person's own leads and contacts. `agency`: the whole agency — owners and admins only. */
    scope: z.enum(['mine', 'agency']).default('mine'),
    trigger: workflowTriggerInput,
    conditions: z.array(workflowConditionInput).max(5).default([]),
    actions: z.array(workflowActionInput).min(1).max(6),
    /** A W reference: replace that workflow (a new version) instead of making another. */
    replaces: workflowHandleSchema.optional(),
  })
  .strict();
export const findWorkflowsInput = z.object({}).strict();
/**
 * ADR 0048: a new email template written for the person — the exact words on the card, saved on
 * Approve as the Bulk email screen saves one. Merge fields are the templates' own ({{first_name}} …).
 */
export const createTemplateInput = z
  .object({
    name: z.string().trim().min(2).max(80),
    subject: z.string().trim().min(1).max(160),
    body: z.string().trim().min(1).max(8000),
  })
  .strict();
export const changeWorkflowInput = z.object({ workflow: workflowHandleSchema, change: z.enum(['pause', 'resume', 'archive']) }).strict();
export const setUpSkillInput = z.object({ skill: skillHandleSchema, schedule: skillScheduleInput.optional(), mail_me: z.boolean().optional() }).strict();
/** One of the person's own skills: only what is named changes. `instructions` is the whole new text under the front-matter. */
export const changeSkillInput = z
  .object({
    skill: skillHandleSchema,
    on: z.boolean().optional(),
    schedule: skillScheduleInput.optional(),
    mail_me: z.boolean().optional(),
    instructions: z.string().trim().min(1).max(6000).optional(),
  })
  .strict()
  .refine((v) => v.on !== undefined || v.schedule || v.mail_me !== undefined || v.instructions, { message: 'Say what to change: on/off, the schedule, mail_me, or the instructions' });

/** A platform skill's switch (ADR 0058): its key from find_skills' platform_skills, and on or off. */
export const switchSkillInput = z.object({ skill: z.enum(SKILL_KEYS), on: z.boolean() }).strict();

/**
 * Dashboards (ADR 0027 / 0025 Phase F). A widget is an id from the fixed
 * registry and, where it has one, a range — never code, SQL or a figure. Or
 * `custom` with a tile SPEC (ADR 0036 Phase 3): ids from the semantic catalog
 * only, checked here with the catalog's own error (which lists the valid ids,
 * so the model can correct itself).
 */
const widgetChoice = z
  .object({
    widget: z.enum(WIDGET_IDS as [WidgetId, ...WidgetId[]]),
    range: z.enum(WIDGET_RANGES).optional(),
    spec: z.record(z.unknown()).optional(),
    /** ADR 0042: an open tile — the query you ran with query_data, its title, explanation and how to draw it. */
    open: z.record(z.unknown()).optional(),
  })
  .strict()
  .superRefine((w, ctx) => {
    if (w.widget === 'open') {
      if (w.spec) ctx.addIssue({ code: 'custom', path: ['spec'], message: 'An open tile takes `open`, not a spec' });
      if (!w.open) return ctx.addIssue({ code: 'custom', path: ['open'], message: 'An open tile needs `open`: { title, explanation, sql, viz, rows_are, columns }' });
      const p = openTileSchema.safeParse(w.open);
      if (!p.success) {
        const issue = p.error.issues[0];
        ctx.addIssue({ code: 'custom', path: ['open', ...(issue?.path ?? [])], message: issue?.message ?? 'Not a valid open tile' });
      }
      return;
    }
    if (w.open) ctx.addIssue({ code: 'custom', path: ['open'], message: 'Only the open widget takes `open`' });
    if (w.widget !== 'custom') {
      if (w.spec) ctx.addIssue({ code: 'custom', path: ['spec'], message: 'Only the custom widget takes a spec' });
      return;
    }
    if (!w.spec) return ctx.addIssue({ code: 'custom', path: ['spec'], message: 'A custom widget needs a spec' });
    const p = tileSpecSchema.safeParse(w.spec);
    if (!p.success) {
      const issue = p.error.issues[0];
      ctx.addIssue({ code: 'custom', path: ['spec', ...(issue?.path ?? [])], message: issue?.message ?? 'Not a valid spec' });
    }
  });
export type WidgetChoice = z.infer<typeof widgetChoice>;
/** What a widget choice is stored as: a fixed widget's range, or a custom tile's spec. */
export function widgetChoiceParams(w: WidgetChoice): Record<string, unknown> {
  if (w.widget === 'custom') return w.spec ?? {};
  if (w.widget === 'open') return w.open ?? {};
  return w.range ? { range: w.range } : {};
}
export const showWidgetInput = widgetChoice;

/**
 * Open questions (ADR 0042). `describe_data` gives the data dictionary; `query_data` runs ONE
 * read-only SELECT over the named datasets, as this person, through every lock. Neither
 * changes anything; a tile is saved only by create_dashboard's card.
 */
export const describeDataInput = z.object({}).strict();
export const queryDataInput = z
  .object({
    sql: z.string().trim().min(1).max(QUERY_MAX_CHARS),
    /** What this run is for, in a few words ("leads per day, last 30 days"): shown to the person as the step. */
    purpose: z.string().trim().max(120).optional(),
  })
  .strict();

/**
 * The gap log (ADR 0036 decided Q2): a figure the catalog cannot make. The
 * model records the person's request and what it found nearest; nothing is
 * approximated, and nothing is shown to anyone but the platform team.
 */
// ── ADR 0040: CRM tools and tasks ─────────────────────────────────────────────

export const LISTING_STATUSES_FOR_FIND = ['draft', 'pending', 'live', 'under_offer', 'sold', 'withdrawn'] as const;
/** The listings this person's figures cover (an agent: theirs; an owner/admin: the agency's). Read only. */
export const findListingsInput = z
  .object({
    /** Part of the address or suburb. */
    text: text.optional(),
    status: z.enum(LISTING_STATUSES_FOR_FIND).optional(),
    limit,
  })
  .strict();

/**
 * Buyers whose brief fits a property (ADR 0059): a listing (P) OR the property in words, never both.
 * Prices in whole dollars; per week for rent. "Under $800k" is price_to, "from $700k" price_from.
 */
const DOLLARS = z.number().int().min(0).max(100_000_000);
export const findBuyersInput = z
  .object({
    listing: listingHandleSchema.optional(),
    channel: z.enum(['sale', 'rent']).optional(),
    suburb: z.string().trim().min(1).max(60).optional(),
    price_from: DOLLARS.optional(),
    price_to: DOLLARS.optional(),
    bedrooms: z.number().int().min(0).max(20).optional(),
    bathrooms: z.number().min(0).max(20).optional(),
    property_type: z.enum(PROPERTY_TYPES).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict()
  // One refinement, so the object is one layer in (the tool definitions are compared with its shape).
  .superRefine((v, ctx) => {
    const words = [v.suburb, v.price_from, v.price_to, v.bedrooms, v.bathrooms, v.property_type];
    if (v.listing && (v.channel !== undefined || words.some((x) => x !== undefined))) ctx.addIssue({ code: 'custom', message: 'Give a listing OR the property in words, not both' });
    if (!v.listing && words.every((x) => x === undefined)) ctx.addIssue({ code: 'custom', message: 'Say what the property is: a listing (P reference), or a suburb, price, bedrooms, bathrooms or type' });
    if (v.price_from !== undefined && v.price_to !== undefined && v.price_from > v.price_to) ctx.addIssue({ code: 'custom', path: ['price_from'], message: 'price_from is above price_to' });
  });

/** `stage`, not `status`: no write tool has a field that could read as a card's own status. */
export const setLeadStatusInput = z.object({ lead: leadHandleSchema, stage: z.enum(LEAD_STATUSES) }).strict();
/** Owners/admins (`lead:assign`): give a lead to a member found with find_team_members. */
export const assignLeadInput = z.object({ lead: leadHandleSchema, to: memberHandleSchema }).strict();
export const createLeadInput = z
  .object({
    contact: contactHandleSchema,
    listing: listingHandleSchema,
    kind: z.enum(['enquiry', 'inspection', 'appraisal']).default('enquiry'),
    /** What they asked, in the person's words. */
    message: z.string().trim().max(2000).optional(),
  })
  .strict();
export const createContactInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(200).optional(),
    phone: z.string().trim().min(6).max(40).optional(),
    roles: z.array(z.enum(CONTACT_ROLES)).max(CONTACT_ROLES.length).default([]),
  })
  .strict()
  .refine((v) => v.email || v.phone, { message: 'Give an email or a phone number', path: ['email'] });

/** A reminder to the person themselves (ADR 0040 decided Q3): the bell always, email only when asked. */
/** `mail_me`, not `email`: it only ever means the person's OWN address. */
export const remindStepInput = z.object({ text: z.string().trim().min(1).max(300), mail_me: z.boolean().default(false) }).strict();
export const createReminderInput = z
  .object({ text: z.string().trim().min(1).max(300), date: dateString, time: timeString, mail_me: z.boolean().default(false) })
  .strict();

/** The write tools a task step may be (ADR 0040). Not the bulk template email (its batch lives 48 h), not a dashboard, not a team change. */
export const PLANNABLE_TOOLS = [
  'add_note',
  'set_next_action',
  'schedule_appointment',
  'reschedule_appointment',
  'cancel_appointment',
  'send_email',
  'message_colleagues',
  'schedule_team_meeting',
  'record_marketing_consent',
  'withdraw_marketing_consent',
  'update_contact',
  'set_contact_archived',
  'assign_contacts',
  'set_lead_status',
  'assign_lead',
  'create_lead',
  'create_contact',
  'create_listing_draft',
  'update_listing',
  'withdraw_listing',
  'submit_listing',
  'remind',
] as const;
export type PlannableTool = (typeof PLANNABLE_TOOLS)[number];
export const TASK_LIMITS = { steps: 10, days: 30, activePerPerson: 5 } as const;
export const planTaskInput = z
  .object({
    title: z.string().trim().min(1).max(80),
    steps: z
      .array(
        z
          .object({
            tool: z.enum(PLANNABLE_TOOLS),
            /** The tool's own input, as you would give it to the tool. For remind: { text, email }. */
            input: z.record(z.unknown()).default({}),
            /** When the step may run, on the person's clock. Omit: right after the step before it. */
            date: dateString.optional(),
            time: timeString.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(TASK_LIMITS.steps),
  })
  .strict();
export const cancelTaskInput = z.object({ task: taskHandleSchema }).strict();

// ── ADR 0040 part 2: listings and invites ─────────────────────────────────────

const price = z.number().min(0).max(1_000_000_000);
const rooms = z.number().int().min(0).max(20);
/**
 * The listing fields a person may give in words. `price_low` / `price_high`, never `…_to`: no
 * write tool has a field that reads as a recipient. No field for status, agents, photos or the
 * agency — a listing is always made a draft, by this person, for their own agency.
 */
const listingFields = {
  headline: z.string().trim().min(1).max(200),
  /** The ad's body copy — the person's words, or the assistant's draft of them (labelled on the card). */
  description: z.string().trim().max(20_000),
  /** What a buyer reads, e.g. "Offers over $950,000" or "Contact agent". */
  price_display: z.string().trim().max(120),
  /** The searchable range — only figures the person gave. */
  price_low: price,
  price_high: price,
  rent_per_week: price,
  bedrooms: rooms,
  bathrooms: rooms,
  car_spaces: rooms,
  property_type: z.enum(PROPERTY_TYPES),
  land_area_sqm: z.number().min(0).max(10_000_000),
} as const;

export const createListingDraftInput = z
  .object({
    channel: z.enum(['sale', 'rent']),
    unit: z.string().trim().min(1).max(32).optional(),
    street_number: z.string().trim().min(1).max(32).optional(),
    street: z.string().trim().min(1).max(200).optional(),
    suburb: z.string().trim().min(1).max(120),
    state: z.enum(AU_STATES),
    postcode: z.string().trim().regex(/^\d{4}$/, 'Postcode must be 4 digits'),
    headline: listingFields.headline,
    description: listingFields.description.optional(),
    price_display: listingFields.price_display.optional(),
    price_low: price.optional(),
    price_high: price.optional(),
    rent_per_week: price.optional(),
    bedrooms: rooms.optional(),
    bathrooms: rooms.optional(),
    car_spaces: rooms.optional(),
    property_type: listingFields.property_type.optional(),
    land_area_sqm: listingFields.land_area_sqm.optional(),
  })
  .strict();

/** Only the fields named change — the edit form's own. Not the address, agents, photos or status (ADR 0040 part 2 §4). `""` or null clears one. */
export const updateListingInput = z
  .object({
    listing: listingHandleSchema,
    headline: listingFields.headline.optional(),
    description: z.string().trim().max(20_000).optional(),
    price_display: z.string().trim().max(120).optional(),
    price_low: price.nullable().optional(),
    price_high: price.nullable().optional(),
    rent_per_week: price.nullable().optional(),
    bedrooms: rooms.nullable().optional(),
    bathrooms: rooms.nullable().optional(),
    car_spaces: rooms.nullable().optional(),
    property_type: listingFields.property_type.optional(),
    land_area_sqm: listingFields.land_area_sqm.nullable().optional(),
  })
  .strict();

/** "Delete" a listing = withdraw it (ADR 0039 A). */
export const withdrawListingInput = z.object({ listing: listingHandleSchema }).strict();
/** An agent sends a draft or withdrawn listing for an owner/admin to publish. The assistant never publishes. */
export const submitListingInput = z.object({ listing: listingHandleSchema }).strict();

/** Invite an agent (owners/admins, `team:manage`) — the Agents & Team wizard's required fields, from the person's words. */
export const inviteAgentInput = z
  .object({
    first_name: z.string().trim().min(1).max(80),
    last_name: z.string().trim().min(1).max(80),
    display_name: z.string().trim().min(1).max(160).optional(),
    /** Where the invite link is sent — the address the person gave. Shown on the card before anything is sent. */
    email: z.string().trim().email('That does not look like an email address').max(320),
    phone: z.string().trim().min(1).max(32),
    licence_number: z.string().trim().min(1).max(64),
    licence_expiry: dateString.optional(),
    territory_suburbs: z.array(z.string().trim().min(1).max(80)).min(1).max(20),
    role: z.enum(['senior', 'principal', 'pm', 'cadet', 'custom']).default('senior'),
  })
  .strict();

/** The cards of this conversation and how each ended (ADR 0039 Phase 1). No input. */
export const checkCardsInput = z.object({}).strict();

export const reportMissingDataInput = z
  .object({
    request: z.string().trim().min(1).max(300),
    nearest_dataset: z.enum(DATASET_IDS as [DatasetId, ...DatasetId[]]).optional(),
    wanted: z.string().trim().min(1).max(200),
  })
  .strict();
/**
 * ADR 0044 A: every item the person asked for, and the tile that shows it — or null when the
 * account does not hold it. Shown on the card, so nothing asked for disappears silently.
 */
const coverage = z
  .array(z.object({ asked: z.string().trim().min(1).max(120), shown_in: z.string().trim().min(1).max(80).nullable() }).strict())
  .max(ASSISTANT_LIMITS.coverageItems)
  .optional();

/** ADR 0047: colours the person named, as #RRGGBB — the first is the accent. Checked again in core. */
const dashboardColors = z.array(z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'A colour is written #RRGGBB')).min(1).max(6);

export const createDashboardInput = z
  .object({
    title: z.string().trim().min(1).max(80),
    widgets: z.array(widgetChoice).min(1).max(12),
    audience: z.enum(['private', 'admins', 'agency']).default('admins'),
    coverage,
    colors: dashboardColors.optional(),
    /** ADR 0047: a chat that already saved a dashboard changes it; a second one only when the person asked for a separate one. */
    separate: z.boolean().default(false),
  })
  .strict();

/** ADR 0047: a tile kept exactly as it is now — its number on the dashboard, from 1. */
const keptTile = z.object({ keep: z.number().int().min(1).max(12) }).strict();

/** ADR 0047: change a dashboard THIS chat saved. Only what changes; `colors: null` goes back to the console's palette. */
export const updateDashboardInput = z
  .object({
    /** Which of this chat's dashboards, by its exact current title. Absent: the newest one this chat saved. */
    dashboard: z.string().trim().min(1).max(80).optional(),
    title: z.string().trim().min(1).max(80).optional(),
    /** The whole new list, in order: `{ keep: n }` for a tile as it is, or a new tile. */
    widgets: z.array(z.union([keptTile, widgetChoice])).min(1).max(12).optional(),
    audience: z.enum(['private', 'admins', 'agency']).optional(),
    colors: dashboardColors.nullable().optional(),
    coverage,
  })
  .strict();

/**
 * Assigning contacts (owners and admins only, `contact:assign`). The team
 * list is a read tool that issues `M` references; the assignment is a card.
 * Contacts are references the server issued — at most 20, never a filter.
 */
export const findTeamMembersInput = z.object({}).strict();

const contactsOnOneCard = z.array(contactHandleSchema).min(1).max(ASSISTANT_LIMITS.contactsPerCard);

export const assignContactsInput = z
  .object({
    contacts: contactsOnOneCard,
    /** Who receives them: an M reference from find_team_members. */
    to: memberHandleSchema,
  })
  .strict();

/**
 * Marketing consent (ADR 0022 stays in force): recorded only for contacts the
 * person may edit, by reference, never "all" or a filter — and only with the
 * person's own words for how the contact agreed. No "how", no card: the model
 * must ask.
 */
export const recordMarketingConsentInput = z
  .object({
    contacts: contactsOnOneCard,
    how: z
      .string({ required_error: 'Ask the person how these contacts agreed to marketing email; nothing was proposed.' })
      .trim()
      .min(1, 'Ask the person how these contacts agreed to marketing email; nothing was proposed.')
      .max(300),
  })
  .strict();

export const withdrawMarketingConsentInput = z
  .object({
    contacts: contactsOnOneCard,
    reason: z
      .string({ required_error: 'Ask the person why consent is withdrawn; nothing was proposed.' })
      .trim()
      .min(1, 'Ask the person why consent is withdrawn; nothing was proposed.')
      .max(300),
  })
  .strict();

/**
 * A contact's details — the edit form's name, email, phone and roles, and
 * nothing else: no field for who it is assigned to, consent, the next action
 * (set_next_action), the archive (set_contact_archived) or deleting (there is
 * no such tool). One contact per card; at least one field.
 */
export const updateContactInput = z
  .object({
    contact: contactHandleSchema,
    name: z.string().trim().min(1).max(120).optional(),
    /** An address, or "" to remove it. */
    email: z
      .string()
      .trim()
      .max(200)
      .refine((v) => v === '' || z.string().email().safeParse(v).success, 'That does not look like an email address')
      .optional(),
    /** A number, or "" to remove it. */
    phone: z.string().trim().max(40).optional(),
    /** The whole set: a role left out is removed. */
    roles: z.array(z.enum(CONTACT_ROLES)).max(CONTACT_ROLES.length).optional(),
  })
  .strict();

/** Archive a contact, or bring it back. Never delete. */
export const setContactArchivedInput = z.object({ contact: contactHandleSchema, archived: z.boolean() }).strict();

/**
 * The team (ADR 0033, owners/admins — `team:manage`). find_agents issues `M`
 * references for members and `I` references for pending invites, with what
 * tells two people of one name apart. update_agent and remove_agent only
 * propose; the card runs the screen's own core function.
 */
export const findAgentsInput = z
  .object({
    /** Part of a name, email, phone or licence number. Omit for the whole team. */
    text: text.optional(),
  })
  .strict();

const ASSISTANT_OPERATIONAL_ROLES = ['senior', 'principal', 'pm', 'cadet', 'custom'] as const;

export const updateAgentInput = z
  .object({
    agent: agentHandleSchema,
    first_name: z.string().trim().min(1).max(80).optional(),
    last_name: z.string().trim().min(1).max(80).optional(),
    display_name: z.string().trim().min(1).max(160).optional(),
    /** Only for a pending invite; an active member's email is their sign-in (refused in core). */
    email: z.string().trim().email('That does not look like an email address').max(320).optional(),
    phone: z.string().trim().min(1).max(32).optional(),
    licence_number: z.string().trim().min(1).max(64).optional(),
    /** YYYY-MM-DD, or "" to clear it. */
    licence_expiry: z.union([dateString, z.literal('')]).optional(),
    /** The whole territory: suburbs left out are removed. */
    territory_suburbs: z.array(z.string().trim().min(1).max(80)).min(1).max(20).optional(),
    role: z.enum(ASSISTANT_OPERATIONAL_ROLES).optional(),
  })
  .strict();

export const removeAgentInput = z
  .object({
    agent: agentHandleSchema,
    /** For an active member: who receives their contacts, leads, appointments and listings (an M reference). */
    receiver: memberHandleSchema.optional(),
    /** For an active member: leave their work unassigned in the "Needs an owner" queue instead. */
    leave_for_review: z.boolean().optional(),
  })
  .strict();

/**
 * Writing (ADR 0035). find_colleagues issues `M` references for the other
 * active members — anyone may look them up, to write to them. The two write
 * tools only propose: the card shows the exact words, and nothing is sent
 * until the person approves THAT text. No field takes an address or a name.
 */
export const findColleaguesInput = z
  .object({
    /** Part of a name or email. Omit for everyone. */
    text: text.optional(),
  })
  .strict();

const emailSubject = z.string().trim().min(1).max(200);
const emailBody = z.string().trim().min(1).max(5000);

export const sendEmailInput = z
  .object({
    contact: contactHandleSchema,
    subject: emailSubject,
    /** Plain text, signed off by the platform — no sign-off needed. */
    body: emailBody,
  })
  .strict();

export const messageColleaguesInput = z
  .object({
    to: z.array(memberHandleSchema).min(1).max(10),
    subject: emailSubject,
    body: emailBody,
  })
  .strict();

/**
 * A team meeting (ADR 0038): colleagues by `M` reference from find_colleagues,
 * never a contact. Booked on the person's own calendar; on Approve everyone
 * on it is told, by template, with the link.
 */
export const ASSISTANT_TEAM_MEETING_TYPES = ['zoom', 'phone_call', 'meeting'] as const;

export const scheduleTeamMeetingInput = z
  .object({
    colleagues: z.array(memberHandleSchema).min(1).max(10),
    type: z.enum(ASSISTANT_TEAM_MEETING_TYPES),
    title: z.string().trim().min(1).max(160),
    date: dateString,
    time: timeString,
    duration_minutes: z.number().int().min(15).max(480).optional(),
    location: z.string().trim().max(300).optional(),
    /** Shown to everyone on it — only what the person said. */
    agenda: z.string().trim().max(2000).optional(),
  })
  .strict();

export const ASSISTANT_READ_TOOLS = ['find_contacts', 'find_leads', 'find_appointments', 'list_templates', 'check_connections', 'show_widget', 'search_notes_and_emails', 'find_team_members', 'find_agents', 'find_colleagues', 'report_missing_data', 'check_cards', 'find_listings', 'find_buyers', 'find_saved_lists', 'start_import', 'find_skills', 'find_workflows', 'describe_data', 'query_data', 'search_documents', 'read_document'] as const;
/** ADR 0042: a turn that uses these may make more tool calls (`toolCallsPerAnalysisTurn`). */
export const ASSISTANT_ANALYSIS_TOOLS = ['describe_data', 'query_data'] as const;
export const ASSISTANT_WRITE_TOOLS = ['add_note', 'set_next_action', 'schedule_appointment', 'reschedule_appointment', 'cancel_appointment', 'send_template_email', 'create_dashboard', 'update_dashboard', 'assign_contacts', 'record_marketing_consent', 'withdraw_marketing_consent', 'update_contact', 'set_contact_archived', 'update_agent', 'remove_agent', 'send_email', 'message_colleagues', 'schedule_team_meeting', 'set_lead_status', 'assign_lead', 'create_lead', 'create_contact', 'create_reminder', 'plan_task', 'cancel_task', 'create_listing_draft', 'update_listing', 'withdraw_listing', 'submit_listing', 'invite_agent', 'set_up_skill', 'change_skill', 'switch_skill', 'create_workflow', 'change_workflow', 'create_template'] as const;
export type AssistantWriteTool = (typeof ASSISTANT_WRITE_TOOLS)[number];
/**
 * What a `proposed_action` row's `tool` may be — the database CHECK (latest: migration 0056) holds
 * exactly this list: every write tool except create_reminder (it stores a one-step plan_task), plus
 * `remind` (ADR 0040) and `draft_email` (ADR 0041), task steps that are never tools of their own.
 */
export const PROPOSED_ACTION_TOOLS = [...ASSISTANT_WRITE_TOOLS.filter((t) => t !== 'create_reminder'), 'remind', 'draft_email'] as const;

/** Every tool. Read tools run at once; write tools only propose (ADR 0025 §8). */
export const ASSISTANT_TOOL_INPUTS = {
  find_contacts: findContactsInput,
  find_leads: findLeadsInput,
  find_appointments: findAppointmentsInput,
  list_templates: listTemplatesInput,
  check_connections: checkConnectionsInput,
  show_widget: showWidgetInput,
  describe_data: describeDataInput,
  query_data: queryDataInput,
  report_missing_data: reportMissingDataInput,
  check_cards: checkCardsInput,
  search_notes_and_emails: searchNotesAndEmailsInput,
  search_documents: searchDocumentsInput,
  read_document: readDocumentInput,
  add_note: addNoteInput,
  set_next_action: setNextActionInput,
  schedule_appointment: scheduleAppointmentInput,
  reschedule_appointment: rescheduleAppointmentInput,
  cancel_appointment: cancelAppointmentInput,
  send_template_email: sendTemplateEmailInput,
  create_dashboard: createDashboardInput,
  update_dashboard: updateDashboardInput,
  find_team_members: findTeamMembersInput,
  assign_contacts: assignContactsInput,
  record_marketing_consent: recordMarketingConsentInput,
  withdraw_marketing_consent: withdrawMarketingConsentInput,
  update_contact: updateContactInput,
  set_contact_archived: setContactArchivedInput,
  find_agents: findAgentsInput,
  update_agent: updateAgentInput,
  remove_agent: removeAgentInput,
  find_colleagues: findColleaguesInput,
  send_email: sendEmailInput,
  message_colleagues: messageColleaguesInput,
  schedule_team_meeting: scheduleTeamMeetingInput,
  find_listings: findListingsInput,
  find_buyers: findBuyersInput,
  find_saved_lists: findSavedListsInput,
  start_import: startImportInput,
  find_skills: findSkillsInput,
  find_workflows: findWorkflowsInput,
  set_lead_status: setLeadStatusInput,
  assign_lead: assignLeadInput,
  create_lead: createLeadInput,
  create_contact: createContactInput,
  create_reminder: createReminderInput,
  plan_task: planTaskInput,
  cancel_task: cancelTaskInput,
  create_listing_draft: createListingDraftInput,
  update_listing: updateListingInput,
  withdraw_listing: withdrawListingInput,
  submit_listing: submitListingInput,
  invite_agent: inviteAgentInput,
  set_up_skill: setUpSkillInput,
  change_skill: changeSkillInput,
  switch_skill: switchSkillInput,
  create_workflow: createWorkflowInput,
  change_workflow: changeWorkflowInput,
  create_template: createTemplateInput,
} as const;
export type AssistantToolName = keyof typeof ASSISTANT_TOOL_INPUTS;
export const ASSISTANT_TOOL_NAMES = Object.keys(ASSISTANT_TOOL_INPUTS) as AssistantToolName[];

/**
 * Tools only an owner or admin is shown (the model's tool list is chosen per
 * person) and may run (each asks can() again): `contact:assign`.
 */
export const ASSISTANT_ADMIN_TOOLS = ['find_team_members', 'assign_contacts', 'assign_lead'] as const satisfies readonly AssistantToolName[];

/** Team tools (ADR 0033): owners and admins only, by `team:manage` — shown to nobody else, refused in core. */
export const ASSISTANT_TEAM_TOOLS = ['find_agents', 'update_agent', 'remove_agent', 'invite_agent'] as const satisfies readonly AssistantToolName[];

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** What the console posts for one turn. */
export const assistantTurnRequestSchema = z
  .object({
    /** Absent: start a new conversation. */
    conversationId: z.string().uuid().optional(),
    message: z.string().trim().min(1, 'Type a question first').max(ASSISTANT_LIMITS.messageChars),
    /** The browser's zone, so "today" and "tomorrow" mean the person's. */
    timeZone: z.string().max(64).refine(isTimeZone, 'Unknown time zone'),
    /** Contacts selected in the console — the profile the panel was opened on. Ids, never names. */
    selection: z
      .object({ contactIds: z.array(z.string().uuid()).max(ASSISTANT_LIMITS.selection) })
      .strict()
      .optional(),
  })
  .strict();
export type AssistantTurnRequest = z.infer<typeof assistantTurnRequestSchema>;

/**
 * What the panel draws beside the answer. Built by the server from SQL — the
 * names, dates, counts and links on screen never come from the model's prose.
 */
export type AssistantFrame =
  | {
      kind: 'contacts';
      total: number;
      rows: { handle: string; id: string; name: string; roles: string[]; assigneeName: string | null; archived: boolean }[];
    }
  | {
      /** ADR 0059: buyers whose brief fits; `searched` says what was looked for, in the Requirements tab's words. */
      kind: 'buyers';
      searched: string;
      total: number;
      rows: { id: string; handle: string; contactId: string; name: string; brief: string; assigneeName: string | null; enquired: boolean }[];
    }
  | {
      kind: 'leads';
      total: number;
      rows: { handle: string; id: string; contactHandle: string | null; contactId: string | null; name: string; address: string; status: string; received: string }[];
    }
  | {
      kind: 'appointments';
      total: number;
      /** `contactId` null: a team meeting (ADR 0038); `contactName` then names the colleagues. */
      rows: { handle: string; id: string; contactId: string | null; contactName: string; title: string; type: string; when: string; status: string }[];
    }
  | { kind: 'templates'; total: number; rows: { handle: string; id: string; name: string; subject: string }[] }
  | {
      kind: 'connections';
      rows: { provider: IntegrationProvider; label: string; state: string; whose: 'yours' | 'agency' | null; mayConnect: boolean }[];
    }
  /** Search results (ADR 0031): who, what kind, when, and a short snippet — only rows this person may read. */
  | {
      kind: 'search';
      mode: 'fulltext' | 'hybrid';
      rows: { handle: string; contactId: string; contactName: string; type: 'note' | 'email' | 'enquiry'; when: string; snippet: string }[];
    }
  /** Documents found (ADR 0053): title, whose, which pages, a short snippet — only documents this person may read. */
  | {
      kind: 'documents';
      mode: 'fulltext' | 'hybrid';
      rows: { handle: string; id: string; title: string; scope: 'record' | 'knowledge'; contactId: string | null; contactName: string | null; pages: string; snippet: string }[];
    }
  /** The import's own buttons (ADR 0029 amendment): upload a file, or pick a Google Sheet. Decided by can(), drawn by the panel. */
  | { kind: 'import'; what: 'listings' | 'contacts'; mayPublish: boolean; sheets: { state: string; mayConnect: boolean } }
  /** A widget tile shown in the chat, computed from SQL as the person asking (ADR 0027). */
  | { kind: 'widget'; tile: WidgetTile }
  /** A card waiting for the person. The panel loads it by id — from the database, never from the stream's text. */
  | { kind: 'proposal'; id: string; tool: AssistantWriteTool };

export const PROPOSAL_STATUSES = ['proposed', 'approved', 'rejected', 'expired', 'scheduled', 'running', 'done', 'failed', 'cancelled'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/**
 * What a card shows, built by the server from the database when the action
 * is proposed and frozen with it — so the audit shows exactly what the person
 * approved. `text` is shown verbatim: it is what will be written.
 */
export type ProposalCard = {
  title: string;
  contact: { id: string; name: string };
  lines: { label: string; value: string }[];
  text?: { label: string; value: string };
  /** Plain-words notes under the card ("No invitation is emailed…"). */
  notes: string[];
  /** For an email card: every recipient, from the frozen batch — who will receive it and who is skipped, with why. */
  people?: { name: string; email: string | null; willReceive: boolean; reason: string | null }[];
  /**
   * For a card that changes several contacts (assign, consent): each one, from
   * the database — what it is now and what it will be, or why it is skipped.
   */
  changes?: { name: string; email: string | null; before: string; after: string; skipped: string | null }[];
  /**
   * For a card whose text the assistant WROTE and that someone else will read
   * (ADR 0035 §4): every figure in it, so the person checks each one.
   */
  figures?: string[];
};

/** The NDJSON frames of one turn, in order. */
export type AssistantEvent =
  | { type: 'turn'; conversationId: string; turnId: string }
  | { type: 'text'; delta: string }
  | { type: 'status'; label: string }
  | { type: 'results'; frame: AssistantFrame }
  | { type: 'error'; code: 'budget' | 'limit' | 'refusal' | 'upstream' | 'busy' | 'forbidden'; message: string }
  | { type: 'done' };
