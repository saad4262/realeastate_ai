import type { OpportunityKind } from '../opportunities/detectors';

/**
 * The platform skills (ADR 0058): every built capability a person may switch off. Fixed in code —
 * a new one is an entry here plus the gate that honours it, both reviewed. Pure data, no database,
 * so the console's page, the assistant and the tests read the same list.
 */

export const SKILL_KEYS = [
  'bulk_email',
  'ai_email_drafts',
  'ai_listing_copy',
  'property_summaries',
  'buyer_matching',
  'ai_import',
  'ai_workflow_decisions',
  'sale_anniversaries',
  'cold_contacts',
  'unanswered_emails',
  'appraisal_follow_ups',
  'repeat_interest',
  'dashboards',
  'agency_performance',
  'team_activity',
  'knowledge_answers',
  'team_meetings',
  'team_management',
] as const;

export type SkillKey = (typeof SKILL_KEYS)[number];

export const SKILL_GROUPS = ['Communication', 'Listings', 'CRM & matching', 'Opportunities', 'Insights', 'Knowledge & team'] as const;
export type SkillGroup = (typeof SKILL_GROUPS)[number];

/** What a group's heading says under it, when it needs a word. */
export const SKILL_GROUP_NOTES: Partial<Record<SkillGroup, string>> = {
  Opportunities: 'The platform spots these by itself and puts them in front of the right person.',
};

export type PlatformSkill = {
  key: SkillKey;
  group: SkillGroup;
  name: string;
  /** One line, for the card and the assistant. */
  description: string;
  /** Material Symbols name. */
  icon: string;
  /** `agency`: reads the whole agency — owners and admins only, never shown to anyone else. */
  scope: 'both' | 'agency';
  /** The card's tag: it acts by itself, or what it prepares waits for the person's approval. */
  level: 'auto' | 'approval';
  /** The connector it uses, by label (shown, not enforced here — the tools ask "Connect … first"). */
  needs?: string;
};

export const PLATFORM_SKILLS: readonly PlatformSkill[] = Object.freeze([
  { key: 'bulk_email', group: 'Communication', icon: 'forward_to_inbox', name: 'Bulk email', description: 'Email a filtered list of contacts. Respects consent and unsubscribes.', scope: 'both', level: 'approval' },
  { key: 'ai_email_drafts', group: 'Communication', icon: 'edit_note', name: 'AI email drafts', description: 'The assistant (or a workflow) writes the email. You read it, then send it.', scope: 'both', level: 'approval' },
  { key: 'ai_listing_copy', group: 'Listings', icon: 'description', name: 'AI listing copy', description: 'A first draft of a listing and its description from what you tell the assistant. Goes live only after approval.', scope: 'both', level: 'approval' },
  { key: 'property_summaries', group: 'Listings', icon: 'summarize', name: 'Property summaries', description: 'A short summary of everything on a property’s page, on a button. Every point links to the record it came from.', scope: 'both', level: 'auto' },
  { key: 'buyer_matching', group: 'CRM & matching', icon: 'person_search', name: 'Buyer matching', description: "A new listing that fits a buyer's brief alerts that buyer's agent.", scope: 'both', level: 'auto' },
  { key: 'ai_import', group: 'CRM & matching', icon: 'upload_file', name: 'AI help for imports', description: 'Matches unusual column names and suggests fixes for failing rows when you import contacts.', scope: 'both', level: 'approval' },
  { key: 'ai_workflow_decisions', group: 'CRM & matching', icon: 'psychology', name: 'AI decisions in workflows', description: 'A workflow’s AI reads the enquiry and picks one of your options (seller, buyer, tenant…). Off: “Not sure” runs.', scope: 'both', level: 'auto' },
  { key: 'sale_anniversaries', group: 'Opportunities', icon: 'cake', name: 'Sale anniversaries', description: 'A home sold 5 or 10 years ago: a reason to call the owner.', scope: 'both', level: 'auto' },
  { key: 'cold_contacts', group: 'Opportunities', icon: 'ac_unit', name: 'Cold contact alerts', description: 'A buyer or seller with nothing in 90 days.', scope: 'both', level: 'auto' },
  { key: 'unanswered_emails', group: 'Opportunities', icon: 'mark_email_unread', name: 'Unanswered emails', description: 'An email from a client with no reply after 48 hours.', scope: 'both', level: 'auto' },
  { key: 'appraisal_follow_ups', group: 'Opportunities', icon: 'real_estate_agent', name: 'Appraisal follow-ups', description: 'An appraisal 3–30 days ago with nothing since.', scope: 'both', level: 'auto' },
  { key: 'repeat_interest', group: 'Opportunities', icon: 'replay', name: 'Repeat interest', description: 'Someone who keeps enquiring on listings.', scope: 'both', level: 'auto' },
  { key: 'dashboards', group: 'Insights', icon: 'dashboard', name: 'Dashboards', description: 'Ask for a dashboard in words and get a link you can keep open.', scope: 'both', level: 'approval' },
  { key: 'agency_performance', group: 'Insights', icon: 'monitoring', name: 'Agency performance answers', description: '"How did we do this quarter?" — open questions across every agent and listing.', scope: 'agency', level: 'auto' },
  { key: 'team_activity', group: 'Insights', icon: 'groups', name: 'Team activity', description: "Every agent's emails received and sent and their work, as a figure or a dashboard tile.", scope: 'agency', level: 'auto' },
  { key: 'knowledge_answers', group: 'Knowledge & team', icon: 'menu_book', name: 'Answers from documents', description: "The assistant answers from the agency's procedures and the documents on contacts and listings, and says which one.", scope: 'both', level: 'auto' },
  { key: 'team_meetings', group: 'Knowledge & team', icon: 'video_call', name: 'Team meetings', description: 'Book a meeting with colleagues by asking, with a Zoom link.', scope: 'both', level: 'approval', needs: 'Zoom' },
  { key: 'team_management', group: 'Knowledge & team', icon: 'manage_accounts', name: 'Team management by the assistant', description: 'Invite, change or remove an agent by asking. The Team page works either way.', scope: 'agency', level: 'approval' },
] satisfies PlatformSkill[]);

