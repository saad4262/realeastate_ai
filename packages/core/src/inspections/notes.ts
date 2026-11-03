import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { inspectionNote, inspectionPhoto, listing, property, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import { publicListing } from '../listings/search-listings';
import { adFacts } from '../listings/facts';
import { checklistKind, inspectionNotePatchSchema, readChecks, type ChecklistKind, type Checks } from './checklist';

/**
 * Inspection Assistant (ADR 0080, C6 decisions 6–8): a buyer's notebook for one home. Owner-only by `can()` — no
 * agency role and no platform admin reaches it, and nothing outside this module reads the tables (leads, the
 * customer profile and the Personal Property AI never see them). The photo BYTES are the route's job (strip the
 * location, store privately); this module keeps the rows and hands back storage keys to delete — rows first, so a
 * failed storage delete leaves an invisible file, never a broken link.
 */

export const MAX_PHOTOS_PER_HOME = 20;
export const MAX_NOTEBOOKS = 200;

export class NotebookError extends Error {
  constructor(
    public readonly code: 'forbidden' | 'not_found' | 'invalid' | 'limit',
    message: string,
  ) {
    super(message);
    this.name = 'NotebookError';
  }
}

function require(actor: Actor, action: 'inspection_note:read' | 'inspection_note:manage') {
  if (!can(actor, action, { type: 'inspection_note', ownerId: actor.userId })) throw new NotebookError('forbidden', 'Sign in to keep inspection notes.');
}

export type NotebookHome = { listingId: string; address: string; suburb: string; state: string; propertyType: string | null; kind: ChecklistKind; isPublic: boolean };
export type NotebookPhoto = { id: string; createdAt: Date };
export type Notebook = { home: NotebookHome; noteId: string | null; checks: Checks; notes: string; updatedAt: Date | null; photos: NotebookPhoto[] };

const homeSelect = {
  listingId: listing.id,
  street: sql<string>`concat_ws(' ', ${property.streetNumber}, ${property.street})`,
  suburb: property.suburb,
  state: property.state,
  propertyType: adFacts.propertyType,
  isPublic: sql<boolean>`${publicListing()}`,
};

const toHome = (r: { listingId: string; street: string | null; suburb: string; state: string; propertyType: string | null; isPublic: boolean }): NotebookHome => ({
  listingId: r.listingId,
  address: [r.street?.trim(), r.suburb].filter(Boolean).join(', '),
  suburb: r.suburb,
  state: r.state,
  propertyType: r.propertyType,
  kind: checklistKind(r.propertyType),
  isPublic: Boolean(r.isPublic),
});

/**
 * The notebook for one home: the buyer's own note if there is one. A home the public can no longer see opens only
 * when the buyer already has notes on it (they can always read and delete their own); a new one needs a public home.
 */
export async function loadNotebook(db: DbOrTx, actor: Actor, listingId: string): Promise<Notebook> {
  require(actor, 'inspection_note:read');
  const [[home], [note]] = await Promise.all([
    db.select(homeSelect).from(listing).innerJoin(property, eq(property.id, listing.propertyId)).where(eq(listing.id, listingId)).limit(1),
    db.select().from(inspectionNote).where(and(eq(inspectionNote.userId, actor.userId), eq(inspectionNote.listingId, listingId))).limit(1),
  ]);
  if (!home || (!home.isPublic && !note)) throw new NotebookError('not_found', 'That home is not available.');
  const photos = note
    ? await db.select({ id: inspectionPhoto.id, createdAt: inspectionPhoto.createdAt }).from(inspectionPhoto).where(eq(inspectionPhoto.noteId, note.id)).orderBy(inspectionPhoto.createdAt, inspectionPhoto.id)
    : [];
  return { home: toHome(home), noteId: note?.id ?? null, checks: readChecks(note?.checks), notes: note?.notes ?? '', updatedAt: note?.updatedAt ?? null, photos };
}

/** The note row for a home, made on first save (a public home only). */
async function ensureNote(db: DbOrTx, actor: Actor, listingId: string): Promise<string> {
  const [existing] = await db.select({ id: inspectionNote.id }).from(inspectionNote).where(and(eq(inspectionNote.userId, actor.userId), eq(inspectionNote.listingId, listingId))).limit(1);
  if (existing) return existing.id;
  const [live] = await db.select({ id: listing.id }).from(listing).where(and(eq(listing.id, listingId), publicListing())).limit(1);
  if (!live) throw new NotebookError('not_found', 'That home is not available.');
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(inspectionNote).where(eq(inspectionNote.userId, actor.userId));
  if (Number(n) >= MAX_NOTEBOOKS) throw new NotebookError('limit', `You can keep notes on up to ${MAX_NOTEBOOKS} homes. Delete some first.`);
  const [made] = await db
    .insert(inspectionNote)
    .values({ userId: actor.userId, listingId })
    .onConflictDoUpdate({ target: [inspectionNote.userId, inspectionNote.listingId], set: { updatedAt: sql`${inspectionNote.updatedAt}` } })
    .returning({ id: inspectionNote.id });
  return made!.id;
}

/** Save the marks (whole), the notes, or both. */
export async function saveNotebook(db: DbOrTx, actor: Actor, listingId: string, patch: unknown): Promise<void> {
  require(actor, 'inspection_note:manage');
  const parsed = inspectionNotePatchSchema.safeParse(patch);
  if (!parsed.success) throw new NotebookError('invalid', 'Those notes could not be saved.');
  const id = await ensureNote(db, actor, listingId);
  await db
    .update(inspectionNote)
    .set({
      ...(parsed.data.checks !== undefined ? { checks: parsed.data.checks } : {}),
      ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes.trim() || null } : {}),
      updatedAt: sql`now()`,
    })
    .where(and(eq(inspectionNote.id, id), eq(inspectionNote.userId, actor.userId)));
}

