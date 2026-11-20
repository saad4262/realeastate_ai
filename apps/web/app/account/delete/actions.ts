'use server';

import { redirect } from 'next/navigation';
import { createServerSupabaseClient } from '@repo/auth/server';
import { deleteInspectionPhotos } from '@repo/core/inspections/photo-storage';
import { AccountDeletionError, authAdminFromEnv, deleteOwnAccount } from '@repo/core/lifecycle';
import { getWebDb } from '../../../lib/db';
import { currentWebUser } from '../../../lib/session';

const REFUSED: Record<AccountDeletionError['code'], string> = {
  not_found: 'This account is already gone.',
  works_at_agency: 'This account works at an agency. Ask the agency to remove you from its team first, then delete it here.',
  platform_admin: 'A platform admin account is removed by another admin.',
};

/**
 * PLATFORM-PLAN 5.12: a public user deletes their own account. Who is the session's, never the form's; the typed
 * email only confirms they meant it. Core refuses agency staff and platform admins and does the deletion.
 */
export async function deleteAccountAction(confirmEmail: string): Promise<{ ok: false; error: string }> {
  const user = await currentWebUser();
  if (!user) return { ok: false, error: 'Sign in again to delete your account.' };
  if (!user.email || confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()) {
    return { ok: false, error: 'Type the email address you sign in with, exactly as shown.' };
  }
  const deleteAuthUser = authAdminFromEnv();
  if (!deleteAuthUser) return { ok: false, error: 'Deleting an account is not available right now. Please try again later.' };
  try {
    await deleteOwnAccount(getWebDb(), { userId: user.id }, { deleteAuthUser, deletePhotos: deleteInspectionPhotos });
  } catch (err) {
    if (err instanceof AccountDeletionError) return { ok: false, error: REFUSED[err.code] };
    return { ok: false, error: 'Your account could not be deleted. Nothing was removed; please try again.' };
  }
  // The session's account no longer exists: drop its cookies in this browser too.
  const supabase = await createServerSupabaseClient();
  await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
  redirect('/account-deleted');
}
