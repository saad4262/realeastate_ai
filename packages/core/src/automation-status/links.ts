import type { ActorUsage } from '../usage/usage';

/** The Activity panel's shape and links (ADR 0088). No database here: the browser imports this file. */

export type AutomationItem = {
  key: string;
  kind: 'batch' | 'task' | 'skill_run';
  /** A batch's channel. Null for anything else. */
  channel: 'email' | 'sms' | null;
  state: 'running' | 'failed';
  title: string;
  /** The saved list a batch went to. */
  subtitle: string | null;
  /** Sent, or steps done. */
  done: number;
  total: number;
  failed: number;
  /** When a task's next step runs. */
  nextAt: string | null;
  error: string | null;
  /** Whose it is, when it is not the person looking. */
  owner: string | null;
  mine: boolean;
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
};

export type AutomationStatus = {
  running: AutomationItem[];
  failed: AutomationItem[];
  active: ActiveAutomation[];
  /** How many are active in all; `active` holds the first few of each kind. */
  activeTotal: number;
  usage: ActorUsage | null;
};

export type AutomationPaths = { home: string; email: string; sms: string; skills: string };

/** Where a row goes. Null when the page behind it is only its owner's: a chat, or an agent's own skill. */
export function automationHref(item: AutomationItem | ActiveAutomation, paths: AutomationPaths): string | null {
  if (item.kind === 'batch') return `${(item as AutomationItem).channel === 'sms' ? paths.sms : paths.email}/${item.targetId}`;
  if (item.kind === 'workflow') return `${paths.skills}?tab=automations`;
  if (!item.mine) return null;
  if (item.kind === 'task') {
    const chat = (item as AutomationItem).conversationId;
    return chat ? `${paths.home}?c=${chat}` : null;
  }
  return `${paths.skills}/${item.targetId}`;
}
