'use server';

import { revalidatePath } from 'next/cache';
import { deleteAllNotebooks, deleteNotebook, deletePhoto, NotebookError, saveNotebook } from '@repo/core/inspections';
import { deleteInspectionPhotos } from '@repo/core/inspections/photo-storage';
import { consumerSkillBlocks, consumerSkillOffMessage } from '@repo/core/consumer-skills';
import { ensureConsumerAccount } from '../../../lib/account';
import { getWebDb } from '../../../lib/db';

export type NotebookActionResult = { ok: true } | { ok: false; error: string };

/**
 * Inspection Assistant's writes (ADR 0080, C6 decisions 6–8). The actor from the session only; core's strict schema
 * checks the marks and notes, and `can()` decides. Writing needs the skill on; deleting never does — a buyer can
 * always remove their own notes. Rows go first, then the photos' files.
 */
async function run(fn: (actor: { userId: string }) => Promise<string[] | void>, opts: { write: boolean }): Promise<NotebookActionResult> {
  const user = await ensureConsumerAccount();
  if (!user) return { ok: false, error: 'Sign in to keep inspection notes.' };
  const actor = { userId: user.id };
  const db = getWebDb();
  if (opts.write) {
    const block = (await consumerSkillBlocks(db, actor)).get('inspection_notes');
    if (block) return { ok: false, error: consumerSkillOffMessage('inspection_notes', block) };
  }
  try {
    const keys = await fn(actor);
    if (keys?.length && !(await deleteInspectionPhotos(keys))) console.error('[inspection-notes] rows deleted; storage kept', keys.length, 'files');
    revalidatePath('/account/inspections', 'layout');
    return { ok: true };
  } catch (err) {
    if (err instanceof NotebookError) return { ok: false, error: err.message };
    console.error('[inspection-notes] failed', err);
    return { ok: false, error: 'Something went wrong. Try again.' };
  }
}

export async function saveNotes(listingId: string, patch: unknown): Promise<NotebookActionResult> {
  return run((actor) => saveNotebook(getWebDb(), actor, String(listingId), patch), { write: true });
}

export async function removePhoto(photoId: string): Promise<NotebookActionResult> {
  return run((actor) => deletePhoto(getWebDb(), actor, String(photoId)), { write: false });
}

export async function removeNotebook(listingId: string): Promise<NotebookActionResult> {
  return run((actor) => deleteNotebook(getWebDb(), actor, String(listingId)), { write: false });
}

export async function removeAllNotebooks(): Promise<NotebookActionResult> {
  return run((actor) => deleteAllNotebooks(getWebDb(), actor), { write: false });
}
