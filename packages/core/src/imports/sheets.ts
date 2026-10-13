import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { IntegrationError, resolveIntegration } from '../integrations/accounts';
import type { TokenKeys } from '../integrations/crypto';
import { call, ProviderError, type Fetch } from '../integrations/provider-http';
import { withAccessToken, markUsed, type ProviderDeps } from '../integrations/tokens';
import { CsvError, tableFromCells, type ImportTable } from './csv';
import { createImportFromTable, getImport, ImportError, mayCreateImport, type CreatedImport, type ImportKind, type ImportMode, type SheetRef } from './imports';

/**
 * Google Sheets by the Picker (ADR 0029 amendment, 2026-10-13). The person picks a sheet in
 * Google's own picker; our connection holds only `drive.file`, so it can open that file and
 * nothing else in their Drive. The server lists the file's tabs, reads the chosen one, and hands
 * the cells to the CSV import — which from then on cannot tell the difference.
 *
 * Every network call happens here, before any transaction. The access token the browser's Picker
 * needs is minted from the stored grant and is the ONLY thing that leaves the server: never the
 * refresh token, and only for a person allowed `integration:use` on that connection.
 *
 * The pasted-link route (any sheet the person can open) is pending Google's verification.
 */

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const WHAT = 'Google Sheets';

/** A Drive file id as Google writes it. Anything else is refused before a request is made. */
const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;

export type SheetsDeps = ProviderDeps & {
  keys: TokenKeys;
  /** The Picker's browser key and the Cloud project number (its `setAppId`). Neither is a secret. */
  picker: { apiKey: string; appId: string } | null;
};

/** From the server's environment. Null when Sheets cannot be used here (no token key). */
export function sheetsDepsFromEnv(keys: TokenKeys | null, env: NodeJS.ProcessEnv = process.env): SheetsDeps | null {
  if (!keys) return null;
  const apiKey = env.GOOGLE_PICKER_API_KEY?.trim();
  const appId = env.GOOGLE_CLOUD_PROJECT_NUMBER?.trim();
  return { keys, env, picker: apiKey && appId && /^\d+$/.test(appId) ? { apiKey, appId } : null };
}

export type SheetTab = { title: string; rows: number };

/** The two calls we make, behind a seam so tests never reach Google. */
export type SheetsApi = {
  file(token: string, spreadsheetId: string): Promise<{ title: string; tabs: SheetTab[] }>;
  values(token: string, spreadsheetId: string, tab: string): Promise<unknown[][]>;
};

export function googleSheetsApi(fetchImpl: Fetch = fetch): SheetsApi {
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  return {
    async file(token, id) {
      const url = `${SHEETS_API}/${encodeURIComponent(id)}?fields=${encodeURIComponent('properties.title,sheets.properties(title,gridProperties.rowCount)')}`;
      const { json } = await call(fetchImpl, WHAT, url, { headers: auth(token) });
      const sheets = Array.isArray(json?.sheets) ? (json!.sheets as { properties?: { title?: unknown; gridProperties?: { rowCount?: unknown } } }[]) : [];
      return {
        title: String((json?.properties as { title?: unknown } | undefined)?.title ?? 'Google Sheet').slice(0, 160),
        tabs: sheets
          .map((s) => ({ title: typeof s.properties?.title === 'string' ? s.properties.title : '', rows: Number(s.properties?.gridProperties?.rowCount ?? 0) }))
          .filter((t) => t.title),
      };
    },
    async values(token, id, tab) {
      // The tab's whole used range, as the person sees the cells (formatted), rows first.
      const range = `'${tab.replace(/'/g, "''")}'`;
      const q = new URLSearchParams({ majorDimension: 'ROWS', valueRenderOption: 'FORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING' });
      const url = `${SHEETS_API}/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?${q.toString()}`;
      const { json } = await call(fetchImpl, WHAT, url, { headers: auth(token) });
      return Array.isArray(json?.values) ? (json!.values as unknown[][]) : [];
    },
  };
}

/** Why this person cannot use Sheets now, in the words the screen shows — or their connection's id. */
async function connection(db: Db, actor: Actor): Promise<{ accountId: string } | { needsConnection: string }> {
  const { accountId, requirement } = await resolveIntegration(db, actor, 'google_sheets');
  if (accountId) return { accountId };
  return {
    needsConnection:
      requirement.state === 'expired'
        ? 'Your Google Sheets connection has expired — reconnect it on Integrations.'
        : requirement.mayConnect
          ? 'Connect Google Sheets first — on Integrations.'
          : 'Google Sheets is not connected. Ask an owner or admin to connect the agency’s, or connect your own on Integrations.',
  };
}

/** May import anything (listings or contacts): what opening the Picker and listing tabs need. The import itself asks for its kind. */
function mayImport(actor: Actor): boolean {
  return mayCreateImport(actor, 'listings') || mayCreateImport(actor, 'contacts');
}

/** A refusal from Google, in words a person can act on. A 404/403 on a drive.file token means the file was not picked with us. */
function sheetsRefusal(err: unknown): ImportError | null {
  if (err instanceof IntegrationError) return new ImportError('invalid', err.message);
  if (err instanceof ProviderError) {
    if (err.status === 403 || err.status === 404) return new ImportError('not_found', 'That sheet cannot be opened with this connection. Pick it again in the Google picker.');
    if (err.kind === 'rate_limited') return new ImportError('conflict', 'Google is busy — try again in a minute.');
    return new ImportError('conflict', 'Google Sheets did not answer — try again in a minute.');
  }
  return null;
}

