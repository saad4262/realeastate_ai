'use server';

import { revalidatePath } from 'next/cache';
import type { Actor } from '@repo/core/permissions';
import {
  blockMember,
  loadPlatformAdmin,
  makeOwner,
  PlatformError,
  reactivateAgency,
  setAgencyPlan,
  suspendAgency,
  unblockMember,
} from '@repo/core/platform';
import { requireActionUserId } from './auth-account';
import { getConsoleDb } from './db';
import { revalidateWeb } from './revalidate-web';

/**
 * The admin console's controls (ADR 0050). Each action: the signed-in user
 * from the session, a row in `platform_admin`, then the core function — which
 * asks can('platform:manage') again and records the change with it.
 */

export type PlatformActionResult = { ok: true } | { ok: false; error: string };

async function adminForAction(): Promise<Actor | null> {
  const userId = await requireActionUserId();
  return loadPlatformAdmin(getConsoleDb(), userId);
}

async function run(agencyId: string, change: (admin: Actor) => Promise<void>, opts: { publicSite?: boolean } = {}): Promise<PlatformActionResult> {
  const admin = await adminForAction();
  if (!admin) return { ok: false, error: 'Only a platform admin may change this.' };
  try {
    await change(admin);
  } catch (err) {
    if (err instanceof PlatformError) return { ok: false, error: err.message };
    console.error('[platform] action failed', err);
    return { ok: false, error: 'That did not save. Try again.' };
  }
  revalidatePath(`/agencies/${agencyId}`, 'layout');
  revalidatePath('/agencies');
  // A suspension hides (and a reactivation shows) the agency's listings: tell the public site now.
  if (opts.publicSite) await revalidateWeb();
  return { ok: true };
}

export async function suspendAgencyAction(agencyId: string, reason: string): Promise<PlatformActionResult> {
  return run(agencyId, (admin) => suspendAgency(getConsoleDb(), admin, String(agencyId), String(reason ?? '')), { publicSite: true });
}

export async function reactivateAgencyAction(agencyId: string, to: 'active' | 'trial'): Promise<PlatformActionResult> {
  return run(agencyId, (admin) => reactivateAgency(getConsoleDb(), admin, String(agencyId), to === 'trial' ? 'trial' : 'active'), { publicSite: true });
}

export async function setAgencyPlanAction(
  agencyId: string,
  input: { plan: string; status: 'active' | 'trial'; trialEndsAt: string | null },
): Promise<PlatformActionResult> {
  // A date from <input type="date"> is a day; the trial ends at its last second, Sydney standard time (AEST).
  const trialEndsAt = input.trialEndsAt ? new Date(`${input.trialEndsAt}T23:59:59+10:00`) : null;
  return run(agencyId, (admin) =>
    setAgencyPlan(getConsoleDb(), admin, String(agencyId), {
      plan: String(input.plan ?? ''),
      status: input.status === 'trial' ? 'trial' : 'active',
      trialEndsAt,
    }),
  );
}

export async function blockMemberAction(agencyId: string, userId: string, reason: string): Promise<PlatformActionResult> {
  return run(agencyId, (admin) => blockMember(getConsoleDb(), admin, String(agencyId), String(userId), String(reason ?? '')));
}

export async function unblockMemberAction(agencyId: string, userId: string): Promise<PlatformActionResult> {
  return run(agencyId, (admin) => unblockMember(getConsoleDb(), admin, String(agencyId), String(userId)));
}

export async function makeOwnerAction(agencyId: string, userId: string, demoteOthers: boolean): Promise<PlatformActionResult> {
  return run(agencyId, (admin) => makeOwner(getConsoleDb(), admin, String(agencyId), String(userId), { demoteOthers: demoteOthers === true }));
}
