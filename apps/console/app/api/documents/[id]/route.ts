import { NextResponse } from 'next/server';
import { DocumentError, documentDownloadUrl } from '@repo/core/documents';
import { getConsoleDb } from '../../../../lib/db';
import { loadListingActor } from '../../../../lib/load-actor';
import { actionUserId } from '../../../../lib/auth-account';
import { apiError } from '@repo/core/http/api-error';

/**
 * Open a document (ADR 0053 §2): the list's own visibility rule, asked again for this id, then a
 * redirect to a storage link that works for a minute. A document this person may not see answers
 * exactly like one that does not exist. A GET, so it is a plain link in the list.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await actionUserId();
  if (!userId) return apiError(401, 'Not signed in');
  const actor = await loadListingActor(userId);
  if (!actor) return apiError(401, 'Not signed in');
  const { id } = await params;
  try {
    const url = await documentDownloadUrl(getConsoleDb(), actor, id);
    return NextResponse.redirect(url, { status: 302, headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
  } catch (err) {
    if (err instanceof DocumentError && err.code === 'not_found') {
      return apiError(404, err.message, { headers: { 'cache-control': 'no-store' } });
    }
    console.error('[documents] download failed', err instanceof Error ? err.message : err);
    return apiError(503, 'That document could not be opened. Try again.', { headers: { 'cache-control': 'no-store' } });
  }
}