export type NotebookSummaryRow = { listingId: string; address: string; issues: number; marked: number; photos: number; hasNotes: boolean; updatedAt: Date };

/** The buyer's notebooks, latest first — the account page. One statement. */
export async function listNotebooks(db: DbOrTx, actor: Actor): Promise<NotebookSummaryRow[]> {
  require(actor, 'inspection_note:read');
  const rows = await db
    .select({
      listingId: inspectionNote.listingId,
      street: sql<string>`concat_ws(' ', ${property.streetNumber}, ${property.street})`,
      suburb: property.suburb,
      checks: inspectionNote.checks,
      notes: inspectionNote.notes,
      updatedAt: inspectionNote.updatedAt,
      photos: sql<number>`(select count(*)::int from inspection_photo p where p.note_id = ${inspectionNote.id})`,
    })
    .from(inspectionNote)
    .innerJoin(listing, eq(listing.id, inspectionNote.listingId))
    .innerJoin(property, eq(property.id, listing.propertyId))
    .where(eq(inspectionNote.userId, actor.userId))
    .orderBy(desc(inspectionNote.updatedAt), desc(inspectionNote.id))
    .limit(MAX_NOTEBOOKS);
  return rows.map((r) => {
    const checks = Object.values(readChecks(r.checks));
    return {
      listingId: r.listingId,
      address: [r.street?.trim(), r.suburb].filter(Boolean).join(', '),
      issues: checks.filter((c) => c.mark === 'issue').length,
      marked: checks.filter((c) => c.mark !== 'unchecked').length,
      photos: Number(r.photos),
      hasNotes: Boolean(r.notes?.trim()),
      updatedAt: r.updatedAt,
    };
  });
}

/** A fresh, unguessable key under the buyer's own prefix. The route stores the bytes there. */
export function photoKey(userId: string, noteId: string, ext: 'jpg' | 'png'): string {
  return `u/${userId}/${noteId}/${randomUUID()}.${ext}`;
}

/**
 * Reserve a photo: the note (made if need be), the limit, a key. The route then stores the bytes and calls
 * `recordPhoto`; nothing is written here, so a refused upload leaves no row.
 */
export async function reservePhoto(db: DbOrTx, actor: Actor, listingId: string, ext: 'jpg' | 'png'): Promise<{ noteId: string; key: string }> {
  require(actor, 'inspection_note:manage');
  const noteId = await ensureNote(db, actor, listingId);
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(inspectionPhoto).where(eq(inspectionPhoto.noteId, noteId));
  if (Number(n) >= MAX_PHOTOS_PER_HOME) throw new NotebookError('limit', `Up to ${MAX_PHOTOS_PER_HOME} photos per home. Delete one first.`);
  return { noteId, key: photoKey(actor.userId, noteId, ext) };
}

