'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { ConsumerSkillError, isConsumerSkillKey, setConsumerSkill } from '@repo/core/consumer-skills';
import { ensureConsumerAccount } from '../../../lib/account';
import { getWebDb } from '../../../lib/db';
import { SKILLS_OFF_COOKIE } from '../../../lib/skills-cookie';

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
    await mirrorToCookie(key, on);
    revalidatePath('/account/skills');
    return { ok: true };
  } catch (err) {
    if (err instanceof ConsumerSkillError) return { ok: false, error: err.message };
    return { ok: false, error: 'Something went wrong. Try again.' };
  }
}

/**
 * The switch, mirrored for cached pages with no session (the listing's Costs to buy panel). Readable by the
 * browser on purpose and holding nothing but skill keys; a courtesy, never a gate.
 */
async function mirrorToCookie(key: string, on: boolean) {
  const jar = await cookies();
  const off = new Set((jar.get(SKILLS_OFF_COOKIE)?.value ?? '').split(',').filter(Boolean));
  if (on) off.delete(key);
  else off.add(key);
  jar.set(SKILLS_OFF_COOKIE, [...off].join(','), { path: '/', sameSite: 'lax', maxAge: 60 * 60 * 24 * 365, httpOnly: false, secure: process.env.NODE_ENV === 'production' });
}
