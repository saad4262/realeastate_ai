'use server';

import { revalidatePath } from 'next/cache';
import { DiscoveryError, hideHome, showHomeAgain } from '@repo/core/discovery';
import { consumerSkillBlocks } from '@repo/core/consumer-skills';
import { ensureConsumerAccount } from '../../../lib/account';
import { getWebDb } from '../../../lib/db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * "Not for me" and "Show again" (ADR 0080, C7 decision 4). The actor from the session only; `can()` decides. Hiding
 * needs Discovery AI on; showing a home again never does — a buyer can always undo their own choice.
 */
async function run(form: FormData, write: boolean, fn: (actor: { userId: string }, propertyId: string) => Promise<void>): Promise<void> {
  const user = await ensureConsumerAccount();
  const propertyId = String(form.get('propertyId') ?? '');
  if (!user || !UUID.test(propertyId)) return;
  const actor = { userId: user.id };
  if (write && (await consumerSkillBlocks(getWebDb(), actor)).get('discovery')) return;
  try {
    await fn(actor, propertyId);
  } catch (err) {
    if (!(err instanceof DiscoveryError)) console.error('[for-you] failed', err);
  }
  revalidatePath('/account/for-you');
}

export async function notForMe(form: FormData): Promise<void> {
  await run(form, true, (actor, id) => hideHome(getWebDb(), actor, id));
}

export async function showAgain(form: FormData): Promise<void> {
  await run(form, false, (actor, id) => showHomeAgain(getWebDb(), actor, id));
}