export async function recordPhoto(db: DbOrTx, actor: Actor, input: { noteId: string; key: string; contentType: string; bytes: number }): Promise<string> {
  require(actor, 'inspection_note:manage');
  if (!input.key.startsWith(`u/${actor.userId}/${input.noteId}/`)) throw new NotebookError('forbidden', 'That photo is not yours.');
  const [note] = await db.select({ id: inspectionNote.id }).from(inspectionNote).where(and(eq(inspectionNote.id, input.noteId), eq(inspectionNote.userId, actor.userId))).limit(1);
  if (!note) throw new NotebookError('not_found', 'Those notes are gone.');
  const [row] = await db.insert(inspectionPhoto).values({ noteId: input.noteId, userId: actor.userId, storageKey: input.key, contentType: input.contentType, bytes: input.bytes }).returning({ id: inspectionPhoto.id });
  await db.update(inspectionNote).set({ updatedAt: sql`now()` }).where(eq(inspectionNote.id, input.noteId));
  return row!.id;
}

/** The storage key of one of the buyer's own photos, or null — the view route signs a short link to it. */
export async function ownPhotoKey(db: DbOrTx, actor: Actor, photoId: string): Promise<string | null> {
  require(actor, 'inspection_note:read');
  const [row] = await db.select({ key: inspectionPhoto.storageKey }).from(inspectionPhoto).where(and(eq(inspectionPhoto.id, photoId), eq(inspectionPhoto.userId, actor.userId))).limit(1);
  return row?.key ?? null;
}

/** Delete one photo's row; its key comes back for the storage delete. */
export async function deletePhoto(db: DbOrTx, actor: Actor, photoId: string): Promise<string[]> {
  require(actor, 'inspection_note:manage');
  const gone = await db.delete(inspectionPhoto).where(and(eq(inspectionPhoto.id, photoId), eq(inspectionPhoto.userId, actor.userId))).returning({ key: inspectionPhoto.storageKey });
  return gone.map((g) => g.key);
}

/** Delete one home's notebook and its photos' rows (decision 8); their keys come back for the storage delete. */
export async function deleteNotebook(db: DbOrTx, actor: Actor, listingId: string): Promise<string[]> {
  require(actor, 'inspection_note:manage');
  const notes = await db.select({ id: inspectionNote.id }).from(inspectionNote).where(and(eq(inspectionNote.userId, actor.userId), eq(inspectionNote.listingId, listingId)));
  return deleteNotes(db, actor, notes.map((n) => n.id));
}

/** "Delete all my inspection notes": every notebook and photo row; every key comes back. */
export async function deleteAllNotebooks(db: DbOrTx, actor: Actor): Promise<string[]> {
  require(actor, 'inspection_note:manage');
  const notes = await db.select({ id: inspectionNote.id }).from(inspectionNote).where(eq(inspectionNote.userId, actor.userId));
  return deleteNotes(db, actor, notes.map((n) => n.id));
}

async function deleteNotes(db: DbOrTx, actor: Actor, noteIds: string[]): Promise<string[]> {
  if (!noteIds.length) return [];
  const keys = await db.select({ key: inspectionPhoto.storageKey }).from(inspectionPhoto).where(and(inArray(inspectionPhoto.noteId, noteIds), eq(inspectionPhoto.userId, actor.userId)));
  // Photos go with their note (on delete cascade).
  await db.delete(inspectionNote).where(and(inArray(inspectionNote.id, noteIds), eq(inspectionNote.userId, actor.userId)));
  return keys.map((k) => k.key);
}

/** The buyer's notebooks for a summary: the ones asked for, or the latest eight. */
export async function notebooksForSummary(db: DbOrTx, actor: Actor, listingIds?: readonly string[]): Promise<{ home: NotebookHome; checks: Checks; notes: string }[]> {
  require(actor, 'inspection_note:read');
  const rows = await db
    .select({ ...homeSelect, checks: inspectionNote.checks, notes: inspectionNote.notes })
    .from(inspectionNote)
    .innerJoin(listing, eq(listing.id, inspectionNote.listingId))
    .innerJoin(property, eq(property.id, listing.propertyId))
    .where(and(eq(inspectionNote.userId, actor.userId), ...(listingIds?.length ? [inArray(inspectionNote.listingId, [...listingIds])] : [])))
    .orderBy(desc(inspectionNote.updatedAt), desc(inspectionNote.id))
    .limit(8);
  return rows.map((r) => ({ home: toHome(r), checks: readChecks(r.checks), notes: r.notes ?? '' }));
}
