'use server';

import { revalidatePath } from 'next/cache';
import {
  inviteAgent,
  listAgencyAgents,
  resendAgentInvite,
  toInviteAgentError,
  type InviteAgentDraft,
  type InviteErrorCode,
} from '@repo/core/team';
import { requireConsoleAccess } from '../../../lib/require-console-access';
import { getConsoleDb } from '../../../lib/db';

export type InviteAgentActionResult =
  | {
      ok: true;
      inviteId: string;
      token: string;
      claimPath: string;
      status: string;
      /** ISO — the claim link stops working at this instant. */
      expiresAt: string;
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
    return {
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
  | { ok: true; inviteId: string; claimPath: string; expiresAt: string }
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
    return {
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
