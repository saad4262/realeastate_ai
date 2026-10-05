import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { contact, note, user, type Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { noteBodySchema } from './contact-schema';
import { loadContactHead, type ReadableContact } from './get-contact';
import { CONTACT_NOT_FOUND, ContactError } from './list-contacts';
import { contactResource } from './visibility';

/**
 * Notes on a contact (ADR 0018). Anyone who may see the contact reads them;
 * `note:create` writes one (not read-only members); `note:manage` — the author
 * or an admin — edits or deletes one. A delete sets `deleted_at` and keeps the
 * row: nothing here destroys what somebody wrote.
 */

export type NoteView = {
  id: string;
  body: string;
  authorName: string | null;
  createdAt: Date;
  /** Set when the text was changed after it was written. */
  editedAt: Date | null;
  /** Decided by can() with the author as owner. */
  mayManage: boolean;
};

export async function listContactNotes(
  db: Db,
  actor: Actor,
  c: ReadableContact,
): Promise<NoteView[]> {
  const rows = await db
    .select({
      id: note.id,
      body: note.body,
      authorId: note.authorId,
      authorName: user.name,
      authorEmail: user.email,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    })
    .from(note)
    .leftJoin(user, eq(user.id, note.authorId))
    .where(and(eq(note.contactId, c.id), eq(note.agencyId, c.agencyId), isNull(note.deletedAt)))
    .orderBy(desc(note.createdAt), desc(note.id))
    .limit(200);
  return rows.map((r) => {
    const created = new Date(r.createdAt);
    const updated = new Date(r.updatedAt);
    return {
      id: r.id,
      body: r.body,
      authorName: r.authorName || r.authorEmail || null,
      createdAt: created,
      // A minute's grace: the insert's own timestamps differ by microseconds.
      editedAt: updated.getTime() - created.getTime() > 60_000 ? updated : null,
      mayManage: can(actor, 'note:manage', {
        type: 'note',
        id: r.id,
        agencyId: c.agencyId,
        ...(r.authorId ? { ownerId: r.authorId } : {}),
      }),
    };
  });
}

function parseBody(body: string): string {
  const parsed = noteBodySchema.safeParse(body);
  if (!parsed.success) throw new ContactError('invalid', parsed.error.issues[0]?.message ?? 'Check the note');
  return parsed.data;
}

export async function createNote(
  db: Db,
  actor: Actor,
  contactId: string,
  body: string,
): Promise<{ id: string }> {
  const head = await loadContactHead(db, actor, contactId);
  if (!head || head.row.mergedIntoId) throw CONTACT_NOT_FOUND();
  const resource = contactResource(head.facts);
  if (!can(actor, 'contact:read', resource)) throw CONTACT_NOT_FOUND();
  if (!can(actor, 'note:create', resource)) {
    throw new ContactError('forbidden', 'You can read this contact but not add notes');
  }
  const text = parseBody(body);
  const [row] = await db
    .insert(note)
    .values({ agencyId: head.row.agencyId, contactId: head.row.id, authorId: actor.userId, body: text })
    .returning({ id: note.id });
  return { id: row!.id };
}

/** The note, its contact, and whether this actor may change it. Not-found if unseen. */
async function loadManageable(db: Db, actor: Actor, noteId: string) {
  if (!actor.agencyId || !/^[0-9a-f-]{36}$/i.test(noteId)) throw new ContactError('not_found', 'That note was not found');
  const [n] = await db
    .select({ id: note.id, contactId: note.contactId, authorId: note.authorId, agencyId: note.agencyId })
    .from(note)
    .innerJoin(contact, eq(contact.id, note.contactId))
    .where(and(eq(note.id, noteId), eq(note.agencyId, actor.agencyId), isNull(note.deletedAt)))
    .limit(1);
  if (!n) throw new ContactError('not_found', 'That note was not found');
  const head = await loadContactHead(db, actor, n.contactId);
  if (!head || !can(actor, 'contact:read', contactResource(head.facts))) {
    throw new ContactError('not_found', 'That note was not found');
  }
  const resource = { type: 'note', id: n.id, agencyId: n.agencyId, ...(n.authorId ? { ownerId: n.authorId } : {}) };
  if (!can(actor, 'note:manage', resource)) {
    throw new ContactError('forbidden', 'Only whoever wrote this note, or an admin, may change it');
  }
  return n;
}

export async function updateNote(db: Db, actor: Actor, noteId: string, body: string): Promise<{ contactId: string }> {
  const n = await loadManageable(db, actor, noteId);
  const text = parseBody(body);
  await db.update(note).set({ body: text, updatedAt: sql`now()` }).where(eq(note.id, n.id));
  return { contactId: n.contactId };
}

export async function deleteNote(db: Db, actor: Actor, noteId: string): Promise<{ contactId: string }> {
  const n = await loadManageable(db, actor, noteId);
  await db
    .update(note)
    .set({ deletedAt: sql`now()`, deletedBy: actor.userId, updatedAt: sql`now()` })
    .where(eq(note.id, n.id));
  return { contactId: n.contactId };
}
