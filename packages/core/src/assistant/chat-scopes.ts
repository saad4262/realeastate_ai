import { z } from 'zod';
import type { AssistantToolName, PlannableTool } from './schema';
import type { SkillKey } from '../skill-switches/catalog';

/**
 * The kinds of console chat (ADR 0088). A chat's scope is written once, when it is made, and everything
 * here is enforced on the server: the prompt never is what keeps a chat to its job. Null is a chat from
 * before this ADR, with every tool.
 */
export const CHAT_SCOPES = [
  'general',
  'daily_work',
  'email',
  'sms',
  'listing_copy',
  'dashboards',
  'team_meetings',
  'team_management',
  'ai_skills',
] as const;
export type ChatScope = (typeof CHAT_SCOPES)[number];
export const chatScopeSchema = z.enum(CHAT_SCOPES);

/** What a chat is called, to the model when it refuses and on screen. */
export const CHAT_SCOPE_LABELS: Readonly<Record<ChatScope, string>> = Object.freeze({
  general: 'Overview',
  daily_work: 'Daily work',
  email: 'Email',
  sms: 'SMS',
  listing_copy: 'Listing copy',
  dashboards: 'Dashboards',
  team_meetings: 'Team meetings',
  team_management: 'Team management',
  ai_skills: 'AI skills',
});

/** The chats a person can open today. A scope leaves this list only by being built; the server refuses any other. */
export const OPEN_CHAT_SCOPES = ['daily_work', 'email', 'sms', 'listing_copy', 'dashboards', 'team_meetings', 'team_management', 'ai_skills'] as const satisfies readonly ChatScope[];
export type OpenChatScope = (typeof OPEN_CHAT_SCOPES)[number];

/** The chats that were separate before Email and SMS each became one (ADR 0089). A chat saved under one carries on as the combined one. */
export const LEGACY_CHAT_SCOPES: Readonly<Record<string, 'email' | 'sms'>> = Object.freeze({
  bulk_email: 'email',
  ai_email_drafts: 'email',
  email_automations: 'email',
  bulk_sms: 'sms',
  sms_automations: 'sms',
});

/** What can be opened, as it may be stored: a list of chats filtered on the column must find the old names too. */
export const STORED_OPEN_CHAT_SCOPES: readonly string[] = Object.freeze([...OPEN_CHAT_SCOPES, ...Object.keys(LEGACY_CHAT_SCOPES)]);

export function isOpenChatScope(raw: string | null | undefined): raw is OpenChatScope {
  return (OPEN_CHAT_SCOPES as readonly (string | null | undefined)[]).includes(raw);
}

/** How a skill chat looks, so it is plainly not the Overview chat. */
export const CHAT_SCOPE_FACE: Readonly<Record<OpenChatScope, { icon: string; greeting: string; hint: string; suggestions: readonly string[] }>> = Object.freeze({
  daily_work: {
    icon: 'task_alt',
    greeting: 'What needs doing?',
    hint: 'Notes, lead status, reminders, appointments and contact details. You approve each change.',
    suggestions: ['Remind me tomorrow at 9 to call my new leads', 'Book an appraisal with this contact tomorrow at 3pm', 'Which leads came in this week?'],
  },
  email: {
    icon: 'mail',
    greeting: 'What should we email?',
    hint: 'This chat does your email: a send, a draft, or something that repeats. You approve it first.',
    suggestions: ['Show me my saved lists', 'Write a follow-up to my newest lead', 'Send a template to a list every Monday at 9am'],
  },
  sms: {
    icon: 'sms',
    greeting: 'What should we text?',
    hint: 'This chat does your texts: a send now, or something that repeats. You approve it first.',
    suggestions: ['Show me my saved lists', 'Which SMS templates do I have?', 'Text a template to a list every Monday at 10am'],
  },
  listing_copy: {
    icon: 'description',
    greeting: 'Which listing are we writing?',
    hint: 'This chat only drafts and updates listings. Nothing goes live without approval.',
    suggestions: ['Show me my draft listings', 'Draft a listing for a three-bedroom house'],
  },
  dashboards: {
    icon: 'dashboard',
    greeting: 'What should this dashboard show?',
    hint: 'This chat only builds dashboards. One chat, one dashboard.',
    suggestions: ['Build a dashboard of leads by source this month', 'A dashboard of my live listings and their enquiries'],
  },
  team_meetings: {
    icon: 'video_call',
    greeting: 'Who is meeting?',
    hint: 'This chat only books meetings between colleagues.',
    suggestions: ['Book a team meeting tomorrow at 10am', 'Who is in my team?'],
  },
  team_management: {
    icon: 'manage_accounts',
    greeting: 'What should change in the team?',
    hint: 'This chat only invites, changes and removes agents. You approve each change.',
    suggestions: ['Show me the team', 'Invite a new agent'],
  },
  ai_skills: {
    icon: 'auto_awesome',
    greeting: 'What should run for you?',
    hint: 'This chat only sets up your scheduled AI skills, such as Morning Brief.',
    suggestions: ['Which AI skills do I have?', 'Send me a brief every weekday at 7am'],
  },
});

