import { NextResponse } from 'next/server';
import { apiError } from '@repo/core/http/api-error';
import { shortlistIds } from '@repo/core/shortlist';
import { getWebDb } from '../../../lib/db';
import { looksSignedIn, verifiedWebUserForAction } from '../../../lib/session';

export const dynamic = 'force-dynamic';

/**
 * The visitor's saved homes, for the hearts on every card (ADR 0100). A GET, not a Server Action: it runs as a
 * page mounts, and an action in flight would swallow the visitor's next link click (ARCHITECTURE § 3).
 *
 * Outside the middleware matcher, so it verifies the session itself, as the shortlist actions do. A visitor
 * with no auth cookie costs no check. It answers only about the caller: no id in, no one else's rows out.
 */
export async function GET() {
  const headers = { 'cache-control': 'private, no-store' };
  const user = (await looksSignedIn()) ? await verifiedWebUserForAction() : null;
  if (!user) return NextResponse.json({ signedIn: false, ids: [] }, { headers });
  try {
    return NextResponse.json({ signedIn: true, ids: await shortlistIds(getWebDb(), { userId: user.id }) }, { headers });
  } catch {
    return apiError(503, 'Saved homes are unavailable right now.', { headers });
  }
}
