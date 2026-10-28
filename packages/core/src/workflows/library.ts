import type { TriggerKind } from './catalog';

/**
 * The Automation Library (ADR 0068, ROADMAP 4.3): ready-made automations an owner or admin sets up by asking
 * the assistant. Pure data. Each entry is words for the card and the words typed into the assistant's box —
 * never a spec: the assistant builds the workflow from them with the person (which template, who, when), shows
 * its card, and nothing starts until they approve. So a library entry can never do what the assistant and
 * `checkWorkflow` would refuse.
 */

export const LIBRARY_GROUPS = ['Leads', 'Appointments', 'Deals', 'Buyers and past clients'] as const;
export type LibraryGroup = (typeof LIBRARY_GROUPS)[number];
export type LibraryNeed = 'template' | 'member';
export const LIBRARY_NEED_WORDS: Record<LibraryNeed, string> = { template: 'Needs an approved template', member: 'Needs a team member' };

export type LibraryEntry = {
  id: string;
  group: LibraryGroup;
  icon: string;
  title: string;
  summary: string;
  when: string;
  then: string;
  needs: LibraryNeed[];
  /** What it is built on — for "N like this on" beside it. */
  trigger: TriggerKind;
  /** It starts with "AI decides" (ADR 0067). */
  decides: boolean;
  /** Typed into the assistant's box, never sent by itself. Asks for what it needs. */
  ask: string;
};

export const AUTOMATION_LIBRARY: readonly LibraryEntry[] = Object.freeze([
  {
    id: 'reply-enquiries', group: 'Leads', icon: 'bolt', trigger: 'lead.created', decides: false, needs: ['template'],
    title: 'Reply to website enquiries in office hours',
    summary: 'Every enquiry gets your welcome email, sent between 9 and 5 on weekdays.',
    when: 'an enquiry arrives from the website', then: 'wait for office hours, send your welcome template',
    ask: 'Set up an agency-wide workflow: when an enquiry arrives from the website, wait until office hours (9 am to 5 pm, Monday to Friday) and send them our welcome template. Ask me which template to use.',
  },
  {
    id: 'sort-enquiries', group: 'Leads', icon: 'psychology', trigger: 'lead.created', decides: true, needs: ['member'],
    title: 'Sort enquiries: seller, buyer or tenant',
    summary: 'The AI reads each enquiry and sends it the right way; when it can’t tell, it reminds you.',
    when: 'an enquiry arrives', then: 'the AI decides sell / buy / rent / not sure',
    ask: 'Set up an agency-wide workflow: when a new enquiry arrives, work out whether they want to sell, buy or rent. Sellers: give the lead to our appraisals agent. Buyers: remind me to call them. Renters: message our rentals person. If you can’t tell, remind me to read it. Ask me who the appraisals agent and the rentals person are.',
  },
  {
    id: 'no-reply', group: 'Leads', icon: 'schedule', trigger: 'lead.no_reply', decides: false, needs: [],
    title: 'Chase a buyer with no reply',
    summary: 'If a buyer’s email has had no answer for 2 days, you get a reminder.',
    when: 'no reply for 2 days', then: 'remind you, set the next action',
    ask: 'Set up an agency-wide workflow: when a buyer has had no reply for 2 days, remind me to answer {{contact_first_name}} and set the next action “Reply to the enquiry” due the same day.',
  },
  {
    id: 'inspection-reminder', group: 'Appointments', icon: 'alarm', trigger: 'appointment.upcoming', decides: false, needs: ['template'],
    title: 'Inspection reminder the day before',
    summary: 'The client gets your “See you tomorrow” email 24 hours before an inspection.',
    when: '24 hours before an inspection', then: 'send the template',
    ask: 'Set up an agency-wide workflow: 24 hours before an inspection appointment starts, send the client our reminder template. Ask me which template to use.',
  },
  {
    id: 'after-inspection', group: 'Appointments', icon: 'task_alt', trigger: 'appointment.completed', decides: false, needs: [],
    title: 'Follow up after an inspection',
    summary: 'When an inspection is marked done, a reminder to call them the next morning.',
    when: 'an inspection is completed', then: 'wait until 9 am, remind you',
    ask: 'Set up an agency-wide workflow: when an inspection appointment is completed, wait until 9 am and remind me to call {{contact_first_name}} about how it went.',
  },
  {
    id: 'appraisal-not-listed', group: 'Appointments', icon: 'hourglass_bottom', trigger: 'appraisal.not_listed', decides: false, needs: [],
    title: 'Appraisal not listed after a week',
    summary: 'An appraisal with no listing after 7 days: a reminder and a next action on the owner.',
    when: 'an appraisal has had no listing for 7 days', then: 'remind you, next action in 2 days',
    ask: 'Set up an agency-wide workflow: when an appraisal has had no listing for 7 days, remind me to call {{contact_first_name}} and set the next action “Follow up the appraisal” due in 2 days.',
  },
  {
    id: 'contract-checklist', group: 'Deals', icon: 'flag', trigger: 'deal.stage_reached', decides: false, needs: ['template'],
    title: 'Contract: send the buyer the checklist',
    summary: 'When a deal goes to Contract, the buyer gets your conveyancing checklist.',
    when: 'a deal reaches Contract — the buyer', then: 'send the template',
    ask: 'Set up an agency-wide workflow: when a deal reaches Contract, send the buyer our conveyancing checklist template. Ask me which template to use.',
  },
  {
    id: 'settled-thanks', group: 'Deals', icon: 'handshake', trigger: 'deal.settled', decides: false, needs: ['template'],
    title: 'Settled: thank the vendor, ask for a review',
    summary: 'A thank-you draft for you to send, then your review request a week later.',
    when: 'a deal settles — the vendor', then: 'draft a thank-you, wait 7 days, send the review template',
    ask: 'Set up an agency-wide workflow: when a deal settles, write a thank-you email draft for me to approve for the vendor, then 7 days later send them our review request template. Ask me which template to use.',
  },
  {
    id: 'just-listed', group: 'Buyers and past clients', icon: 'join_inner', trigger: 'buyer.matched', decides: false, needs: ['template'],
    title: 'Just listed for matching buyers',
    summary: 'A new listing that fits a buyer’s brief: your “Just listed” email, in office hours.',
    when: 'a new listing fits a buyer’s brief', then: 'wait for office hours, send the template',
    ask: 'Set up an agency-wide workflow: when a new listing fits a buyer’s brief, wait until office hours (9 am to 5 pm, Monday to Friday) and send the buyer our just listed template. Ask me which template to use.',
  },
  {
    id: 'home-anniversary', group: 'Buyers and past clients', icon: 'cake', trigger: 'sale.anniversary', decides: false, needs: ['template'],
    title: 'Home anniversary',
    summary: 'A year after we sold their home, the new owners hear from you.',
    when: 'a year after a sale — owners and buyer', then: 'send the template',
    ask: 'Set up an agency-wide workflow: on the 1-year anniversary of a sale, send the owners and buyer our home anniversary template. Ask me which template to use.',
  },
]);

/** Active workflows built like this entry: on its trigger, with or without a decision. Pure. */
export function likeThisOn(entry: LibraryEntry, workflows: readonly { status: string; triggerKind: TriggerKind | null; decides: boolean }[]): number {
  return workflows.filter((w) => w.status === 'active' && w.triggerKind === entry.trigger && w.decides === entry.decides).length;
}
