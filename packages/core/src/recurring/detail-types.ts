import type { AutomationRow } from './list';

/** One automation in full, for the details panel (the user, 2026-11-10). No database here: the browser imports it. */

export type RunProgress = { id: string; status: string; at: string; finishedAt: string | null; total: number; sent: number; failed: number; skipped: number; remaining: number; detail: string | null; manual: boolean };

export type AutomationDetail = AutomationRow & {
  /** The run going now, with what is left. */
  current: RunProgress | null;
  /** Earlier runs, newest first. */
  runs: RunProgress[];
  /** A one-off task's steps, in order. */
  steps: { title: string; status: string; at: string | null; error: string | null }[];
  /** May this person stop the run going now (or a task's later steps)? */
  canStop: boolean;
};

export const AUTOMATION_KEY = /^(recurring|workflow|task|ai_skill):[0-9a-f-]{36}$/i;

/** Its own chat, with the panel beside it, when it is this person's; otherwise the panel on Skills. A chat is only its author's. */
export function automationRowHref(row: Pick<AutomationRow, 'key' | 'mine' | 'conversationId'>, home: string, base: string): string {
  return row.mine && row.conversationId ? `${home}?c=${row.conversationId}&automation=${row.key}` : `${base}&open=${row.key}`;
}

export type AutomationFilter = 'all' | 'active' | 'off' | 'finished';

/** The Automations tab's search and filter: words anywhere in its name, what it does, its skill, when, or whose it is. */
export function filterAutomations<T extends Pick<AutomationRow, 'name' | 'what' | 'skill' | 'when' | 'owner' | 'state'>>(rows: readonly T[], query: string, filter: AutomationFilter): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => {
    if (filter !== 'all' && r.state !== filter) return false;
    const text = [r.name, r.what, r.skill, r.when, r.owner ?? ''].join(' ').toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** The icon a row shows: its skill's. */
export function automationIcon(row: Pick<AutomationRow, 'source' | 'skillKey'>): string {
  if (row.skillKey === 'email') return 'mail';
  if (row.skillKey === 'sms') return 'sms';
  if (row.source === 'ai_skill') return 'auto_awesome';
  if (row.source === 'task') return 'task_alt';
  return 'account_tree';
}
