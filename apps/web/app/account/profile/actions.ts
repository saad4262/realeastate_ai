'use server';

import { revalidatePath } from 'next/cache';
import { editProfile, forgetProfile, ProfileError, resetProfileField, PROFILE_FIELDS, type ProfileField } from '@repo/core/profile';
import { ensureConsumerAccount } from '../../../lib/account';
import { getWebDb } from '../../../lib/db';

export type ProfileActionResult = { ok: true } | { ok: false; error: string };

/**
 * Personal Property AI's edits (ADR 0080, C4 decision 5). The actor from the session only; the patch is checked by
 * core's strict schema — five fields about the home, nothing about the person — and `can()` decides.
 */
async function run(fn: (actor: { userId: string }) => Promise<void>): Promise<ProfileActionResult> {
  const user = await ensureConsumerAccount();
  if (!user) return { ok: false, error: 'Sign in to change your profile.' };
  try {
    await fn({ userId: user.id });
    revalidatePath('/account/profile');
    return { ok: true };
  } catch (err) {
    if (err instanceof ProfileError) return { ok: false, error: err.message };
    return { ok: false, error: 'Something went wrong. Try again.' };
  }
}

export async function setProfileField(field: string, value: unknown): Promise<ProfileActionResult> {
  if (!(PROFILE_FIELDS as readonly string[]).includes(field)) return { ok: false, error: 'That is not part of your profile.' };
  return run((actor) => editProfile(getWebDb(), actor, { [field]: value }));
}

export async function resetField(field: string): Promise<ProfileActionResult> {
  if (!(PROFILE_FIELDS as readonly string[]).includes(field)) return { ok: false, error: 'That is not part of your profile.' };
  return run((actor) => resetProfileField(getWebDb(), actor, field as ProfileField));
}

export async function forgetEverything(): Promise<ProfileActionResult> {
  return run((actor) => forgetProfile(getWebDb(), actor));
}
