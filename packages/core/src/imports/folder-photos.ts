import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { listingImportRow, type Db } from '@repo/db';
import type { Actor } from '../permissions';
import { recordListingPhoto } from '../media/listing-media';
import { recordListingFloorplan } from '../media/extras';
import { keyBelongsTo, newStorageKey } from '../media/storage-key';
import { describeObject, MediaError, signUpload } from '../media/storage-client';
import { ImportError, loadRunnableImport, type PhotoEntry } from './imports';
import { matchFolder, MAX_FOLDER_FILES, type MatchRow } from './folder-match';
import type { NormalizedRow } from './columns';

/**
 * Photos from a folder on the uploader's computer (ADR 0102). Three calls, all under the import's
 * own rules (`listing_import:run`: the person running it):
 *
 *   attachPhotoFolder   paths + sizes → each row's plan, `local` entries in `listing_import_row.photos`
 *   signImportPhotos    ≤ 50 of those → a signed upload each, keyed under the row's listing
 *   confirmImportPhotos ≤ 50 uploaded → the objects checked, then recorded in one transaction
 *
 * The browser never names a listing: every key is made from, and checked against, the row's listing.
 */

/** Photos signed or confirmed per call. */
export const PHOTO_BATCH = 50;

const filesSchema = z
  .array(z.object({ path: z.string().min(1).max(500).refine((p) => !p.includes('\0')), size: z.number().int().min(0) }))
  .min(1)
  .max(MAX_FOLDER_FILES);
const refSchema = z.object({ rowId: z.string().uuid(), path: z.string().min(1).max(500) });
/** `type`: what the browser made of the file (a photo becomes JPEG, a PNG floorplan stays PNG); the key's extension. */
const signSchema = z.array(refSchema.extend({ type: z.string().max(40).optional() })).min(1).max(PHOTO_BATCH);
const dim = z.number().int().positive().max(100_000).optional();
const confirmSchema = z.object({
  uploaded: z.array(refSchema.extend({ key: z.string().max(200), width: dim, height: dim })).max(PHOTO_BATCH),
  failed: z.array(refSchema.extend({ error: z.string().max(200) })).max(PHOTO_BATCH),
});

/** Rows a folder may add photos to: they are, or will become, listings of this import. */
const PHOTO_ROWS = ['valid', 'imported', 'updated'];

export type FolderReport = {
  /** Listings given photos by this drop, and how many photos. */
  listings: number;
  photos: number;
  /** Row numbers of listings that, after this drop, have no photo from anywhere. */
  withoutPhotos: number[];
  unmatchedFolders: string[];
  ambiguous: { folder: string; rows: number[] }[];
  skipped: { path: string; reason: string }[];
  linksWin: number[];
};

async function runnableListingsImport(db: Db, actor: Actor, id: string, statuses: string[]) {
  const imp = await loadRunnableImport(db, actor, id);
  if (imp.kind !== 'listings') throw new ImportError('invalid', 'Photos are for a listings import');
  if (!statuses.includes(imp.status)) throw new ImportError('conflict', imp.status === 'validated' || imp.status === 'importing' || imp.status === 'done' ? 'Import the listings first' : 'Run the check first');
  return imp;
}

/** One statement for any number of rows' photo lists. */
async function writePhotos(db: Pick<Db, 'execute'>, importId: string, rows: { id: string; photos: PhotoEntry[] }[]) {
  if (!rows.length) return;
  await db.execute(sql`
    update listing_import_row r set photos = v.photos, updated_at = now()
    from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as v(id uuid, photos jsonb)
    where r.id = v.id and r.import_id = ${importId}`);
}

/**
 * Match a dropped folder to the import's rows, after its dry run. Dropping again resumes: a photo
 * already in (`done`, same path and size) stays, and everything else in the folder waits again.
 * A row this drop does not reach keeps what it had, so a second folder adds to the first.
 */
