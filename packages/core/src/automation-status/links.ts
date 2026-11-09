import type { OpenChatScope } from '../assistant/chat-scopes';
import type { ActorUsage } from '../usage/usage';

/** The Activity panel's shape and links (ADR 0088). No database here: the browser imports this file. */

export type AutomationItem = {
  key: string;
  /** `send_plan`: a bulk email sent in parts over days, counted in people. `automation_run`: one run of a repeating automation. */
  kind: 'batch' | 'send_plan' | 'task' | 'skill_run' | 'automation_run';
  /** A batch's channel. Null for anything else. */
  channel: 'email' | 'sms' | null;
  state: 'running' | 'failed' | 'done';
  title: string;
  /** The saved list a batch went to. */
  subtitle: string | null;
  /** Sent, or steps done. */
  done: number;
  /** A send_plan's parts: how many have gone, of how many. */
  parts: { done: number; total: number } | null;
  total: number;
  failed: number;
  /** When a task's next step runs. */
  nextAt: string | null;
  error: string | null;
  /** Whose it is, when it is not the person looking. */
  owner: string | null;
  mine: boolean;
  /** May this person stop what is left of it? */
  canStop: boolean;
  /** The batch, task, or the agent's own skill. */
  targetId: string;
  conversationId: string | null;
};

/** A skill from the Skills page that is on for this person. `chat`: the chat that does it, when it has one. */
export type SwitchedOnSkill = {
  key: string;
  name: string;
  icon: string;
  chat: OpenChatScope | null;
  /** What has been set up with this skill. */
  automations: { key: string; name: string; state: 'active' | 'off' | 'finished'; conversationId: string | null }[];
  /** Its recent chats. */
  chats: { id: string; title: string }[];
};

/** The top bar's Skills panel: the ready-made skills that are on. `mayManage`: this person may flip the switches. */
export type SkillsPanel = { skills: SwitchedOnSkill[]; mayManage: boolean };

export type AutomationStatus = {
  running: AutomationItem[];
  failed: AutomationItem[];
  /** Repeating automations that finished in the last day, with when they go next. */
  finished: AutomationItem[];
  usage: ActorUsage | null;
};

export type AutomationPaths = { home: string; email: string; sms: string; skills: string };

/** A skill with a chat opens it. One that runs by itself goes to the skills that are on. */
export function switchedOnHref(skill: SwitchedOnSkill, paths: AutomationPaths): string {
  return skill.chat ? `${paths.home}?chat=${skill.chat}` : `${paths.skills}?show=on`;
}

/** Where a row goes. Null when the page behind it is only its owner's: a chat, or an agent's own skill. */
export function automationHref(item: AutomationItem, paths: AutomationPaths): string | null {
  if (item.kind === 'batch') return `${item.channel === 'sms' ? paths.sms : paths.email}/${item.targetId}`;
  if (item.kind === 'automation_run') return item.mine && item.conversationId ? `${paths.home}?c=${item.conversationId}` : `${paths.skills}?tab=automations`;
  if (!item.mine) return null;
  if (item.kind === 'task' || item.kind === 'send_plan') return item.conversationId ? `${paths.home}?c=${item.conversationId}` : null;
  return `${paths.skills}/${item.targetId}`;
}
