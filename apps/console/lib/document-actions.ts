'use server';

import {
  DocumentError,
  deleteDocument,
  documentTargetSchema,
  prepareDocumentUpload,
  recordDocument,
  retryDocument,
  type DocumentFileInput,
  type DocumentTarget,
  type RecordDocumentInput,
} from '@repo/core/documents';
import { getConsoleDb } from './db';
import { loadListingActor } from './load-actor';
import { requireActionUserId } from './auth-account';

/**
 * Documents (docs/adr/0053), in the photo upload's two calls: ask for a signed URL, PUT the
 * bytes straight to the private bucket, then ask for the row. The second call cannot trust the
 * first — core HEADs the object before it writes anything. The actor is rebuilt from the
 * session on every call (with listing links, for a listing's documents); the agency, the key
 * and the owner are never taken from the browser. Every decision is can()'s, in packages/core.
 */

type Fail = { ok: false; error: string };
export type DocumentSignResult = { ok: true; uploadUrl: string; token: string; key: string; contentType: string } | Fail;
export type DocumentDoneResult = { ok: true; id?: string } | Fail;

function fail(err: unknown): Fail {
  if (err instanceof DocumentError) return { ok: false, error: err.message };
  console.error('[documents] action failed', err instanceof Error ? err.message : err);
  return { ok: false, error: 'That document could not be saved. Try again.' };
}

async function actorOrThrow() {
  // Outside the try of each action: a missing session must read as signed out.
  const userId = await requireActionUserId();
  const actor = await loadListingActor(userId);
  if (!actor) throw new DocumentError('forbidden', 'Database is not configured.');
  return actor;
}

function target(raw: unknown): DocumentTarget {
  const parsed = documentTargetSchema.safeParse(raw);
  if (!parsed.success) throw new DocumentError('invalid', 'Where should this document go?');
  return parsed.data;
}

export async function signDocumentUploadAction(rawTarget: DocumentTarget, file: DocumentFileInput): Promise<DocumentSignResult> {
  const actor = await actorOrThrow();
  try {
    const signed = await prepareDocumentUpload(getConsoleDb(), actor, target(rawTarget), file);
    return { ok: true, ...signed };
  } catch (err) {
    return fail(err);
  }
}

export async function recordDocumentAction(rawTarget: DocumentTarget, input: RecordDocumentInput): Promise<DocumentDoneResult> {
  const actor = await actorOrThrow();
  try {
    const { id } = await recordDocument(getConsoleDb(), actor, target(rawTarget), input);
    return { ok: true, id };
  } catch (err) {
    return fail(err);
  }
}

export async function deleteDocumentAction(id: string): Promise<DocumentDoneResult> {
  const actor = await actorOrThrow();
  try {
    await deleteDocument(getConsoleDb(), actor, id);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function retryDocumentAction(id: string): Promise<DocumentDoneResult> {
  const actor = await actorOrThrow();
  try {
    await retryDocument(getConsoleDb(), actor, id);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}
