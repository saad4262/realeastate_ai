import type { OpenChatScope } from '../assistant/chat-scopes';
import type { ActorUsage } from '../usage/usage';

/** The Activity panel's shape and links (ADR 0088). No database here: the browser imports this file. */

export type AutomationItem = {
  key: string;
  /** `send_plan`: a bulk email sent in parts over days, counted in people. */
  kind: 'batch' | 'send_plan' | 'task' | 'skill_run';
  /** A batch's channel. Null for anything else. */
  channel: 'email' | 'sms' | null;
  state: 'running' | 'failed';
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

export type ActiveAutomation = {
  key: string;
  kind: 'workflow' | 'skill';
  title: string;
  owner: string | null;
  mine: boolean;
  targetId: string;
  /** A skill's next run. */
  nextAt: string | null;
  /** A workflow's latest run. */
  lastAt: string | null;
  /** A workflow's runs in the last 24 hours. Null for a skill. */
  runsToday: number | null;
  /** Why the system paused a workflow, when it did. */
  pausedReason: string | null;
  /** May this person pause, resume or switch it off? */
  canManage: boolean;
};

/** A skill from the Skills page that is on for this person. `chat`: the chat that does it, when it has one. */
export type SwitchedOnSkill = { key: string; name: string; icon: string; chat: OpenChatScope | null };

/** The top bar's Skills panel: the ready-made skills that are on. `mayManage`: this person may flip the switches. */
export type SkillsPanel = { skills: SwitchedOnSkill[]; mayManage: boolean };

export type AutomationStatus = {
  running: AutomationItem[];
  failed: AutomationItem[];
  active: ActiveAutomation[];
  /** Workflows that are paused, so they can be turned back on. */
  paused: ActiveAutomation[];
  /** How many are active in all; `active` holds the first few of each kind. */
  activeTotal: number;
  usage: ActorUsage | null;
};

export type AutomationPaths = { home: string; email: string; sms: string; skills: string };

/** A skill with a chat opens it. One that runs by itself goes to the skills that are on. */
export function switchedOnHref(skill: SwitchedOnSkill, paths: AutomationPaths): string {
  return skill.chat ? `${paths.home}?chat=${skill.chat}` : `${paths.skills}?show=on`;
}

/** Where a row goes. Null when the page behind it is only its owner's: a chat, or an agent's own skill. */
export function automationHref(item: AutomationItem | ActiveAutomation, paths: AutomationPaths): string | null {
  if (item.kind === 'batch') return `${(item as AutomationItem).channel === 'sms' ? paths.sms : paths.email}/${item.targetId}`;
  if (item.kind === 'workflow') return `${paths.skills}?tab=automations`;
  if (!item.mine) return null;
  if (item.kind === 'task' || item.kind === 'send_plan') {
    const chat = (item as AutomationItem).conversationId;
    return chat ? `${paths.home}?c=${chat}` : null;
  }
  return `${paths.skills}/${item.targetId}`;
}
