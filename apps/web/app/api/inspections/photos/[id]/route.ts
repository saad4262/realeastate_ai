import { NextResponse, type NextRequest } from 'next/server';
import { ownPhotoKey } from '@repo/core/inspections';
import { signInspectionPhoto } from '@repo/core/inspections/photo-storage';
import { currentWebUser } from '../../../../../lib/session';
import { getWebDb } from '../../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One of the buyer's own inspection photos (C6 decision 8): the owner check, then a redirect to a signed link that
 * works for five minutes. Someone else's photo id answers exactly like a missing one.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentWebUser();
  if (!user || !UUID.test(id)) return new NextResponse(null, { status: 404 });
  const key = await ownPhotoKey(getWebDb(), { userId: user.id }, id);
  if (!key) return new NextResponse(null, { status: 404 });
  try {
    const url = await signInspectionPhoto(key);
    return NextResponse.redirect(url, { status: 302, headers: { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' } });
  } catch (err) {
    console.error('[inspection-photos] sign failed', err);
    return new NextResponse(null, { status: 503 });
  }
}
