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
