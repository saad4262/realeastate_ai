import { and, desc, eq, sql } from 'drizzle-orm';
import { contactProperty, document, documentChunk, listing, user, type Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { loadContactHead } from '../contacts/get-contact';
import { contactResource } from '../contacts/visibility';
import {
  DOCUMENT_MIME_TYPES,
  documentFileSchema,
  documentKeyBelongsTo,
  documentMimeType,
  newDocumentKey,
  recordDocumentSchema,
  type DocumentFileInput,
  type DocumentKind,
  type DocumentScope,
  type DocumentStatus,
  type DocumentTarget,
  type RecordDocumentInput,
} from './document-schema';
import { documentScopeFilters } from './visibility';
import {
  DocumentStorageError,
  deleteDocumentObject,
  describeDocumentObject,
  signDocumentDownload,
  signDocumentUpload,
} from './storage';

/**
 * Documents: the rows (ADR 0053). Same order as listing photos, for the same reasons
 * (media/listing-media.ts): permission → a key the server chose → the browser uploads →
 * the object is HEADed → only then the row. Delete the row first, the file after.
 * Network calls are never inside a transaction.
 */

export class DocumentError extends Error {
  readonly code: 'forbidden' | 'not_found' | 'invalid' | 'storage';
  constructor(code: DocumentError['code'], message: string) {
    super(message);
    this.name = 'DocumentError';
    this.code = code;
  }
}

const NOT_FOUND = () => new DocumentError('not_found', 'That document was not found');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DocumentView = {
  id: string;
  title: string;
  kind: DocumentKind;
  scope: DocumentScope;
  mimeType: string;
  sizeBytes: number;
  status: DocumentStatus;
  error: string | null;
  pageCount: number | null;
  extractedVia: string | null;
  isPrivate: boolean;
  createdAt: Date;
  uploaderName: string | null;
  /** It arrived as an email attachment. */
  fromEmail: boolean;
  /** Delete it — decided by can(), per row. */
  mayDelete: boolean;
};

/** Where a document is going, once can() said yes: everything the row needs, from the database. */
type ResolvedTarget = {
  agencyId: string;
  scope: DocumentScope;
  contactId: string | null;
  propertyId: string | null;
  listingId: string | null;
};

/**
 * May this actor add a document HERE? Resolves the target from the database — the agency is
 * the session's, a contact must be one they can see, a listing one of their agency's.
 */
export async function resolveUploadTarget(db: Db, actor: Actor, target: DocumentTarget): Promise<ResolvedTarget> {
  const agencyId = actor.agencyId;
  if (!agencyId) throw new DocumentError('forbidden', 'You are not a member of an agency');
  switch (target.on) {
    case 'knowledge':
      if (!can(actor, 'knowledge:manage', { type: 'knowledge', agencyId })) {
        throw new DocumentError('forbidden', 'Only owners and admins add to the knowledge base');
      }
      return { agencyId, scope: 'knowledge', contactId: null, propertyId: null, listingId: null };
    case 'contact': {
      const head = await loadContactHead(db, actor, target.contactId);
      if (!head || head.row.mergedIntoId) throw new DocumentError('not_found', 'That contact was not found');
      const resource = contactResource(head.facts);
      if (!can(actor, 'contact:read', resource)) throw new DocumentError('not_found', 'That contact was not found');
      if (!can(actor, 'document:upload', resource)) throw new DocumentError('forbidden', 'You can see this contact but not add documents to it');
      let propertyId: string | null = null;
      if (target.propertyId) {
        // Only an address already linked to this person: a document cannot name somebody else's house.
        const [link] = await db
          .select({ id: contactProperty.propertyId })
          .from(contactProperty)
          .where(and(eq(contactProperty.contactId, head.row.id), eq(contactProperty.propertyId, target.propertyId)))
          .limit(1);
        propertyId = link?.id ?? null;
      }
      return { agencyId: head.row.agencyId, scope: 'record', contactId: head.row.id, propertyId, listingId: null };
    }
    case 'listing': {
      const [row] = await db
        .select({ id: listing.id, agencyId: listing.agencyId, propertyId: listing.propertyId })
        .from(listing)
        .where(and(eq(listing.id, target.listingId), eq(listing.agencyId, agencyId)))
        .limit(1);
      if (!row) throw new DocumentError('not_found', 'That listing was not found');
      if (!can(actor, 'document:upload_listing', { type: 'listing', id: row.id, agencyId: row.agencyId })) {
        throw new DocumentError('forbidden', 'Only the agents on this listing, and admins, add documents to it');
      }
      return { agencyId: row.agencyId, scope: 'record', contactId: null, propertyId: row.propertyId, listingId: row.id };
    }
  }
}

/** Step 1: permission, then a URL that can write one key — chosen here, never by the browser. */
export async function prepareDocumentUpload(
  db: Db,
  actor: Actor,
  target: DocumentTarget,
  file: DocumentFileInput,
): Promise<{ key: string; uploadUrl: string; token: string; contentType: string }> {
  const parsed = documentFileSchema.safeParse(file);
  if (!parsed.success) throw new DocumentError('invalid', parsed.error.issues[0]?.message ?? 'That file cannot be uploaded');
  const contentType = documentMimeType(parsed.data);
  if (!contentType) throw new DocumentError('invalid', 'PDF, Word (.docx), images (JPEG, PNG, WebP) and text files only');
  const resolved = await resolveUploadTarget(db, actor, target);
  const key = newDocumentKey(resolved.agencyId, contentType);
  try {
    const { uploadUrl, token } = await signDocumentUpload(key);
    return { key, uploadUrl, token, contentType };
  } catch (err) {
    throw new DocumentError('storage', err instanceof Error ? err.message : 'Storage is not available');
  }
}

/** Step 3: the object is checked in storage, then the row is written. Returns the new id. */
export async function recordDocument(
  db: Db,
  actor: Actor,
  target: DocumentTarget,
  input: RecordDocumentInput,
): Promise<{ id: string }> {
  const parsed = recordDocumentSchema.safeParse(input);
  if (!parsed.success) throw new DocumentError('invalid', parsed.error.issues[0]?.message ?? 'That document cannot be saved');
  const resolved = await resolveUploadTarget(db, actor, target);
  if (!documentKeyBelongsTo(parsed.data.key, resolved.agencyId)) throw new DocumentError('invalid', 'That file does not belong to this agency');

  // Outside any transaction: an HTTP call to storage.
  let object: { contentType: string; bytes: number } | null;
  try {
    object = await describeDocumentObject(parsed.data.key);
  } catch (err) {
    throw new DocumentError(err instanceof DocumentStorageError ? 'invalid' : 'storage', err instanceof Error ? err.message : 'Storage is not available');
  }
  if (!object) throw new DocumentError('invalid', 'That file was not uploaded — try again');
  // The key's extension was chosen from the type the browser declared; storage must agree.
  if (!parsed.data.key.endsWith(`.${DOCUMENT_MIME_TYPES[object.contentType]}`)) throw new DocumentError('invalid', 'That file is not the type it said it was');

  const [row] = await db
    .insert(document)
    .values({
      agencyId: resolved.agencyId,
      scope: resolved.scope,
      contactId: resolved.contactId,
      propertyId: resolved.propertyId,
      listingId: resolved.listingId,
      uploadedBy: actor.userId,
      title: parsed.data.title,
      kind: parsed.data.kind,
      storageKey: parsed.data.key,
      mimeType: object.contentType,
      sizeBytes: object.bytes,
      // The knowledge base is the agency's own voice: never private.
      isPrivate: resolved.scope === 'knowledge' ? false : parsed.data.isPrivate,
    })
    .returning({ id: document.id });
  if (!row) throw new DocumentError('storage', 'Could not record that document');
  return { id: row.id };
}

function mayDeleteRow(actor: Actor, r: { agencyId: string; scope: string; uploadedBy: string | null }): boolean {
  if (r.scope === 'knowledge') return can(actor, 'knowledge:manage', { type: 'knowledge', agencyId: r.agencyId });
  return can(actor, 'document:delete', { type: 'document', agencyId: r.agencyId, ...(r.uploadedBy ? { ownerId: r.uploadedBy } : {}) });
}

const LIST_LIMIT = 100;

/** The documents here that this actor may see, newest first. One statement. */
export async function listDocuments(db: Db, actor: Actor, target: DocumentTarget): Promise<DocumentView[]> {
  if (!actor.agencyId) return [];
  const where = [...documentScopeFilters(actor)];
  if (target.on === 'knowledge') where.push(eq(document.scope, 'knowledge'));
  else if (target.on === 'contact') where.push(eq(document.scope, 'record'), eq(document.contactId, target.contactId));
  else where.push(eq(document.scope, 'record'), eq(document.listingId, target.listingId));
  const rows = await db
    .select({
      id: document.id,
      agencyId: document.agencyId,
      title: document.title,
      kind: document.kind,
      scope: document.scope,
      mimeType: document.mimeType,
      sizeBytes: document.sizeBytes,
      status: document.status,
      error: document.error,
      pageCount: document.pageCount,
      extractedVia: document.extractedVia,
      isPrivate: document.isPrivate,
      createdAt: document.createdAt,
      uploadedBy: document.uploadedBy,
      uploaderName: user.name,
      mailMessageId: document.mailMessageId,
    })
    .from(document)
    .leftJoin(user, eq(user.id, document.uploadedBy))
    .where(and(...where))
    .orderBy(desc(document.createdAt), desc(document.id))
    .limit(LIST_LIMIT);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    kind: r.kind as DocumentKind,
    scope: r.scope as DocumentScope,
    mimeType: r.mimeType,
    sizeBytes: r.sizeBytes,
    status: r.status as DocumentStatus,
    error: r.error,
    pageCount: r.pageCount,
    extractedVia: r.extractedVia,
    isPrivate: r.isPrivate,
    createdAt: r.createdAt,
    uploaderName: r.uploaderName,
    fromEmail: Boolean(r.mailMessageId),
    mayDelete: mayDeleteRow(actor, r),
  }));
}

