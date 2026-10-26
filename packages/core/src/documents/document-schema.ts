import { z } from 'zod';

/**
 * Documents and the knowledge base (docs/adr/0053) — the contract, in one place.
 *
 * Client-safe: no database, no storage client. The upload island imports the
 * limits from here so the picker offers exactly what the server will take.
 */

export const DOCUMENT_SCOPES = ['record', 'knowledge'] as const;
export type DocumentScope = (typeof DOCUMENT_SCOPES)[number];

export const DOCUMENT_KINDS = ['contract', 'report', 'proposal', 'form', 'policy', 'procedure', 'script', 'template', 'photo', 'other'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  contract: 'Contract',
  report: 'Report',
  proposal: 'Proposal',
  form: 'Form',
  policy: 'Policy',
  procedure: 'Procedure',
  script: 'Script',
  template: 'Template',
  photo: 'Photo',
  other: 'Other',
};

/** Which kinds a picker offers where: a contact's file is rarely a policy, the knowledge base rarely a contract. */
export const RECORD_KINDS: readonly DocumentKind[] = ['contract', 'report', 'proposal', 'form', 'photo', 'other'];
export const KNOWLEDGE_KINDS: readonly DocumentKind[] = ['policy', 'procedure', 'script', 'template', 'form', 'other'];

export const DOCUMENT_STATUSES = ['pending', 'extracting', 'ready', 'failed'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/**
 * MIME type → the extension the key gets. Matched to the bucket's allowed_mime_types
 * (DEPLOY.md), so the bucket's own 415 and this list agree.
 */
export const DOCUMENT_MIME_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
};

/** A browser often reports no type for `.md` (and some for `.docx`): the extension decides then. */
const EXTENSION_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
};

/** The type to upload a file as: what the browser said, else what its name says, else null (refused). */
export function documentMimeType(file: { type: string; name: string }): string | null {
  const said = file.type.toLowerCase().split(';')[0]!.trim();
  if (DOCUMENT_MIME_TYPES[said]) return said;
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  return EXTENSION_TYPES[ext] ?? null;
}

/** For `<input accept>`. */
export const DOCUMENT_ACCEPT = [...Object.keys(DOCUMENT_MIME_TYPES), '.pdf', '.docx', '.md', '.txt', '.csv'].join(',');

/** 25 MB — the bucket's own ceiling (DEPLOY.md). A contract scan is rarely more. */
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

export function isImageType(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const EXTENSIONS = [...new Set(Object.values(DOCUMENT_MIME_TYPES))];
const KEY_PATTERN = new RegExp(`^documents/(${UUID})/${UUID}\\.(${EXTENSIONS.join('|')})$`);

/**
 * `documents/<agencyId>/<uuid>.<ext>`. The agency is in the path so a key can be checked
 * against the session's agency before anything is written — the same defence as a listing
 * photo's key (media/storage-key.ts): a key has been to a browser and back.
 */
export const documentKeySchema = z.string().max(200).regex(KEY_PATTERN, 'Not a document this platform issued');

export function newDocumentKey(agencyId: string, mimeType: string): string {
  const ext = DOCUMENT_MIME_TYPES[mimeType.toLowerCase()];
  if (!ext) throw new Error(`Unsupported document type: ${mimeType}`);
  return `documents/${agencyId.toLowerCase()}/${crypto.randomUUID()}.${ext}`;
}

export function documentKeyBelongsTo(key: string, agencyId: string): boolean {
  const match = KEY_PATTERN.exec(key);
  return Boolean(match && match[1] === agencyId.toLowerCase());
}

/** What the browser says about the file before it uploads it. */
export const documentFileSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    type: z.string().max(200),
    size: z.number().int().positive().max(MAX_DOCUMENT_BYTES, 'Documents must be 25 MB or smaller'),
  })
  .strict();
export type DocumentFileInput = z.infer<typeof documentFileSchema>;

/** Where a document goes. The agency is never a field: it is the session's. */
export const documentTargetSchema = z.discriminatedUnion('on', [
  z.object({ on: z.literal('contact'), contactId: z.string().uuid(), propertyId: z.string().uuid().nullish() }).strict(),
  z.object({ on: z.literal('listing'), listingId: z.string().uuid() }).strict(),
  z.object({ on: z.literal('knowledge') }).strict(),
]);
export type DocumentTarget = z.infer<typeof documentTargetSchema>;

/** The row the second call records, once the bytes are in the bucket. */
export const recordDocumentSchema = z
  .object({
    key: documentKeySchema,
    title: z.string().trim().min(1, 'Give it a title').max(200),
    kind: z.enum(DOCUMENT_KINDS),
    isPrivate: z.boolean().default(false),
  })
  .strict();
export type RecordDocumentInput = z.input<typeof recordDocumentSchema>;

/** A title from a filename: no extension, separators as spaces. */
export function titleFromFilename(name: string): string {
  const base = name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (base || 'Untitled document').slice(0, 200);
}

/** The `ai_run` feature of a scan read by the vision reader (ADR 0053 §4) — its per-agency cap sums on it. */
export const DOCUMENT_READ_FEATURE = 'document-read';
