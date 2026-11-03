'use server';

import { revalidatePath } from 'next/cache';
import { ensureAppUser } from '@repo/core/identity';
import { consumerSkillBlocks } from '@repo/core/consumer-skills';
import { isWatching, unwatchProperty, watchProperty, WatchError } from '@repo/core/watch';
import { getWebDb } from './db';
import { looksSignedIn, verifiedWebUserForAction } from './session';

/**
 * Property Monitor's actions (ADR 0080, C4). Posted from the cached listing and address pages, where middleware
 * never runs, so each verifies the session itself — as the shortlist's do. The browser names a property id and
 * its own time zone; core decides everything else under `can()` and the Property Monitor switch.
 */

export type WatchButtonState = { signedIn: false } | { signedIn: true; monitorOn: boolean; watching: boolean };
export type WatchResult = { ok: true } | { ok: false; error: string; skillOff?: boolean };

async function buyer() {
  if (!(await looksSignedIn())) return null;
  const user = await verifiedWebUserForAction();
  if (!user) return null;
  await ensureAppUser(getWebDb(), { id: user.id, email: user.email ?? '', ...(user.label ? { name: user.label } : {}) });
  return { userId: user.id };
}

export async function watchButtonState(propertyId: string): Promise<WatchButtonState> {
  const actor = await buyer();
  if (!actor) return { signedIn: false };
  const db = getWebDb();
  const [blocks, watching] = await Promise.all([consumerSkillBlocks(db, actor), isWatching(db, actor, propertyId)]);
  return { signedIn: true, monitorOn: !blocks.has('property_monitor'), watching };
}

export async function setWatching(propertyId: string, on: boolean, timeZone?: string): Promise<WatchResult> {
  const actor = await buyer();
  if (!actor) return { ok: false, error: 'Sign in to watch an address.' };
  try {
    if (on) await watchProperty(getWebDb(), actor, { propertyId }, timeZone);
    else await unwatchProperty(getWebDb(), actor, propertyId);
    revalidatePath('/account/watching');
    return { ok: true };
  } catch (err) {
    if (err instanceof WatchError) return { ok: false, error: err.message, ...(err.code === 'skill_off' ? { skillOff: true } : {}) };
    return { ok: false, error: 'Something went wrong. Try again.' };
  }
}
