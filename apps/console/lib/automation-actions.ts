'use server';

import { after } from 'next/server';
import { revalidatePath } from 'next/cache';
import { AssistantError, stopAssistantTask } from '@repo/core/assistant';
import { AutomationError, driveAutomationRun, runAutomationNow, setAutomationStatus, stopAutomationRun } from '@repo/core/recurring';
import { templateSendDepsFromEnv } from '@repo/core/template-email';
import { getConsoleDb } from './db';
import { loadListingActor } from './load-actor';
import { requireActionUserId } from './auth-account';

/** The buttons on Skills → Automations and the top bar's panel (ADR 0089). Every decision is core's. */
type R = { ok: true } | { ok: false; error: string };

async function actor() {
  const a = await loadListingActor(await requireActionUserId());
  if (!a) throw new AutomationError('forbidden', 'Database is not configured.');
  return a;
}

function fail(err: unknown): { ok: false; error: string } {
  if (err instanceof AutomationError || err instanceof AssistantError) return { ok: false, error: err.message };
  console.error('[automations] action failed', err instanceof Error ? err.message : 'unknown');
  return { ok: false, error: 'That did not work. Please try again.' };
}

function refresh() {
  revalidatePath('/skills');
  revalidatePath('/my-skills');
}

/** "Stop the rest" of a task sent in parts. */
export async function stopTaskAction(taskId: string): Promise<R> {
  try {
    await stopAssistantTask(getConsoleDb(), await actor(), String(taskId));
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/** Stop one run of a repeating automation; it stays on for its next time. */
export async function stopAutomationRunAction(runId: string): Promise<R> {
  try {
    await stopAutomationRun(getConsoleDb(), await actor(), String(runId));
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function setAutomationStatusAction(id: string, status: 'active' | 'paused' | 'archived'): Promise<R> {
  try {
    if (!['active', 'paused', 'archived'].includes(status)) return { ok: false, error: 'Unknown change' };
    await setAutomationStatus(getConsoleDb(), await actor(), String(id), status);
    refresh();
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/** Run it now. The sending carries on after the answer; the minute tick finishes what is left. */
export async function runAutomationNowAction(id: string): Promise<R> {
  try {
    const db = getConsoleDb();
    const { runId } = await runAutomationNow(db, await actor(), String(id));
    const send = templateSendDepsFromEnv();
    after(() =>
      driveAutomationRun(db, { templateSend: send.ok ? send.deps : null }, runId).catch((err: unknown) =>
        console.error('[automations] run failed', err instanceof Error ? err.message : 'unknown'),
      ),
    );
    refresh();
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}