/** May this actor add documents here? For the page to draw (or not draw) the upload box. Never throws. */
export async function mayUploadDocument(db: Db, actor: Actor, target: DocumentTarget): Promise<boolean> {
  try {
    await resolveUploadTarget(db, actor, target);
    return true;
  } catch {
    return false;
  }
}

/** One document this actor may see — the list's own rule — or null. */
async function visibleDocument(db: Db, actor: Actor, id: string) {
  if (!actor.agencyId || !UUID.test(id)) return null;
  const [row] = await db
    .select({
      id: document.id,
      agencyId: document.agencyId,
      scope: document.scope,
      title: document.title,
      storageKey: document.storageKey,
      uploadedBy: document.uploadedBy,
      status: document.status,
      extractedText: document.extractedText,
      pageCount: document.pageCount,
    })
    .from(document)
    .where(and(eq(document.id, id), ...documentScopeFilters(actor)))
    .limit(1);
  return row ?? null;
}

/** A download link that works for a minute, for one document this actor may see. */
export async function documentDownloadUrl(db: Db, actor: Actor, id: string): Promise<string> {
  const row = await visibleDocument(db, actor, id);
  if (!row) throw NOT_FOUND();
  const ext = row.storageKey.split('.').pop() ?? 'bin';
  const safe = row.title.replace(/[^\w .()-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'document';
  try {
    return await signDocumentDownload(row.storageKey, `${safe}.${ext}`);
  } catch (err) {
    throw new DocumentError('storage', err instanceof Error ? err.message : 'Storage is not available');
  }
}

/** Hide the row and its chunks (one transaction), then remove the file. */
export async function deleteDocument(db: Db, actor: Actor, id: string): Promise<void> {
  const row = await visibleDocument(db, actor, id);
  if (!row) throw NOT_FOUND();
  if (!mayDeleteRow(actor, row)) throw new DocumentError('forbidden', 'Only the person who added it, or an admin, can delete this document');
  await db.transaction(async (tx) => {
    await tx.delete(documentChunk).where(eq(documentChunk.documentId, row.id));
    await tx
      .update(document)
      .set({ deletedAt: sql`now()`, extractedText: null, updatedAt: sql`now()` })
      .where(and(eq(document.id, row.id), eq(document.agencyId, row.agencyId)));
  });
  await deleteDocumentObject(row.storageKey);
}

/** Read it again: a failed document goes back in the queue. Whoever may delete it may retry it. */
export async function retryDocument(db: Db, actor: Actor, id: string): Promise<void> {
  const row = await visibleDocument(db, actor, id);
  if (!row) throw NOT_FOUND();
  if (!mayDeleteRow(actor, row)) throw new DocumentError('forbidden', 'Only the person who added it, or an admin, can retry this document');
  if (row.status !== 'failed') return;
  await db
    .update(document)
    .set({ status: 'pending', attempts: 0, error: null, updatedAt: sql`now()` })
    .where(and(eq(document.id, row.id), eq(document.agencyId, row.agencyId)));
}

export const MAX_READ_PAGES = 10;
const MAX_READ_CHARS = 30_000;

export type DocumentPages = {
  id: string;
  title: string;
  status: DocumentStatus;
  pageCount: number;
  pages: { page: number; text: string }[];
  truncated: boolean;
};

/**
 * Pages `from`..`to` (1-based, at most MAX_READ_PAGES) of one document this actor may see — for
 * the assistant's read_document. Null when it is not theirs to see (indistinguishable from absent).
 */
export async function readDocumentPages(db: Db, actor: Actor, id: string, from = 1, to?: number): Promise<DocumentPages | null> {
  const row = await visibleDocument(db, actor, id);
  if (!row) return null;
  const all = (row.extractedText ?? '').split('\f');
  const count = row.extractedText ? all.length : 0;
  const start = Math.max(1, Math.floor(from));
  const end = Math.min(count, Math.max(start, Math.floor(to ?? start + MAX_READ_PAGES - 1)), start + MAX_READ_PAGES - 1);
  const pages: { page: number; text: string }[] = [];
  let used = 0;
  let truncated = false;
  for (let p = start; p <= end; p += 1) {
    const text = (all[p - 1] ?? '').trim();
    if (used + text.length > MAX_READ_CHARS) {
      pages.push({ page: p, text: text.slice(0, Math.max(0, MAX_READ_CHARS - used)) });
      truncated = true;
      break;
    }
    used += text.length;
    pages.push({ page: p, text });
  }
  return { id: row.id, title: row.title, status: row.status as DocumentStatus, pageCount: row.pageCount ?? count, pages, truncated: truncated || end < count };
}
