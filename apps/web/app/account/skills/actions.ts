'use server';

import { revalidatePath } from 'next/cache';
import { ConsumerSkillError, isConsumerSkillKey, setConsumerSkill } from '@repo/core/consumer-skills';
import { ensureConsumerAccount } from '../../../lib/account';
import { getWebDb } from '../../../lib/db';

export type SkillActionResult = { ok: true } | { ok: false; error: string };

/**
 * Flip one of the buyer's own skill switches (ADR 0080). The actor comes from the session and nowhere
 * else; the key and the boolean are the only things the browser chooses, and core checks both — the
 * key against the catalog, the person against `can()`.
 */
export async function setConsumerSkillAction(key: string, on: boolean): Promise<SkillActionResult> {
  const user = await ensureConsumerAccount();
  if (!user) return { ok: false, error: 'Sign in to change your Skills.' };
  if (!isConsumerSkillKey(key) || typeof on !== 'boolean') return { ok: false, error: 'That skill does not exist.' };
  try {
    await setConsumerSkill(getWebDb(), { userId: user.id }, key, on);
    revalidatePath('/account/skills');
    return { ok: true };
  } catch (err) {
    if (err instanceof ConsumerSkillError) return { ok: false, error: err.message };
    return { ok: false, error: 'Something went wrong. Try again.' };
  }
}
