import { NextResponse, type NextRequest } from 'next/server';
import { NotebookError, PhotoBytesError, recordPhoto, reservePhoto, stripPhotoMetadata } from '@repo/core/inspections';
import { deleteInspectionPhotos, inspectionPhotosConfigured, putInspectionPhoto } from '@repo/core/inspections/photo-storage';
import { consumerSkillBlocks, consumerSkillOffMessage } from '@repo/core/consumer-skills';
import { ensureConsumerAccount } from '../../../../lib/account';
import { getWebDb } from '../../../../lib/db';
import { rateLimiter } from '../../../../lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One inspection photo in (ADR 0080, C6 decision 8). Plumbing only (#10): the session names the buyer, core checks
 * `can()`, the limit and the bytes — a JPEG or PNG by its own signature, its metadata (GPS included) stripped here
 * whatever the browser did — and the file goes to the PRIVATE bucket before its row is written.
 */
const limits = rateLimiter('inspection-photos', { perMinute: 30, dailyCapEnv: 'INSPECTION_PHOTOS_DAILY_CAP', dailyCapDefault: 5000 });
const fail = (status: number, error: string) => NextResponse.json({ error }, { status });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  if (limits.overLimit(request)) return fail(429, 'Too many photos at once. Wait a moment.');
  const user = await ensureConsumerAccount();
  if (!user) return fail(401, 'Sign in to keep inspection notes.');
  if (!inspectionPhotosConfigured()) return fail(503, 'Photos are not switched on here.');
  const actor = { userId: user.id };
  const db = getWebDb();
  const block = (await consumerSkillBlocks(db, actor)).get('inspection_notes');
  if (block) return fail(403, consumerSkillOffMessage('inspection_notes', block));
  if (limits.overDailyCap()) return fail(503, 'Photos are resting for today. Your notes still save.');

  const form = await request.formData().catch(() => null);
  const listingId = form?.get('listingId');
  const file = form?.get('photo');
  if (typeof listingId !== 'string' || !UUID.test(listingId) || !(file instanceof Blob)) return fail(400, 'That photo could not be read.');

  let key: string | null = null;
  try {
    const clean = stripPhotoMetadata(new Uint8Array(await file.arrayBuffer()));
    const reserved = await reservePhoto(db, actor, listingId, clean.type.ext);
    key = reserved.key;
    await putInspectionPhoto(key, clean.bytes, clean.type.contentType);
    const id = await recordPhoto(db, actor, { noteId: reserved.noteId, key, contentType: clean.type.contentType, bytes: clean.bytes.length });
    return NextResponse.json({ id });
  } catch (err) {
    if (key) await deleteInspectionPhotos([key]);
    if (err instanceof PhotoBytesError) return fail(400, err.message);
    if (err instanceof NotebookError) return fail(err.code === 'forbidden' ? 403 : err.code === 'not_found' ? 404 : err.code === 'limit' ? 409 : 400, err.message);
    console.error('[inspection-photos] upload failed', err);
    return fail(503, 'The photo could not be saved just now. Try again.');
  }
}
