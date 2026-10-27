'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import {
  addSkillToMine,
  archiveAgencySkill,
  createAgencySkill,
  removeMySkill,
  runSkillNow,
  setSkillEnabled,
  SkillError,
  updateMySkill,
  type LibrarySkillInput,
  type SkillScheduleInput,
} from '@repo/core/skills';
import { noticeMailFromEnv } from '@repo/core/email';
import { isSkillKey, setSkillSwitch, SkillSwitchError } from '@repo/core/skill-switches';
import { skillWriterFromEnv } from '@repo/ai/skills';
import { getConsoleDb } from './db';
import { loadActor } from './load-actor';
import { requireActionUserId } from './auth-account';

/**
 * Skill actions (docs/adr/0021). The actor is rebuilt from the session; every
 * decision is can()'s inside packages/core. "Run now" calls the model through
 * packages/ai, metered and inside the daily budget like the scheduler.
 */

export type SkillActionResult =
  | { ok: true; id?: string; runId?: string; status?: string }
  | { ok: false; error: string; missing?: string[] };

async function actor() {
  const userId = await requireActionUserId();
  const loaded = await loadActor(userId);
  if (!loaded) throw new SkillError('forbidden', 'Database is not configured.');
  return loaded;
}

async function refresh() {
  const surface = (await headers()).get('x-console-surface') === 'agency' ? 'agency' : 'agent';
  revalidatePath(surface === 'agency' ? '/skills' : '/my-skills', 'layout');
}

function failure(err: unknown, fallback: string): SkillActionResult {
  if (err instanceof SkillError) {
    return { ok: false, error: err.message, ...(err.missing ? { missing: err.missing } : {}) };
  }
  console.error('[skills] action failed', err instanceof Error ? err.message : err);
  return { ok: false, error: fallback };
}

export async function addSkillAction(skillId: string, timezone: string): Promise<SkillActionResult> {
  const who = await actor();
  try {
    const { id } = await addSkillToMine(getConsoleDb(), who, skillId, timezone);
    await refresh();
    return { ok: true, id };
  } catch (err) {
    return failure(err, 'Could not add the skill');
  }
}

export async function setSkillEnabledAction(id: string, enabled: boolean): Promise<SkillActionResult> {
  const who = await actor();
  try {
    await setSkillEnabled(getConsoleDb(), who, id, enabled);
    await refresh();
    return { ok: true };
  } catch (err) {
    return failure(err, enabled ? 'Could not switch the skill on' : 'Could not switch the skill off');
  }
}

export async function updateSkillAction(
  id: string,
  input: { bodyMd?: string; schedule?: SkillScheduleInput; emailMe?: boolean },
): Promise<SkillActionResult> {
  const who = await actor();
  try {
    await updateMySkill(getConsoleDb(), who, id, input);
    await refresh();
    return { ok: true };
  } catch (err) {
    return failure(err, 'Could not save the skill');
  }
}

export async function removeSkillAction(id: string): Promise<SkillActionResult> {
  const who = await actor();
  try {
    await removeMySkill(getConsoleDb(), who, id);
    await refresh();
    return { ok: true };
  } catch (err) {
    return failure(err, 'Could not remove the skill');
  }
}

export async function runSkillNowAction(id: string): Promise<SkillActionResult> {
  const who = await actor();
  const db = getConsoleDb();
  try {
    const write = skillWriterFromEnv(db);
    const result = await runSkillNow(db, { ...(write ? { write } : {}), mail: noticeMailFromEnv(), env: process.env }, who, id);
    await refresh();
    return { ok: true, runId: result.runId, status: result.status };
  } catch (err) {
    return failure(err, 'Could not run the skill');
  }
}

export async function createLibrarySkillAction(input: LibrarySkillInput): Promise<SkillActionResult> {
  const who = await actor();
  try {
    const { id } = await createAgencySkill(getConsoleDb(), who, input);
    await refresh();
    return { ok: true, id };
  } catch (err) {
    return failure(err, 'Could not add the library skill');
  }
}

export async function archiveLibrarySkillAction(skillId: string): Promise<SkillActionResult> {
  const who = await actor();
  try {
    await archiveAgencySkill(getConsoleDb(), who, skillId);
    await refresh();
    return { ok: true };
  } catch (err) {
    return failure(err, 'Could not archive the skill');
  }
}

/** A platform skill's switch (ADR 0058) — the agency's for an owner or admin, otherwise the person's own. */
export async function setSkillSwitchAction(key: string, on: boolean): Promise<SkillActionResult> {
  const who = await actor();
  try {
    if (!isSkillKey(key) || typeof on !== 'boolean') return { ok: false, error: 'That is not a skill.' };
    await setSkillSwitch(getConsoleDb(), who, key, on);
    await refresh();
    return { ok: true };
  } catch (err) {
    if (err instanceof SkillSwitchError) return { ok: false, error: err.message };
    return failure(err, on ? 'Could not switch the skill on' : 'Could not switch the skill off');
  }
}
