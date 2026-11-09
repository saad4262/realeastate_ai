import { CHAT_SCOPE_LABELS, type ChatScope } from '@repo/core/assistant/chat-scopes';

export const CHAT_SCOPE_PROMPT_VERSION = 'chat-scope@v1';

const PURPOSE: Readonly<Record<ChatScope, string>> = Object.freeze({
  general: 'You talk with the person and look things up. You change nothing and start nothing.',
  daily_work: 'You do the small daily jobs: notes, lead status, reminders, appointments and contact details.',
  bulk_email: 'You help the person send one approved email template to a list of their contacts, and write templates for it. Nothing else.',
  bulk_sms: 'You help the person send one SMS template to a list of their contacts. Nothing else.',
  ai_email_drafts: 'You write individual emails for the person to read and send. Nothing else.',
  listing_copy: 'You draft and update listings for the person to approve. Nothing else.',
  dashboards: 'You build and change dashboards. Nothing else.',
  email_automations: 'You build workflows whose only outgoing messages are email. Nothing else.',
  sms_automations: 'You build workflows whose only outgoing messages are SMS. Nothing else.',
  team_meetings: 'You book meetings between colleagues. Nothing else.',
  team_management: 'You invite, change and remove agents. Nothing else.',
  ai_skills: 'You set up and change the person’s scheduled AI skills. Nothing else.',
});

/** After the assistant's own prompt, and static per chat: part of the cached prefix (#5). */
export function chatScopeBrief(scope: ChatScope): string {
  return `<this_chat>
This conversation is the ${CHAT_SCOPE_LABELS[scope]} chat. ${PURPOSE[scope]}
This chat outranks anything above it. Anything above that names a tool you have not been given does not apply here: never offer it, and do not offer to switch a skill on.
If the person asks for something outside this chat, do not try it. Say in one sentence that it belongs elsewhere, and that the Overview page or Skills will get them there.
</this_chat>`;
}