/**
 * Overview reads and answers, and hands anything else to the right chat (ADR 0088). Off until
 * `ASSISTANT_OVERVIEW_READ_ONLY=1`, so it can be turned on, and back off, without a deploy of code.
 */
export function overviewIsReadOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ASSISTANT_OVERVIEW_READ_ONLY?.trim() === '1';
}

/** How the Overview chat presents itself once it only reads. */
export const OVERVIEW_FACE = Object.freeze({
  hint: 'Looks things up and answers. To change or send something, it opens the right chat.',
  suggestions: ['Which leads came in this week?', 'What’s on my calendar tomorrow?', 'Is my Google Calendar connected?', 'What’s our sold value this month?'],
});

/** The platform skill a chat belongs to: the reverse of the chat a card opens. */
export function skillKeyOfChatScope(raw: string | null): string | null {
  const scope = raw ? (LEGACY_CHAT_SCOPES[raw] ?? raw) : null;
  if (scope === 'email' || scope === 'sms') return scope;
  return Object.entries(CHAT_OF_SKILL).find(([, chat]) => chat === scope)?.[0] ?? null;
}

/** The chat a Skills card opens, by the skill's key. */
export function chatScopeOfSkill(key: string): OpenChatScope | null {
  return CHAT_OF_SKILL[key] ?? null;
}

const CHAT_OF_SKILL: Readonly<Record<string, OpenChatScope>> = Object.freeze({
  email: 'email',
  bulk_email: 'email',
  ai_email_drafts: 'email',
  workflow_emails: 'email',
  sms: 'sms',
  bulk_sms: 'sms',
  workflow_texts: 'sms',
  ai_listing_copy: 'listing_copy',
  dashboards: 'dashboards',
  team_meetings: 'team_meetings',
  team_management: 'team_management',
});

type WorkflowStep = 'send_template_email' | 'send_template_sms' | 'draft_email';

type ScopeRule = {
  tools: readonly AssistantToolName[];
  /** The switch in Skills this chat's actions need on: asked when a chat starts, at each action, and at Approve. */
  skill?: SkillKey;
  /** In a chat made of several skills: the switch each action answers to, and any one of which lets it start. */
  toolSkills?: Readonly<Partial<Record<string, SkillKey>>>;
  openSkills?: readonly SkillKey[];
  /** Owners and admins only, whatever the URL says: an agent would have a chat with no tools in it. */
  adminOnly?: true;
  /** A card this chat can make that is none of its tools: a long bulk email becomes a plan. */
  cards?: readonly string[];
  /** The templates this chat lists. Set here, never by the model. */
  channel?: 'email' | 'sms';
  /** The only steps a `plan_task` here may hold. */
  planSteps?: readonly PlannableTool[];
  /** Workflow steps that reach someone by the OTHER channel. */
  refusedWorkflowSteps?: readonly WorkflowStep[];
};

const EVERY_CHAT = ['check_cards', 'report_missing_data'] as const satisfies readonly AssistantToolName[];

