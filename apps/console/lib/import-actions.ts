'use server';

import { revalidatePath } from 'next/cache';
import {
  cancelImport,
  createImport,
  createImportFromSheet,
  createImportFromXlsx,
  pickerSession,
  reimportSheet,
  sheetsDepsFromEnv,
  sheetTabs,
  type PickerSession,
  type SheetTab,
  getImport,
  importReport,
  ImportError,
  runImportChunk,
  setImportMapping,
  startDryRun,
  startImport,
  type ImportMode,
  type ImportReportRow,
  type ImportView,
} from '@repo/core/imports';
import { tokenKeysFromEnv } from '@repo/core/integrations';
import { getConsoleDb } from './db';
import { loadListingActor } from './load-actor';
import { requireActionUserId } from './auth-account';

/**
 * CSV listing import (docs/adr/0029). The actor comes from the session — with
 * listing links, because an agent's import submits listings for approval — and
 * every decision is core's.
 */
type R<T> = { ok: true } & T | { ok: false; error: string };

/** One upload's largest file — under the 4.4 MB body limit in next.config.ts, which Vercel's 4.5 MB caps. */
const UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

async function actor() {
  const a = await loadListingActor(await requireActionUserId());
  if (!a) throw new ImportError('forbidden', 'Database is not configured.');
  return a;
}

function fail(err: unknown): { ok: false; error: string } {
  if (err instanceof ImportError) return { ok: false, error: err.message };
  console.error('[import] action failed', err);
  return { ok: false, error: 'That did not work. Please try again.' };
}

export async function uploadImportAction(form: FormData): Promise<R<{ id: string; sameFileAs: string | null }>> {
  try {
    const file = form.get('file');
    if (!(file instanceof File) || !file.size) return { ok: false, error: 'Choose a CSV or Excel file first' };
    // 4 MB: what one upload can carry on Vercel (next.config.ts). A Google Sheet has no such limit.
    if (file.size > UPLOAD_MAX_BYTES) return { ok: false, error: 'That file is larger than 4 MB. Split it into smaller files, or import it from Google Sheets.' };
    const mode = form.get('mode') === 'draft' ? 'draft' : 'live';
    // An Excel workbook (ADR 0029 amendment) is read into the same rows a CSV would give.
    const isXlsx = /\.xlsx$/i.test(file.name) || file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const sheet = String(form.get('sheet') ?? '').trim().slice(0, 100) || null;
    const r = isXlsx
      ? await createImportFromXlsx(getConsoleDb(), await actor(), { fileName: file.name, bytes: await file.arrayBuffer(), sheet, mode: mode as ImportMode })
      : await createImport(getConsoleDb(), await actor(), { fileName: file.name, text: await file.text(), mode: mode as ImportMode });
    return { ok: true, id: r.id, sameFileAs: r.sameFileAs ? r.sameFileAs.createdAt.toISOString() : null };
  } catch (err) {
    return fail(err);
  }
}

export async function getImportAction(id: string): Promise<R<{ view: ImportView; problems: ImportReportRow[] }>> {
  try {
    const a = await actor();
    const view = await getImport(getConsoleDb(), a, id);
    const problems = ['validated', 'importing', 'done', 'failed', 'cancelled'].includes(view.status)
      ? await importReport(getConsoleDb(), a, id, { onlyProblems: true, limit: 500 })
      : [];
    return { ok: true, view, problems };
  } catch (err) {
    return fail(err);
  }
}

export async function setMappingAction(id: string, mapping: Record<string, number | null>): Promise<R<object>> {
  try {
    await setImportMapping(getConsoleDb(), await actor(), id, mapping);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function startDryRunAction(id: string): Promise<R<object>> {
  try {
    await startDryRun(getConsoleDb(), await actor(), id);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function startImportAction(id: string, updateDuplicates: boolean): Promise<R<object>> {
  try {
    await startImport(getConsoleDb(), await actor(), id, { updateDuplicates });
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/** One chunk. The open page calls this in a loop; the cron tick does the same when nobody is watching. */
export async function continueImportAction(id: string): Promise<R<{ status: string; processed: number; busy: boolean }>> {
  try {
    const r = await runImportChunk(getConsoleDb(), await actor(), id);
    if (r.status === 'done') {
      revalidatePath('/live-listings');
      revalidatePath('/listings');
    }
    return { ok: true, status: r.status, processed: r.processed, busy: Boolean(r.busy) };
  } catch (err) {
    return fail(err);
  }
}

export async function cancelImportAction(id: string): Promise<R<object>> {
  try {
    await cancelImport(getConsoleDb(), await actor(), id);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

// ── Google Sheets by the Picker (ADR 0029 amendment) ─────────────────────────

function sheetsDeps() {
  return sheetsDepsFromEnv(tokenKeysFromEnv());
}

/**
 * What the browser's Google Picker needs: a short-lived access token for this person's Sheets
 * connection, the browser key and the project number. Never the refresh token. Core decides who
 * may have one (they may import, and may use that connection).
 */
export async function sheetPickerAction(): Promise<PickerSession> {
  try {
    return await pickerSession(getConsoleDb(), await actor(), sheetsDeps());
  } catch (err) {
    return fail(err);
  }
}

/** The picked file's title and tabs. */
export async function sheetTabsAction(spreadsheetId: string): Promise<R<{ title: string; tabs: SheetTab[] }>> {
  try {
    const deps = sheetsDeps();
    if (!deps) return { ok: false, error: 'Google Sheets import is not set up on this server yet.' };
    const r = await sheetTabs(getConsoleDb(), await actor(), String(spreadsheetId), deps);
    return { ok: true, ...r };
  } catch (err) {
    return fail(err);
  }
}

/** Read the chosen tab and start an import from it — then the same screens as a CSV. */
export async function importSheetAction(input: { spreadsheetId: string; tab: string; mode: 'live' | 'draft' }): Promise<R<{ id: string; sameFileAs: string | null }>> {
  try {
    const deps = sheetsDeps();
    if (!deps) return { ok: false, error: 'Google Sheets import is not set up on this server yet.' };
    const r = await createImportFromSheet(getConsoleDb(), await actor(), { spreadsheetId: String(input.spreadsheetId), tab: String(input.tab), mode: input.mode === 'draft' ? 'draft' : 'live' }, deps);
    return { ok: true, id: r.id, sameFileAs: r.sameFileAs ? r.sameFileAs.createdAt.toISOString() : null };
  } catch (err) {
    return fail(err);
  }
}

/** Read the same sheet and tab again, as a new import. */
export async function reimportSheetAction(id: string): Promise<R<{ id: string }>> {
  try {
    const deps = sheetsDeps();
    if (!deps) return { ok: false, error: 'Google Sheets import is not set up on this server yet.' };
    const r = await reimportSheet(getConsoleDb(), await actor(), id, deps);
    return { ok: true, id: r.id };
  } catch (err) {
    return fail(err);
  }
}
