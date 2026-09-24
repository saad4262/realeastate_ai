'use server';

import { revalidatePath } from 'next/cache';
import { AlreadyMemberError, registerAgency } from '@repo/core/agency';
import { ensureAppUser } from '@repo/core/identity';
import { claimAgentInvite } from '@repo/core/team';
import { requireAuthAccount } from '../../lib/auth-account';
import { getConsoleDb } from '../../lib/db';
import { loadActor } from '../../lib/load-actor';

export type SyncAccountResult =
  | {
      ok: true;
      hasMembership: boolean;
      claimed: boolean;
      /** A pending invite for this email had already lapsed. */
      inviteExpired: boolean;
    }
  | { ok: false; error: string };

/**
 * Called right after sign-in / sign-up. Mirrors the auth user into `public.user`
 * and claims any invite addressed to *this session's* email.
 *
 * Identity comes from the session only — an earlier version took `userId` from the
 * client, which let a caller mint a membership for someone else (ADR 0006).
 */
export async function syncAccountAction(opts?: {
  inviteToken?: string | null;
}): Promise<SyncAccountResult> {
  try {
    const account = await requireAuthAccount();
    const db = getConsoleDb();

    await ensureAppUser(db, {
      id: account.userId,
      email: account.email,
      name: account.name,
    });

    const claim = await claimAgentInvite(db, {
      userId: account.userId,
      email: account.email,
      token: opts?.inviteToken ?? null,
    });

    const actor = await loadActor(account.userId);
    const hasMembership = Boolean(actor?.agencyId && actor.membershipRole);

    if (claim.claimed) {
      revalidatePath('/team');
    }

    return {
      ok: true,
      hasMembership,
      claimed: claim.claimed,
      inviteExpired: claim.reason === 'expired',
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Could not sync account',
    };
  }
}

export type RegisterAgencyActionResult =
  | { ok: true; agencyId: string; slug: string }
  | { ok: false; error: string; code?: 'already_member' };

/** Self-serve agency registration — the signed-in account becomes owner. */
export async function registerAgencyAction(
  input: unknown,
): Promise<RegisterAgencyActionResult> {
  try {
    const account = await requireAuthAccount();
    const db = getConsoleDb();
    const result = await registerAgency(db, account, input);

    revalidatePath('/overview');
    revalidatePath('/team');

    return { ok: true, agencyId: result.agencyId, slug: result.slug };
  } catch (err) {
    if (err instanceof AlreadyMemberError) {
      return { ok: false, error: err.message, code: 'already_member' };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Could not register agency',
    };
  }
}
