import type { AutomationRow } from './list';

/** One automation in full, for the details panel (the user, 2026-11-10). No database here: the browser imports it. */

export type RunProgress = { id: string; status: string; at: string; finishedAt: string | null; total: number; sent: number; failed: number; skipped: number; remaining: number; detail: string | null; manual: boolean; /** ADR 0106: a workflow's run still going that this person may stop. */ canStop?: boolean;
  /** ADR 0106 part 3, a workflow's run: who it is for, and each step with its time — or, not yet due, how long after the one before. */
  who?: string | null;
  steps?: AutomationStep[] };

/** A step of a one-off task or of a workflow's run. `after`: a step not yet due, in words ("2 h after the step before"). */
export type AutomationStep = { title: string; status: string; at: string | null; error: string | null; after?: string | null };

export type AutomationDetail = AutomationRow & {
  /** The run going now, with what is left. */
  current: RunProgress | null;
  /** Earlier runs, newest first. */
  runs: RunProgress[];
  /** A one-off task's steps, in order. */
  steps: AutomationStep[];
  /** May this person stop the run going now (or a task's later steps)? */
  canStop: boolean;
};

export const AUTOMATION_KEY = /^(recurring|workflow|task|ai_skill):[0-9a-f-]{36}$/i;

/** Something approved once in a chat (the user, 2026-11-23): a send, a booking, a change. Beside the chat with its automations. */
export const CHAT_ACTION_KEY = /^action:[0-9a-f-]{36}$/i;

export type ChatActionDetail = {
  key: string;
  /** The card's tool, for its icon. */
  tool: string;
  name: string;
  /** The card's status: approved, scheduled, running, done, failed. */
  status: string;
  /** What the card said it would do, as approved. */
  lines: { label: string; value: string }[];
  decidedAt: string | null;
  runAt: string | null;
  finishedAt: string | null;
  error: string | null;
  /** A bulk email or text: how far it has got, and every person in it with what happened to them. */
  send: {
    channel: 'email' | 'sms';
    batchId: string;
    total: number;
    sent: number;
    failed: number;
    skipped: number;
    /** Not sent yet: waiting, or going out now. */
    left: number;
    people: { name: string; to: string | null; status: 'queued' | 'sending' | 'sent' | 'failed' | 'skipped'; why: string | null; at: string | null }[];
  } | null;
};

/**
 * A provider's refusal as a person reads it. The transport stores `Resend 422: {"message":"…"}`; the panel shows the message,
 * and a 5xx as the service's problem, not the person's.
 */
export function readableSendError(raw: string | null): string | null {
  if (!raw) return null;
  const m = /^\w+ (\d{3}):\s*([\s\S]*)$/.exec(raw.trim());
  if (!m) return raw;
  if (Number(m[1]) >= 500) return `The sending service had a problem (${m[1]}). It can be tried again later.`;
  let message = m[2]!.trim();
  try {
    const body = JSON.parse(message) as { message?: unknown };
    if (typeof body.message === 'string' && body.message.trim()) message = body.message.trim();
  } catch {
    // Not JSON: the text as it came.
  }
  return `Refused by the sending service: ${message}`;
}

/** When a step not yet due will go, as far as it can be known: after the one before, plus its wait, inside its hours. */
export function stepAfterWords(waitHours: number, window: boolean): string {
  const base = waitHours > 0 ? `${readableDuration(waitHours * 3_600_000)} after the step before` : 'Right after the step before';
  return window ? `${base}, inside its hours` : base;
}

/** "under a minute", "4 min", "1 h 20 min", "2 days": how long something took or has left. */
export function readableDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'under a minute';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}

/**
 * Time left for a send going out now, at the pace it has gone so far: null until two have gone (no pace yet) or when nothing is left.
 * A guess from the send's own timestamps, never a promise; the panel says "about".
 */
export function sendTimeLeftMs(sentAt: readonly (string | null)[], left: number): number | null {
  if (left <= 0) return null;
  const times = sentAt.filter((t): t is string => Boolean(t)).map((t) => new Date(t).getTime()).sort((a, b) => a - b);
  if (times.length < 2) return null;
  const each = (times[times.length - 1]! - times[0]!) / (times.length - 1);
  return Math.round(each * left);
}

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