const BY_KEY = new Map(PLATFORM_SKILLS.map((s) => [s.key, s]));

export function platformSkill(key: SkillKey): PlatformSkill {
  return BY_KEY.get(key)!;
}

export function isSkillKey(value: unknown): value is SkillKey {
  return typeof value === 'string' && BY_KEY.has(value as SkillKey);
}

/** Whose switches a person holds: the agency's (owners, admins) or their own (everyone else). */
export type SwitchHolder = 'agency' | 'personal';

/** The skills a holder sees and is gated by: `agency` ones are never shown to — or applied to — anyone else. */
export function skillsForHolder(holder: SwitchHolder): readonly PlatformSkill[] {
  return holder === 'agency' ? PLATFORM_SKILLS : PLATFORM_SKILLS.filter((s) => s.scope === 'both');
}

/**
 * The assistant tools each skill gates (refused at run time when off). A tool in no list is never
 * gated — `switch_skill` and `find_skills` above all, so a switched-off person can always switch back.
 */
export const SKILL_OF_TOOL: Readonly<Record<string, SkillKey>> = Object.freeze({
  send_email: 'ai_email_drafts',
  create_listing_draft: 'ai_listing_copy',
  create_dashboard: 'dashboards',
  update_dashboard: 'dashboards',
  describe_data: 'agency_performance',
  query_data: 'agency_performance',
  search_documents: 'knowledge_answers',
  read_document: 'knowledge_answers',
  schedule_team_meeting: 'team_meetings',
  find_agents: 'team_management',
  update_agent: 'team_management',
  remove_agent: 'team_management',
  invite_agent: 'team_management',
});

/** The widget that is "Team activity": refused inside show_widget and dashboards while that skill is off. */
export const TEAM_ACTIVITY_WIDGET = 'agent_activity';

/**
 * Every skill one assistant call needs on: the tool's own, plus Team activity when the call shows or
 * saves the Agents widget. Pure, so the gate is testable without a database.
 */
export function skillsForToolCall(tool: string, input: unknown): SkillKey[] {
  const keys: SkillKey[] = [];
  const own = SKILL_OF_TOOL[tool];
  if (own) keys.push(own);
  const i = (input ?? {}) as { widget?: unknown; widgets?: unknown };
  const widgets = Array.isArray(i.widgets) ? i.widgets : [i];
  if (['show_widget', 'create_dashboard', 'update_dashboard'].includes(tool) && widgets.some((w) => (w as { widget?: unknown } | null)?.widget === TEAM_ACTIVITY_WIDGET)) {
    keys.push('team_activity');
  }
  return keys;
}

/** The opportunity detector behind each kind. */
export const SKILL_OF_OPPORTUNITY: Readonly<Record<OpportunityKind, SkillKey>> = Object.freeze({
  sale_anniversary: 'sale_anniversaries',
  cold_contact: 'cold_contacts',
  unanswered_mail: 'unanswered_emails',
  appraisal_follow_up: 'appraisal_follow_ups',
  repeat_interest: 'repeat_interest',
  buyer_match: 'buyer_matching',
});

/** The words every refusal uses, so the person (and the model) know where to switch it back. */
export function skillOffMessage(key: SkillKey, holder: SwitchHolder): string {
  const name = platformSkill(key).name;
  return holder === 'agency'
    ? `“${name}” is switched off for the agency in Skills. An owner or admin can turn it back on there, or ask the assistant to.`
    : `“${name}” is switched off for you in Skills. Turn it back on there, or ask the assistant to.`;
}
