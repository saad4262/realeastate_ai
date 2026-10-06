import { z } from 'zod';
import { CONTACT_ROLES } from '../contacts/contact-schema';
import { INTEGRATION_PROVIDERS, type IntegrationProvider } from '../integrations/providers';

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
} as const;
export type HandlePrefix = keyof typeof HANDLE_KINDS;
export type HandleKind = (typeof HANDLE_KINDS)[HandlePrefix];

export const handleSchema = z
  .string()
  .trim()
  .regex(/^[CLATS][1-9][0-9]{0,2}$/, 'Not a reference the assistant was given');

/** A handle that must name an appointment. */
export const appointmentHandleSchema = handleSchema.refine((h) => h.startsWith('A'), { message: 'Not an appointment reference' });

/** A handle that must name a contact. */
export const contactHandleSchema = handleSchema.refine((h) => h.startsWith('C') || h.startsWith('S'), {
  message: 'Not a contact reference',
});

/** Caps that hold however the model asks (ADR 0025 §4, §10; decided Q7). */
export const ASSISTANT_LIMITS = {
  /** Tool calls in one turn, across every round. */
  toolCallsPerTurn: 8,
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

export const ASSISTANT_READ_TOOLS = ['find_contacts', 'find_leads', 'find_appointments', 'list_templates', 'check_connections'] as const;
export const ASSISTANT_WRITE_TOOLS = ['add_note', 'set_next_action', 'schedule_appointment', 'reschedule_appointment', 'cancel_appointment'] as const;
export type AssistantWriteTool = (typeof ASSISTANT_WRITE_TOOLS)[number];

/** Every tool. Read tools run at once; write tools only propose (ADR 0025 §8). */
export const ASSISTANT_TOOL_INPUTS = {
  find_contacts: findContactsInput,
  find_leads: findLeadsInput,
  find_appointments: findAppointmentsInput,
  list_templates: listTemplatesInput,
  check_connections: checkConnectionsInput,
  add_note: addNoteInput,
  set_next_action: setNextActionInput,
  schedule_appointment: scheduleAppointmentInput,
  reschedule_appointment: rescheduleAppointmentInput,
  cancel_appointment: cancelAppointmentInput,
} as const;
export type AssistantToolName = keyof typeof ASSISTANT_TOOL_INPUTS;
export const ASSISTANT_TOOL_NAMES = Object.keys(ASSISTANT_TOOL_INPUTS) as AssistantToolName[];

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
      kind: 'leads';
      total: number;
      rows: { handle: string; id: string; contactHandle: string | null; contactId: string | null; name: string; address: string; status: string; received: string }[];
    }
  | {
      kind: 'appointments';
      total: number;
      rows: { handle: string; id: string; contactId: string; contactName: string; title: string; type: string; when: string; status: string }[];
    }
  | { kind: 'templates'; total: number; rows: { handle: string; id: string; name: string; subject: string }[] }
  | {
      kind: 'connections';
      rows: { provider: IntegrationProvider; label: string; state: string; whose: 'yours' | 'agency' | null; mayConnect: boolean }[];
    }
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
};

/** The NDJSON frames of one turn, in order. */
export type AssistantEvent =
  | { type: 'turn'; conversationId: string; turnId: string }
  | { type: 'text'; delta: string }
  | { type: 'status'; label: string }
  | { type: 'results'; frame: AssistantFrame }
  | { type: 'error'; code: 'budget' | 'limit' | 'refusal' | 'upstream' | 'busy' | 'forbidden'; message: string }
  | { type: 'done' };