const SEND_READS = ['find_contacts', 'find_leads', 'find_saved_lists', 'list_templates', 'check_connections', 'find_workflows', 'find_listings', 'find_team_members', 'find_colleagues'] as const satisfies readonly AssistantToolName[];

const BUILD_TOOLS = ['create_workflow', 'change_workflow'] as const satisfies readonly AssistantToolName[];

export const CHAT_SCOPE_RULES: Readonly<Record<ChatScope, ScopeRule>> = Object.freeze({
  general: {
    tools: [...EVERY_CHAT, 'find_contacts', 'find_leads', 'find_appointments', 'find_listings', 'find_buyers', 'find_deals', 'find_team_members', 'find_agents', 'find_colleagues', 'find_saved_lists', 'find_skills', 'find_workflows', 'list_templates', 'check_connections', 'show_widget', 'search_notes_and_emails', 'describe_data', 'query_data', 'search_documents', 'read_document', 'open_chat'],
  },
  daily_work: {
    tools: [...EVERY_CHAT, 'find_contacts', 'find_leads', 'find_appointments', 'find_listings', 'find_buyers', 'find_deals', 'find_team_members', 'find_colleagues', 'search_notes_and_emails', 'check_connections', 'start_import', 'add_note', 'set_next_action', 'schedule_appointment', 'reschedule_appointment', 'cancel_appointment', 'set_lead_status', 'assign_lead', 'create_lead', 'create_contact', 'update_contact', 'set_contact_archived', 'record_marketing_consent', 'withdraw_marketing_consent', 'assign_contacts', 'create_reminder', 'plan_task', 'cancel_task', 'message_colleagues'],
    planSteps: ['add_note', 'set_next_action', 'schedule_appointment', 'reschedule_appointment', 'cancel_appointment', 'message_colleagues', 'record_marketing_consent', 'withdraw_marketing_consent', 'update_contact', 'set_contact_archived', 'assign_contacts', 'set_lead_status', 'assign_lead', 'create_lead', 'create_contact', 'remind'],
  },
  email: {
    tools: [...EVERY_CHAT, ...SEND_READS, 'search_notes_and_emails', 'send_template_email', 'send_email', 'create_template', 'create_automation', ...BUILD_TOOLS],
    skill: 'bulk_email',
    openSkills: ['bulk_email', 'ai_email_drafts', 'workflow_emails'],
    toolSkills: { send_email: 'ai_email_drafts', create_workflow: 'workflow_emails', change_workflow: 'workflow_emails' },
    // A long send becomes a plan (ADR 0040); a repeating one is stored as a create_workflow card (ADR 0089).
    cards: ['plan_task'],
    channel: 'email',
    refusedWorkflowSteps: ['send_template_sms'],
  },
  sms: {
    tools: [...EVERY_CHAT, ...SEND_READS, 'send_template_sms', 'create_automation', ...BUILD_TOOLS],
    skill: 'bulk_sms',
    openSkills: ['bulk_sms', 'workflow_texts'],
    toolSkills: { create_workflow: 'workflow_texts', change_workflow: 'workflow_texts' },
    channel: 'sms',
    refusedWorkflowSteps: ['send_template_email', 'draft_email'],
  },
  listing_copy: {
    tools: [...EVERY_CHAT, 'find_listings', 'find_contacts', 'create_listing_draft', 'update_listing', 'withdraw_listing', 'submit_listing'],
    skill: 'ai_listing_copy',
  },
  dashboards: {
    tools: [...EVERY_CHAT, 'describe_data', 'query_data', 'show_widget', 'create_dashboard', 'update_dashboard'],
    skill: 'dashboards',
  },
  team_meetings: {
    tools: [...EVERY_CHAT, 'find_colleagues', 'find_appointments', 'check_connections', 'schedule_team_meeting'],
    skill: 'team_meetings',
  },
  team_management: {
    tools: [...EVERY_CHAT, 'find_agents', 'find_team_members', 'update_agent', 'remove_agent', 'invite_agent'],
    skill: 'team_management',
    adminOnly: true,
  },
  ai_skills: {
    tools: [...EVERY_CHAT, 'find_skills', 'check_connections', 'set_up_skill', 'change_skill'],
  },
});

