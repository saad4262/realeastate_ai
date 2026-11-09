import type { z } from 'zod';
import { can } from '../permissions';
import { isSkillOnForChat } from '../skill-switches/switches';
import { CHAT_SCOPE_LABELS, CHAT_SCOPE_RULES } from './chat-scopes';
import type { ASSISTANT_TOOL_INPUTS } from './schema';
import type { ToolContext, ToolOutcome } from './tools';

/**
 * Overview's way out (ADR 0088): a button into the chat that can do the job. It changes nothing. What the
 * person asked for is typed into that chat's box, where they read it and press Send themselves.
 */
export async function openChatTool(ctx: ToolContext, input: z.infer<typeof ASSISTANT_TOOL_INPUTS.open_chat>, label: string): Promise<ToolOutcome> {
  const { actor, db } = ctx;
  const rule = CHAT_SCOPE_RULES[input.chat];
  const name = CHAT_SCOPE_LABELS[input.chat];
  if (rule.adminOnly && !can(actor, 'team:manage', { type: 'team', agencyId: actor.agencyId })) {
    return { label, result: { button_shown: false, tell_the_user: `Only an owner or admin can use the ${name} chat.` } };
  }
  const on = !rule.skill || (await isSkillOnForChat(db, actor, rule.skill));
  return {
    label,
    frame: { kind: 'open_chat', scope: input.chat, name, on, ask: on ? (input.message ?? null) : null },
    result: {
      button_shown: true,
      tell_the_user: on ? `A button to open the ${name} chat is on the screen. Tell the person in one sentence. Do not do the job here.` : `${name} is switched off. A button to Skills is on the screen, where it can be switched on. Tell the person in one sentence.`,
    },
  };
}
