import { z } from 'zod';
import type { AssistantToolName, PlannableTool } from './schema';

/**
 * The kinds of console chat (ADR 0088). A chat's scope is written once, when it is made, and everything
 * here is enforced on the server: the prompt never is what keeps a chat to its job. Null is a chat from
 * before this ADR, with every tool.
 */
export const CHAT_SCOPES = [
  'general',
  'daily_work',
  'bulk_email',
  'bulk_sms',
  'ai_email_drafts',
  'listing_copy',
  'dashboards',
  'email_automations',
  'sms_automations',
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
  bulk_email: 'Bulk email',
  bulk_sms: 'Bulk SMS',
  ai_email_drafts: 'AI email drafts',
  listing_copy: 'Listing copy',
  dashboards: 'Dashboards',
  email_automations: 'Email automations',
  sms_automations: 'SMS automations',
  team_meetings: 'Team meetings',
  team_management: 'Team management',
  ai_skills: 'AI skills',
});

type WorkflowStep = 'send_template_email' | 'send_template_sms' | 'draft_email';

type ScopeRule = {
  tools: readonly AssistantToolName[];
  /** The templates this chat lists. Set here, never by the model. */
  channel?: 'email' | 'sms';
  /** The only steps a `plan_task` here may hold. */
  planSteps?: readonly PlannableTool[];
  /** Workflow steps that reach someone by the OTHER channel. */
  refusedWorkflowSteps?: readonly WorkflowStep[];
};

const EVERY_CHAT = ['check_cards', 'report_missing_data'] as const satisfies readonly AssistantToolName[];

const AUTOMATION_TOOLS = [...EVERY_CHAT, 'find_workflows', 'find_listings', 'find_team_members', 'find_colleagues', 'check_connections', 'list_templates', 'create_workflow', 'change_workflow'] as const satisfies readonly AssistantToolName[];

export const CHAT_SCOPE_RULES: Readonly<Record<ChatScope, ScopeRule>> = Object.freeze({
  general: {
    tools: [...EVERY_CHAT, 'find_contacts', 'find_leads', 'find_appointments', 'find_listings', 'find_buyers', 'find_deals', 'find_team_members', 'find_agents', 'find_colleagues', 'find_saved_lists', 'find_skills', 'find_workflows', 'list_templates', 'check_connections', 'show_widget', 'search_notes_and_emails', 'describe_data', 'query_data', 'search_documents', 'read_document'],
  },
  daily_work: {
    tools: [...EVERY_CHAT, 'find_contacts', 'find_leads', 'find_appointments', 'find_listings', 'find_buyers', 'find_deals', 'find_team_members', 'find_colleagues', 'search_notes_and_emails', 'check_connections', 'start_import', 'add_note', 'set_next_action', 'schedule_appointment', 'reschedule_appointment', 'cancel_appointment', 'set_lead_status', 'assign_lead', 'create_lead', 'create_contact', 'update_contact', 'set_contact_archived', 'record_marketing_consent', 'withdraw_marketing_consent', 'assign_contacts', 'create_reminder', 'plan_task', 'cancel_task', 'message_colleagues'],
    planSteps: ['add_note', 'set_next_action', 'schedule_appointment', 'reschedule_appointment', 'cancel_appointment', 'message_colleagues', 'record_marketing_consent', 'withdraw_marketing_consent', 'update_contact', 'set_contact_archived', 'assign_contacts', 'set_lead_status', 'assign_lead', 'create_lead', 'create_contact', 'remind'],
  },
  bulk_email: {
    tools: [...EVERY_CHAT, 'find_contacts', 'find_leads', 'find_saved_lists', 'list_templates', 'check_connections', 'send_template_email', 'create_template'],
    channel: 'email',
  },
  bulk_sms: {
    tools: [...EVERY_CHAT, 'find_contacts', 'find_leads', 'find_saved_lists', 'list_templates', 'check_connections'],
    channel: 'sms',
  },
  ai_email_drafts: {
    tools: [...EVERY_CHAT, 'find_contacts', 'find_leads', 'search_notes_and_emails', 'check_connections', 'send_email'],
  },
  listing_copy: {
    tools: [...EVERY_CHAT, 'find_listings', 'find_contacts', 'create_listing_draft', 'update_listing', 'withdraw_listing', 'submit_listing'],
  },
  dashboards: {
    tools: [...EVERY_CHAT, 'describe_data', 'query_data', 'show_widget', 'create_dashboard', 'update_dashboard'],
  },
  email_automations: {
    tools: [...AUTOMATION_TOOLS, 'create_template'],
    channel: 'email',
    refusedWorkflowSteps: ['send_template_sms'],
  },
  sms_automations: {
    tools: AUTOMATION_TOOLS,
    channel: 'sms',
    refusedWorkflowSteps: ['send_template_email', 'draft_email'],
  },
  team_meetings: {
    tools: [...EVERY_CHAT, 'find_colleagues', 'find_appointments', 'check_connections', 'schedule_team_meeting'],
  },
  team_management: {
    tools: [...EVERY_CHAT, 'find_agents', 'find_team_members', 'update_agent', 'remove_agent', 'invite_agent'],
  },
  ai_skills: {
    tools: [...EVERY_CHAT, 'find_skills', 'check_connections', 'set_up_skill', 'change_skill'],
  },
});

/** The action tools more than one chat holds. Each is limited by its input or its channel, and says so above. */
export const SHARED_ACTION_TOOLS = ['create_template', 'create_workflow', 'change_workflow'] as const satisfies readonly AssistantToolName[];
/** The action tools no scoped chat holds: a chat must not switch another skill on or off. */
export const UNSCOPED_ACTION_TOOLS = ['switch_skill'] as const satisfies readonly AssistantToolName[];

/** A stored value. One this code does not know gets the fewest tools, never every tool. */
export function parseChatScope(raw: string | null | undefined): ChatScope | null {
  if (raw === null || raw === undefined) return null;
  return (CHAT_SCOPES as readonly string[]).includes(raw) ? (raw as ChatScope) : 'general';
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

/** Why this chat may not make this call, or null when it may. `input` has already passed the tool's schema. */
export function chatScopeRefusal(scope: ChatScope | null, tool: AssistantToolName, input: unknown): string | null {
  if (!scope) return null;
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
  return tool === 'remind' ? tools.includes('plan_task') : tools.includes(tool);
}