export async function attachPhotoFolder(db: Db, actor: Actor, id: string, input: unknown): Promise<FolderReport> {
  const parsed = filesSchema.safeParse(input);
  if (!parsed.success) throw new ImportError('invalid', `Choose a folder of at most ${MAX_FOLDER_FILES.toLocaleString('en-AU')} files`);
  const imp = await runnableListingsImport(db, actor, id, ['validated', 'importing', 'done']);
  const rows = await db
    .select({ id: listingImportRow.id, rowNumber: listingImportRow.rowNumber, normalized: listingImportRow.normalized, photos: listingImportRow.photos })
    .from(listingImportRow)
    .where(and(eq(listingImportRow.importId, imp.id), inArray(listingImportRow.status, PHOTO_ROWS)));

  const matchRows: MatchRow[] = rows.map((r) => {
    const n = r.normalized as NormalizedRow;
    return {
      rowId: r.id,
      rowNumber: r.rowNumber,
      externalId: n.externalId,
      unit: n.property.unit ?? null,
      streetNumber: n.property.streetNumber ?? null,
      street: n.property.street ?? null,
      suburb: n.property.suburb,
      state: String(n.property.state ?? ''),
      postcode: n.property.postcode,
      hasLinks: (r.photos as PhotoEntry[]).some((p) => p.url),
    };
  });
  const m = matchFolder(matchRows, parsed.data);

  const updates: { id: string; photos: PhotoEntry[] }[] = [];
  let photos = 0;
  const after = new Map(rows.map((r) => [r.id, r.photos as PhotoEntry[]]));
  for (const [rowId, planned] of m.byRow) {
    const existing = after.get(rowId)!;
    const done = existing.filter((e) => e.path && e.status === 'done');
    const isDone = new Set(done.map((e) => `${e.path}|${e.size}`));
    const next: PhotoEntry[] = [...done, ...planned.filter((p) => !isDone.has(`${p.path}|${p.size}`)).map((p) => ({ path: p.path, size: p.size, status: 'local' as const, ...(p.kind ? { kind: p.kind } : {}) }))];
    photos += next.length - done.length;
    after.set(rowId, next);
    updates.push({ id: rowId, photos: next });
  }
  await writePhotos(db, imp.id, updates);

  return {
    listings: updates.length,
    photos,
    withoutPhotos: rows.filter((r) => !after.get(r.id)!.length).map((r) => r.rowNumber).sort((a, b) => a - b),
    unmatchedFolders: m.unmatchedFolders,
    ambiguous: m.ambiguous,
    skipped: m.skipped,
    linksWin: m.linksWin,
  };
}

export type SignedPhoto = { rowId: string; path: string; key: string; uploadUrl: string; token: string } | { rowId: string; path: string; error: string };
export type FolderPhotoDeps = { sign?: typeof signUpload; describe?: typeof describeObject };

/**
 * The folder photos still to send, in each listing's order: `local` (not yet sent) and `failed` (sent, refused).
 * Only of rows already imported, so every one has a listing to go to. One statement.
 */
export async function waitingFolderPhotos(db: Db, actor: Actor, id: string): Promise<{ rowId: string; path: string; size: number; kind: 'floorplan' | null; status: 'local' | 'failed' }[]> {
  const imp = await runnableListingsImport(db, actor, id, ['validated', 'importing', 'done']);
  const rows = await db.execute<{ row_id: string; path: string; size: string; kind: 'floorplan' | null; status: 'local' | 'failed' }>(sql`
    select r.id as row_id, e.p->>'path' as path, e.p->>'size' as size, e.p->>'kind' as kind, e.p->>'status' as status
    from listing_import_row r, jsonb_array_elements(r.photos) with ordinality as e(p, i)
    where r.import_id = ${imp.id} and r.status in ('imported', 'updated') and e.p ? 'path' and e.p->>'status' in ('local', 'failed')
    order by r.row_number, e.i`);
  return rows.map((r) => ({ rowId: r.row_id, path: r.path, size: Number(r.size), kind: r.kind, status: r.status }));
}

/** Signed uploads for up to PHOTO_BATCH waiting photos of imported listings. The browser shrinks each one first. */
export async function signImportPhotos(db: Db, actor: Actor, id: string, input: unknown, deps: FolderPhotoDeps = {}): Promise<SignedPhoto[]> {
  const parsed = signSchema.safeParse(input);
  if (!parsed.success) throw new ImportError('invalid', `Sign 1 to ${PHOTO_BATCH} photos at a time`);
  const imp = await runnableListingsImport(db, actor, id, ['importing', 'done']);
  const rows = await db
    .select({ id: listingImportRow.id, listingId: listingImportRow.listingId, photos: listingImportRow.photos })
    .from(listingImportRow)
    .where(and(eq(listingImportRow.importId, imp.id), inArray(listingImportRow.status, ['imported', 'updated']), inArray(listingImportRow.id, [...new Set(parsed.data.map((r) => r.rowId))])));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const sign = deps.sign ?? signUpload;
  // Network, no transaction open.
  return Promise.all(
    parsed.data.map(async ({ rowId, path, type }): Promise<SignedPhoto> => {
      const row = byId.get(rowId);
      const entry = (row?.photos as PhotoEntry[] | undefined)?.find((p) => p.path === path);
      if (!row?.listingId || !entry) return { rowId, path, error: 'Not a photo of this import' };
      if (entry.status === 'done') return { rowId, path, error: 'Already uploaded' };
      let key: string;
      try {
        key = newStorageKey({ kind: 'listing', id: row.listingId }, type ?? 'image/jpeg');
      } catch {
        return { rowId, path, error: 'Not a JPEG, PNG, WebP or AVIF image' };
      }
      try {
        return { rowId, path, key, ...(await sign(key)) };
      } catch (err) {
        return { rowId, path, error: err instanceof MediaError ? err.message : 'Could not start this upload' };
      }
    }),
  );
}

