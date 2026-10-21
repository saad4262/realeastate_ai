'use server';

import { revalidatePath } from 'next/cache';
import type { Actor } from '@repo/core/permissions';
import { noticeMailFromEnv } from '@repo/core/email';
import {
  blockMember,
  blockSiteUser,
  createPlatformEmail,
  deliverPlatformEmails,
  loadPlatformAdmin,
  makeOwner,
  PlatformError,
  reactivateAgency,
  setAgencyPlan,
  suspendAgency,
  previewPlatformEmail,
  unblockMember,
  unblockSiteUser,
  type EmailAudience,
} from '@repo/core/platform';
import { authBanFromEnv } from './auth-ban';
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

// ── Site users and email (ADR 0052) ───────────────────────────────────────

export type BlockUserResult = { ok: true; signInChanged: boolean } | { ok: false; error: string };

async function runUser(userId: string, change: (admin: Actor) => Promise<{ signInChanged: boolean }>): Promise<BlockUserResult> {
  const admin = await adminForAction();
  if (!admin) return { ok: false, error: 'Only a platform admin may change this.' };
  try {
    const r = await change(admin);
    revalidatePath(`/users/${userId}`);
    revalidatePath('/users');
    return { ok: true, signInChanged: r.signInChanged };
  } catch (err) {
    if (err instanceof PlatformError) return { ok: false, error: err.message };
    console.error('[platform] user action failed', err);
    return { ok: false, error: 'That did not save. Try again.' };
  }
}

export async function blockSiteUserAction(userId: string, reason: string): Promise<BlockUserResult> {
  return runUser(userId, (admin) => blockSiteUser(getConsoleDb(), admin, String(userId), String(reason ?? ''), { auth: authBanFromEnv() }));
}

export async function unblockSiteUserAction(userId: string): Promise<BlockUserResult> {
  return runUser(userId, (admin) => unblockSiteUser(getConsoleDb(), admin, String(userId), { auth: authBanFromEnv() }));
}

/** The browser names an audience by kind and ids; the server works out who that is. */
function audienceOf(raw: { kind: string; agencyId?: string | null; userId?: string | null }): EmailAudience | null {
  switch (raw.kind) {
    case 'agency':
      return raw.agencyId ? { kind: 'agency', agencyId: raw.agencyId } : null;
    case 'member':
      return raw.agencyId && raw.userId ? { kind: 'member', agencyId: raw.agencyId, userId: raw.userId } : null;
    case 'user':
      return raw.userId ? { kind: 'user', userId: raw.userId } : null;
    case 'all_agencies':
    case 'all_agents':
    case 'all_users':
      return { kind: raw.kind };
    default:
      return null;
  }
}

export type EmailPreviewResult = { ok: true; count: number; sample: string[] } | { ok: false; error: string };

export async function previewPlatformEmailAction(raw: { kind: string; agencyId?: string | null; userId?: string | null }): Promise<EmailPreviewResult> {
  const admin = await adminForAction();
  if (!admin) return { ok: false, error: 'Only a platform admin may send this.' };
  const audience = audienceOf(raw);
  if (!audience) return { ok: false, error: 'Choose who to write to.' };
  try {
    return { ok: true, ...(await previewPlatformEmail(getConsoleDb(), admin, audience)) };
  } catch (err) {
    return { ok: false, error: err instanceof PlatformError ? err.message : 'Could not count the recipients.' };
  }
}

export type EmailSendResult = { ok: true; recipients: number; sent: number; failed: number } | { ok: false; error: string };

/**
 * Record the email and its recipients, then send a first batch now; the cron
 * tick sends the rest within a minute or two.
 */
export async function sendPlatformEmailAction(
  raw: { kind: string; agencyId?: string | null; userId?: string | null },
  input: { subject: string; body: string },
): Promise<EmailSendResult> {
  const admin = await adminForAction();
  if (!admin) return { ok: false, error: 'Only a platform admin may send this.' };
  const audience = audienceOf(raw);
  if (!audience) return { ok: false, error: 'Choose who to write to.' };
  const db = getConsoleDb();
  let created: { emailId: string; recipients: number };
  try {
    created = await createPlatformEmail(db, admin, audience, { subject: String(input.subject ?? ''), body: String(input.body ?? '') });
  } catch (err) {
    if (err instanceof PlatformError) return { ok: false, error: err.message };
    console.error('[platform] email not recorded', err);
    return { ok: false, error: 'That did not save. Try again.' };
  }
  const notice = noticeMailFromEnv();
  const first = await deliverPlatformEmails(db, notice ? notice.mailer : null, { emailId: created.emailId, limit: 25 }).catch(() => ({ sent: 0, failed: 0 }));
  revalidatePath('/emails');
  return { ok: true, recipients: created.recipients, sent: first.sent, failed: first.failed };
}
