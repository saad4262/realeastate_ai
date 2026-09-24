import { revalidateTag } from 'next/cache';
import { NextResponse, type NextRequest } from 'next/server';
import { LISTINGS_TAG } from '../../../lib/cached';

export const dynamic = 'force-dynamic';

/**
 * How the console tells the public site that a listing moved.
 *
 * The two are separate Next applications in separate processes, so the
 * console's own `revalidatePath` cannot reach this one's cache. Without a call
 * like this, caching the consumer site means a published listing appears only
 * when a timer says so — which is the failure that was reported here as "the
 * new listing isn't showing", and the reason the site had no cache at all
 * until now.
 *
 * Guarded by a shared secret rather than a session: the caller is a server, not
 * a person. With no secret configured the endpoint refuses everything, because
 * an open cache-buster is a free way to make every page slow.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.REVALIDATE_SECRET?.trim();
  if (!secret) {
    return NextResponse.json({ error: 'Revalidation is not configured' }, { status: 503 });
  }

  const offered = request.headers.get('x-revalidate-secret');
  // Length check first so the comparison below cannot be used as an oracle for
  // the secret's length, and a plain !== after it — this is a shared secret in
  // a header, not a password, and constant time here buys nothing real.
  if (!offered || offered.length !== secret.length || offered !== secret) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 401 });
  }

  let listingId: string | null = null;
  try {
    const body = (await request.json()) as { listingId?: unknown };
    if (typeof body.listingId === 'string') listingId = body.listingId;
  } catch {
    // A bodiless call is a request to clear everything, which is valid.
  }

  revalidateTag(LISTINGS_TAG);
  // The detail page is tagged per id as well, so an edit to one listing does
  // not have to wait behind the broader tag.
  if (listingId) revalidateTag(`listing:${listingId}`);

  return NextResponse.json({ revalidated: true, listingId });
}