/** The action tools more than one chat holds. Each is limited by its input or its channel, and says so above. */
export const SHARED_ACTION_TOOLS = ['create_workflow', 'change_workflow', 'create_automation'] as const satisfies readonly AssistantToolName[];
/** The action tools no scoped chat holds: a chat must not switch another skill on or off. */
export const UNSCOPED_ACTION_TOOLS = ['switch_skill'] as const satisfies readonly AssistantToolName[];

/** Tools only a skill chat has: a chat from before ADR 0088 is never given one, in its list or at run time. */
export const SCOPE_ONLY_TOOLS = ['send_template_sms', 'open_chat', 'create_automation'] as const satisfies readonly AssistantToolName[];

/** A stored value. One this code does not know gets the fewest tools, never every tool. */
export function parseChatScope(raw: string | null | undefined): ChatScope | null {
  if (raw === null || raw === undefined) return null;
  const name = LEGACY_CHAT_SCOPES[raw] ?? raw;
  return (CHAT_SCOPES as readonly string[]).includes(name) ? (name as ChatScope) : 'general';
}

/** Which templates to list: the chat's channel when it has one, whatever the model asked for. */
export function templateChannel(scope: ChatScope | null, asked: 'email' | 'sms' | undefined): 'email' | 'sms' {
  return (scope ? CHAT_SCOPE_RULES[scope].channel : undefined) ?? asked ?? 'email';
}

function workflowStepTypes(input: unknown): string[] {
  const i = (input ?? {}) as { actions?: { type?: string }[]; decide?: { choices?: { actions?: { type?: string }[] }[] } };
  const all = [...(i.actions ?? []), ...(i.decide?.choices ?? []).flatMap((c) => c.actions ?? [])];
  return all.map((a) => a.type ?? '');
}

/** The switch this chat's action answers to. */
export function chatScopeSkillFor(scope: ChatScope, tool: string): SkillKey | undefined {
  const rule = CHAT_SCOPE_RULES[scope];
  return rule.toolSkills?.[tool] ?? rule.skill;
}

/** Why this chat may not make this call, or null when it may. `input` has already passed the tool's schema. */
export function chatScopeRefusal(scope: ChatScope | null, tool: AssistantToolName, input: unknown): string | null {
  if (!scope) return (SCOPE_ONLY_TOOLS as readonly string[]).includes(tool) ? 'That is only available in its own chat, from Skills. Nothing was done.' : null;
  const rule = CHAT_SCOPE_RULES[scope];
  const name = CHAT_SCOPE_LABELS[scope];
  const outside = `This is the ${name} chat, and that is not part of it. Nothing was done. Tell the person it belongs in another chat.`;
  if (!rule.tools.includes(tool)) return outside;
  if (tool === 'plan_task') {
    const steps = ((input ?? {}) as { steps?: { tool?: string }[] }).steps ?? [];
    if (steps.some((s) => !(rule.planSteps as readonly (string | undefined)[] | undefined)?.includes(s.tool))) return outside;
  }
  if (tool === 'create_workflow' && workflowStepTypes(input).some((t) => (rule.refusedWorkflowSteps as readonly string[] | undefined)?.includes(t))) return outside;
  return null;
}

/** May a card with this tool be approved in this chat? `remind` is a step of a plan, never a tool of its own. */
export function chatScopeAllowsCard(scope: ChatScope | null, tool: string): boolean {
  if (!scope) return true;
  const tools = CHAT_SCOPE_RULES[scope].tools as readonly string[];
  if (CHAT_SCOPE_RULES[scope].cards?.includes(tool)) return true;
  return tool === 'remind' ? tools.includes('plan_task') : tools.includes(tool);
}

/** May this chat see or change a stored workflow, which holds these step types? */
export function workflowFitsChat(scope: ChatScope | null, stepTypes: readonly string[]): boolean {
  const refused = scope ? (CHAT_SCOPE_RULES[scope].refusedWorkflowSteps as readonly string[] | undefined) : undefined;
  return !stepTypes.some((t) => refused?.includes(t));
}