async function withSheets<T>(db: Db, actor: Actor, deps: SheetsDeps, run: (token: string) => Promise<T>): Promise<T> {
  const c = await connection(db, actor);
  if ('needsConnection' in c) throw new ImportError('invalid', c.needsConnection);
  try {
    const out = await withAccessToken(db, deps.keys, actor, c.accountId, deps, run);
    await markUsed(db, c.accountId);
    return out;
  } catch (err) {
    throw sheetsRefusal(err) ?? err;
  }
}

export type PickerSession =
  | { ok: true; accessToken: string; apiKey: string; appId: string }
  | { ok: false; needsConnection?: true; error: string };

/**
 * What the browser's Google Picker needs: a short-lived access token for THIS person's Sheets
 * connection (theirs, else the agency's), the browser key and the project number. Only someone who
 * may import gets one.
 */
export async function pickerSession(db: Db, actor: Actor, deps: SheetsDeps | null): Promise<PickerSession> {
  if (!mayImport(actor)) return { ok: false, error: 'You cannot import here.' };
  if (!deps?.picker) return { ok: false, error: 'Google Sheets import is not set up on this server yet (GOOGLE_PICKER_API_KEY, GOOGLE_CLOUD_PROJECT_NUMBER).' };
  const c = await connection(db, actor);
  if ('needsConnection' in c) return { ok: false, needsConnection: true, error: c.needsConnection };
  try {
    const accessToken = await withAccessToken(db, deps.keys, actor, c.accountId, deps, async (t) => t);
    return { ok: true, accessToken, apiKey: deps.picker.apiKey, appId: deps.picker.appId };
  } catch (err) {
    const r = sheetsRefusal(err);
    if (r) return { ok: false, ...(err instanceof IntegrationError && err.code === 'expired' ? { needsConnection: true as const } : {}), error: r.message };
    throw err;
  }
}

function checkId(spreadsheetId: string): void {
  if (!FILE_ID.test(spreadsheetId)) throw new ImportError('invalid', 'That is not a Google Sheet.');
}

/** The picked file's title and tabs, for the person to choose one. Titles and row counts only. */
export async function sheetTabs(db: Db, actor: Actor, spreadsheetId: string, deps: SheetsDeps, api: SheetsApi = googleSheetsApi(deps.fetch)): Promise<{ title: string; tabs: SheetTab[] }> {
  if (!mayImport(actor)) throw new ImportError('forbidden', 'You cannot import here');
  checkId(spreadsheetId);
  const file = await withSheets(db, actor, deps, (t) => api.file(t, spreadsheetId));
  if (!file.tabs.length) throw new ImportError('invalid', 'That sheet has no tabs to import.');
  return file;
}

/** Read one tab now (network) — the table the import is made from. */
async function readTab(db: Db, actor: Actor, ref: { spreadsheetId: string; tab: string }, deps: SheetsDeps, api: SheetsApi): Promise<{ title: string; table: ImportTable }> {
  checkId(ref.spreadsheetId);
  const { file, cells } = await withSheets(db, actor, deps, async (t) => {
    const f = await api.file(t, ref.spreadsheetId);
    if (!f.tabs.some((x) => x.title === ref.tab)) throw new ImportError('not_found', `The tab “${ref.tab}” is not in that sheet any more.`);
    return { file: f, cells: await api.values(t, ref.spreadsheetId, ref.tab) };
  });
  try {
    return { title: file.title, table: tableFromCells(cells) };
  } catch (err) {
    if (err instanceof CsvError) throw new ImportError('invalid', err.message);
    throw err;
  }
}

/** Import a picked sheet's tab: read it now, then exactly the CSV import (map → check → import). */
export async function createImportFromSheet(
  db: Db,
  actor: Actor,
  input: { spreadsheetId: string; tab: string; mode?: ImportMode; kind?: ImportKind },
  deps: SheetsDeps,
  api: SheetsApi = googleSheetsApi(deps.fetch),
): Promise<CreatedImport> {
  const kind = input.kind ?? 'listings';
  // Asked before Google is: never a read of someone's sheet for an import they may not make.
  if (!mayCreateImport(actor, kind)) throw new ImportError('forbidden', kind === 'contacts' ? 'You cannot import contacts' : 'You cannot import listings');
  const tab = input.tab.trim().slice(0, 100);
  if (!tab) throw new ImportError('invalid', 'Choose a tab of the sheet.');
  const { title, table } = await readTab(db, actor, { spreadsheetId: input.spreadsheetId, tab }, deps, api);
  return createImportFromTable(db, actor, {
    fileName: `${title} — ${tab}`,
    table,
    ...(input.mode ? { mode: input.mode } : {}),
    source: 'sheet',
    sourceRef: { spreadsheetId: input.spreadsheetId, tab, title },
    kind,
  });
}

/** Re-import: the same file and tab read again, as a NEW import (its own check and report). */
export async function reimportSheet(db: Db, actor: Actor, importId: string, deps: SheetsDeps, api: SheetsApi = googleSheetsApi(deps.fetch)): Promise<CreatedImport> {
  const before = await getImport(db, actor, importId);
  if (before.source !== 'sheet' || !before.sheet) throw new ImportError('invalid', 'Only an import from a Google Sheet can be read again.');
  return createImportFromSheet(db, actor, { spreadsheetId: before.sheet.spreadsheetId, tab: before.sheet.tab, mode: before.mode, kind: before.kind }, deps, api);
}
