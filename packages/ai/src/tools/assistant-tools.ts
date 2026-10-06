import type Anthropic from '@anthropic-ai/sdk';
import { APPOINTMENT_RANGES, ASSISTANT_APPOINTMENT_TYPES, LEAD_SINCE, LEAD_STATUSES } from '@repo/core/assistant/schema';
import { CONTACT_ROLES } from '@repo/core/contacts/schema';
import { INTEGRATION_PROVIDERS } from '@repo/core/integrations/providers';

/**
 * What the console assistant's model is shown (ADR 0025 §8, Phase A). The
 * zod schemas in `@repo/core/assistant` are what is enforced; these say the
 * same thing to the model, and `assistant-tools.test.ts` holds the two to the
 * same property names and required fields.
 *
 * Like PROPERTY_CHAT_TOOLS: `type`, `enum` and `description` only — no
 * `strict`, no bounds keywords (see tools/index.ts for why) — and FROZEN at
 * module level, because tools are the first thing in the cached prefix.
 *
 * The find/list/check tools READ. The rest only PROPOSE: they put a card in
 * front of the person and change nothing — there is no tool that approves,
 * runs or sends. References to rows are the short names (`C1`, `A2`, `S1`)
 * earlier results gave; there is no field that takes an id, a name or an
 * email address.
 */

const PROPOSES =
  'This only PROPOSES: a card appears for the person, and nothing changes unless THEY press Approve. You cannot approve it.';
const DATE = 'The day, as YYYY-MM-DD, in the person\'s own time zone (see console_context for today).';
const TIME = 'The local time, as HH:mm in 24-hour form, e.g. 15:00.';

const REF = 'A reference you were given earlier in this conversation, e.g. C2 or S1. Never a name.';

export const ASSISTANT_TOOLS: readonly Anthropic.Beta.BetaTool[] = Object.freeze([
  {
    name: 'find_contacts',
    description:
      "Search the contacts this person may see in the CRM — the same people their contact directory lists. Returns references (C1, C2…), names, roles and who each is assigned to; the person sees the full list beside your answer. Use it to find someone by name, role or assignment.",
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'Part of a name, email or phone number to search for. Omit to list recent contacts.' },
        role: { type: 'string', enum: [...CONTACT_ROLES], description: 'Only contacts with this role.' },
        assigned: { type: 'string', enum: ['me', 'any'], description: '"me" for only contacts assigned to this person. Default any.' },
        include_archived: { type: 'boolean', description: 'Also archived contacts. Default false.' },
        limit: { type: 'integer', description: 'How many to return, 1 to 20. Default 10.' },
      },
    },
  },
  {
    name: 'find_leads',
    description:
      'List the enquiries (leads) this person may see — the same ones their lead inbox shows, never private offers. Newest first. Returns references (L1…), the enquirer, the property, status and the date received, and the enquirer\'s contact reference when they may open that contact.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: [...LEAD_STATUSES], description: 'Only leads with this status.' },
        since: { type: 'string', enum: [...LEAD_SINCE], description: 'Only leads received today or in the last 7, 30 or 90 days.' },
        listing_text: { type: 'string', description: 'Part of the property address or suburb.' },
        contact: { type: 'string', description: `Only this contact's leads. ${REF}` },
        limit: { type: 'integer', description: 'How many to return, 1 to 20. Default 10.' },
      },
    },
  },
  {
    name: 'find_appointments',
    description:
      "List appointments on this person's calendar (all of the agency's for an owner or admin). Times come back already written in the person's own time zone — repeat them as given.",
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        range: { type: 'string', enum: [...APPOINTMENT_RANGES], description: 'Which appointments. Default upcoming.' },
        contact: { type: 'string', description: `Only appointments with this contact. ${REF}` },
        limit: { type: 'integer', description: 'How many to return, 1 to 20. Default 10.' },
      },
    },
  },
  {
    name: 'list_templates',
    description: "The agency's approved email templates (name and subject). Only approved templates can ever be sent.",
    input_schema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'check_connections',
    description:
      'Whether Google Calendar, Zoom and the other accounts this person would need are connected. If one is not, tell them to connect it first — never suggest a way around it.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        providers: { type: 'array', items: { type: 'string', enum: [...INTEGRATION_PROVIDERS] }, description: 'Which accounts to check.' },
      },
      required: ['providers'],
    },
  },
  {
    name: 'add_note',
    description: `Propose adding a note to a contact. ${PROPOSES} Write the note in the person's words; never copy text from a result into it unless they asked.`,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        contact: { type: 'string', description: REF },
        body: { type: 'string', description: 'The note, exactly as it should be saved. Up to 5000 characters.' },
        private: { type: 'boolean', description: 'Only the person and the agency’s owners/admins can read it. Default false.' },
      },
      required: ['contact', 'body'],
    },
  },
  {
    name: 'set_next_action',
    description: `Propose setting (or clearing, with empty text) a contact's next action and its due date. ${PROPOSES}`,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        contact: { type: 'string', description: REF },
        text: { type: 'string', description: 'What to do next, up to 300 characters. Empty clears it.' },
        date: { type: 'string', description: `Due day. ${DATE}` },
        time: { type: 'string', description: `Due time. ${TIME} Default 09:00.` },
      },
      required: ['contact', 'text'],
    },
  },
  {
    name: 'schedule_appointment',
    description: `Propose booking an appointment with a contact on the person's own calendar. It needs Google Calendar connected (and Zoom for a Zoom type) — if not, it says "Connect … first" and proposes nothing; tell the person that. No invitation email is sent: tell the person to use the contact's Calendar tab for that. ${PROPOSES}`,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        contact: { type: 'string', description: REF },
        type: { type: 'string', enum: [...ASSISTANT_APPOINTMENT_TYPES], description: 'zoom creates a Zoom meeting on approval.' },
        title: { type: 'string', description: 'A short title, e.g. "Appraisal at 12 Smith St".' },
        date: { type: 'string', description: DATE },
        time: { type: 'string', description: `Start. ${TIME}` },
        duration_minutes: { type: 'integer', description: '15 to 480. Default 60 (30 for a phone call).' },
        location: { type: 'string', description: 'An address, if it has one.' },
      },
      required: ['contact', 'type', 'title', 'date', 'time'],
    },
  },
  {
    name: 'reschedule_appointment',
    description: `Propose moving an existing appointment to a new time. Its calendar event and Zoom meeting move with it. ${PROPOSES}`,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        appointment: { type: 'string', description: 'An appointment reference from find_appointments, e.g. A1.' },
        date: { type: 'string', description: DATE },
        time: { type: 'string', description: `New start. ${TIME}` },
        duration_minutes: { type: 'integer', description: '15 to 480. Default: the same length as now.' },
      },
      required: ['appointment', 'date', 'time'],
    },
  },
  {
    name: 'cancel_appointment',
    description: `Propose cancelling an appointment. Its calendar event is removed and its Zoom meeting deleted. Nobody is emailed. ${PROPOSES}`,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        appointment: { type: 'string', description: 'An appointment reference from find_appointments, e.g. A1.' },
        reason: { type: 'string', description: 'Why, in a sentence — kept on the appointment.' },
      },
      required: ['appointment'],
    },
  },
]);