/**
 * Record up to PHOTO_BATCH uploaded photos, and the ones the browser could not send. Each object is
 * checked in storage first (outside any transaction, as `addListingPhoto` does); then the batch's
 * rows go in one transaction, in each listing's folder order. A photo over a listing's limit is
 * `failed` with the reason; the rest of the batch goes in.
 */
export async function confirmImportPhotos(db: Db, actor: Actor, id: string, input: unknown, deps: FolderPhotoDeps = {}): Promise<{ done: number; failed: number }> {
  const parsed = confirmSchema.safeParse(input);
  if (!parsed.success) throw new ImportError('invalid', `Confirm at most ${PHOTO_BATCH} photos at a time`);
  const imp = await runnableListingsImport(db, actor, id, ['importing', 'done']);
  const { uploaded, failed } = parsed.data;
  const rowIds = [...new Set([...uploaded, ...failed].map((r) => r.rowId))];
  if (!rowIds.length) return { done: 0, failed: 0 };
  const rows = await db
    .select({ id: listingImportRow.id, listingId: listingImportRow.listingId })
    .from(listingImportRow)
    .where(and(eq(listingImportRow.importId, imp.id), inArray(listingImportRow.status, ['imported', 'updated']), inArray(listingImportRow.id, rowIds)));
  const listingOf = new Map(rows.map((r) => [r.id, r.listingId]));

  const describe = deps.describe ?? describeObject;
  const checked = await Promise.all(
    uploaded.map(async (u) => {
      const listingId = listingOf.get(u.rowId);
      if (!listingId || !keyBelongsTo(u.key, { kind: 'listing', id: listingId })) return { ...u, error: 'That image does not belong to this listing' };
      return (await describe(u.key)) ? { ...u } : { ...u, error: 'That image was not uploaded — try again' };
    }),
  );
  const outcome = new Map<string, { key?: string; error?: string; width?: number; height?: number }>();
  for (const c of checked) outcome.set(`${c.rowId}|${c.path}`, c);
  for (const f of failed) outcome.set(`${f.rowId}|${f.path}`, { error: f.error || 'Could not upload this photo' });

  let done = 0;
  let bad = 0;
  await db.transaction(async (tx) => {
    // Re-read inside the transaction and lock the rows: a second tab confirming the same photo waits, then sees it done.
    const locked = await tx
      .select({ id: listingImportRow.id, listingId: listingImportRow.listingId, photos: listingImportRow.photos })
      .from(listingImportRow)
      .where(and(eq(listingImportRow.importId, imp.id), inArray(listingImportRow.id, rows.map((r) => r.id))))
      .for('update');
    const updates: { id: string; photos: PhotoEntry[] }[] = [];
    for (const r of locked) {
      const photos = (r.photos as PhotoEntry[]).map((p) => ({ ...p }));
      let changed = false;
      for (const p of photos) {
        const o = p.path ? outcome.get(`${r.id}|${p.path}`) : undefined;
        if (!o || p.status === 'done') continue;
        changed = true;
        if (o.error || !o.key) {
          p.status = 'failed';
          p.error = o.error ?? 'Could not upload this photo';
          bad += 1;
          continue;
        }
        try {
          await (p.kind === 'floorplan' ? recordListingFloorplan : recordListingPhoto)(tx, r.listingId!, o.key, { width: o.width ?? null, height: o.height ?? null });
          p.status = 'done';
          delete p.error;
          done += 1;
        } catch (err) {
          if (!(err instanceof MediaError)) throw err;
          p.status = 'failed';
          p.error = err.message;
          bad += 1;
        }
      }
      if (changed) updates.push({ id: r.id, photos });
    }
    await writePhotos(tx, imp.id, updates);
  });
  return { done, failed: bad };
}
