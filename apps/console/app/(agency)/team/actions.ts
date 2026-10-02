'use server';

import { revalidatePath } from 'next/cache';
import {
  emailAgentInvite,
  inviteAgent,
  listAgencyAgents,
  resendAgentInvite,
  toInviteAgentError,
  type InviteAgentDraft,
  type InviteErrorCode,
} from '@repo/core/team';
import { requireConsoleAccess } from '../../../lib/require-console-access';
import { getConsoleDb } from '../../../lib/db';
import { noticeMailFromEnv } from '@repo/core/email';
import type { Actor } from '@repo/core/permissions';

/**
 * Email the claim link. Never fails the invite: the link is on screen with a
 * Copy button either way, and the screen says whether the email went.
 */
async function emailInvite(
  actor: Actor,
  invite: { inviteId: string; claimPath: string; expiresAt: Date },
): Promise<boolean> {
  const mail = noticeMailFromEnv();
  if (!mail) return false;
  try {
    const outcome = await emailAgentInvite(
      getConsoleDb(),
      { mailer: mail.mailer, agentUrl: mail.urls.agentUrl },
      actor,
      invite,
    );
    return outcome.emailed;
  } catch (err) {
    console.error('[invite] email failed', err);
    return false;
  }
}

export type InviteAgentActionResult =
  | {
      ok: true;
      inviteId: string;
      token: string;
      claimPath: string;
      status: string;
      /** ISO — the claim link stops working at this instant. */
      expiresAt: string;
      /** Whether the link also went to the agent by email. */
      emailed: boolean;
    }
  | {
      ok: false;
      error: string;
      code: InviteErrorCode;
      /** Draft field at fault, so the wizard can send the user back to it. */
      field?: keyof InviteAgentDraft;
    };

export async function inviteAgentAction(
  draft: InviteAgentDraft,
): Promise<InviteAgentActionResult> {
  // Outside the try: requireConsoleAccess redirects by throwing, and catching
  // that would turn a redirect into a fake "invite failed".
  const session = await requireConsoleAccess('agency');

  try {
    const db = getConsoleDb();
    // No auth provisioning here on purpose. Creating the agent's auth account up front
    // makes the claim link dead — Supabase answers the agent's /signup with
    // "User already registered" (422). The agent creates their own password from the
    // invite link instead. Switch to admin.inviteUserByEmail (magic link) once outbound
    // email is configured, not back to createUser.
    const result = await inviteAgent(db, session.actor, draft);
    revalidatePath('/team');
    const emailed =
      result.status === 'pending'
        ? await emailInvite(session.actor, {
            inviteId: result.inviteId,
            claimPath: result.claimPath,
            expiresAt: result.expiresAt,
          })
        : false;
    return {
      emailed,
      ok: true,
      inviteId: result.inviteId,
      token: result.token,
      claimPath: result.claimPath,
      status: result.status,
      expiresAt: result.expiresAt.toISOString(),
    };
  } catch (err) {
    // Never hand a raw ZodError to the UI — it serialises as a JSON issue array.
    const inviteError = toInviteAgentError(err);
    return {
      ok: false,
      error: inviteError.message,
      code: inviteError.code,
      field: inviteError.field,
    };
  }
}

export async function loadTeamAgentsAction() {
  const session = await requireConsoleAccess('agency');
  const db = getConsoleDb();
  return listAgencyAgents(db, session.actor);
}


export type ResendInviteActionResult =
  | { ok: true; inviteId: string; claimPath: string; expiresAt: string; emailed: boolean }
  | { ok: false; error: string; code: InviteErrorCode };

/** Cut a fresh link for an invite that lapsed, without redoing the wizard. */
export async function resendInviteAction(
  inviteId: string,
): Promise<ResendInviteActionResult> {
  // Outside the try: requireConsoleAccess redirects by throwing, and catching
  // that would turn a redirect into a fake "resend failed".
  const session = await requireConsoleAccess('agency');

  try {
    const result = await resendAgentInvite(getConsoleDb(), session.actor, inviteId);
    revalidatePath('/team');
    const emailed = await emailInvite(session.actor, result);
    return {
      emailed,
      ok: true,
      inviteId: result.inviteId,
      claimPath: result.claimPath,
      expiresAt: result.expiresAt.toISOString(),
    };
  } catch (err) {
    const inviteError = toInviteAgentError(err);
    return { ok: false, error: inviteError.message, code: inviteError.code };
  }
}
