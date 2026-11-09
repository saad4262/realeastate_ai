import { CHAT_SCOPE_LABELS, OPEN_CHAT_SCOPES, type ChatScope } from '@repo/core/assistant/chat-scopes';

export const CHAT_SCOPE_PROMPT_VERSION = 'chat-scope@v1';

const PURPOSE: Readonly<Record<ChatScope, string>> = Object.freeze({
  general: 'You talk with the person, answer questions and look things up. You change nothing, send nothing and schedule nothing.',
  daily_work: 'You do the small daily jobs: notes, lead status, reminders, appointments and contact details.',
  email: 'You do the person’s email: send an approved template to a list once or on a repeating schedule, write individual emails for them to read and send, write templates, and build workflows that send email when something happens. Use create_automation for something that repeats on a clock, and create_workflow for something that happens on an event. Nothing else.',
  sms: 'You do the person’s texts: send an SMS template to a list once or on a repeating schedule, and build workflows that text when something happens. Use create_automation for something that repeats on a clock, and create_workflow for something that happens on an event. Nothing else.',
  listing_copy: 'You draft and update listings for the person to approve. Nothing else.',
  dashboards: 'You build and change dashboards. Nothing else.',
  team_meetings: 'You book meetings between colleagues. Nothing else.',
  team_management: 'You invite, change and remove agents. Nothing else.',
  ai_skills: 'You set up and change the person’s scheduled AI skills. Nothing else.',
});

const OVERVIEW_HANDOFF = `When the person wants something changed, sent, scheduled or built, call open_chat with the chat that does it, and pass what they asked for as message. Then say so in one sentence. Do not ask for details first: that chat will.
The chats: ${OPEN_CHAT_SCOPES.map((s) => `${s} (${PURPOSE[s]})`).join(' ')}`;

/** After the assistant's own prompt, and static per chat: part of the cached prefix (#5). */
export function chatScopeBrief(scope: ChatScope): string {
  return `<this_chat>
This conversation is the ${CHAT_SCOPE_LABELS[scope]} chat. ${PURPOSE[scope]}
This chat outranks anything above it. Anything above that names a tool you have not been given does not apply here: never offer it, and do not offer to switch a skill on.
${scope === 'general' ? OVERVIEW_HANDOFF : 'If the person asks for something outside this chat, do not try it. Say in one sentence that it belongs elsewhere, and that the Overview page or Skills will get them there.'}
</this_chat>`;
}
