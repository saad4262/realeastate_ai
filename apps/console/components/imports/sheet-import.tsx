'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { importSheetAction, sheetPickerAction, sheetTabsAction } from '@/lib/import-actions';

/**
 * Import from Google Sheets by Google's own file picker (ADR 0029 amendment). The picker runs in
 * Google's frame; our connection holds only `drive.file`, so the one file picked is the only one
 * we can open. Then: choose a tab → the server reads it → the same screens as a CSV upload.
 */

type PickerDoc = Record<string, unknown>;
type PickerData = Record<string, unknown>;
/** The parts of google.picker we call (developers.google.com/workspace/drive/picker, checked 2026-10-13). */
type PickerBuilder = {
  addView(v: unknown): PickerBuilder;
  setOAuthToken(t: string): PickerBuilder;
  setDeveloperKey(k: string): PickerBuilder;
  setAppId(id: string): PickerBuilder;
  setCallback(fn: (d: PickerData) => void): PickerBuilder;
  setTitle(t: string): PickerBuilder;
  build(): { setVisible(v: boolean): void };
};
type PickerApi = {
  PickerBuilder: new () => PickerBuilder;
  ViewId: { SPREADSHEETS: unknown };
  Response: { ACTION: string; DOCUMENTS: string };
  Action: { PICKED: string; CANCEL: string };
  Document: { ID: string; NAME: string };
};
/** The window as Google's loader leaves it — read through this, so the Maps types of `google` are left alone. */
const w = () => window as unknown as { gapi?: { load(name: string, cb: () => void): void }; google?: { picker?: PickerApi } };

const API_SRC = 'https://apis.google.com/js/api.js';
let loading: Promise<PickerApi> | null = null;

/** Google's picker library, loaded once on first use (not on every page). */
function loadPicker(): Promise<PickerApi> {
  const loaded = w().google?.picker;
  if (loaded) return Promise.resolve(loaded);
  loading ??= new Promise<PickerApi>((resolve, reject) => {
    const ready = () =>
      w().gapi!.load('picker', () => {
        const p = w().google?.picker;
        if (p) resolve(p);
        else reject(new Error('picker'));
      });
    if (w().gapi) return ready();
    const s = document.createElement('script');
    s.src = API_SRC;
    s.async = true;
    s.onload = ready;
    s.onerror = () => reject(new Error('script'));
    document.head.appendChild(s);
  }).catch((err: unknown) => {
    loading = null;
    throw err;
  });
  return loading;
}

const btn: React.CSSProperties = { justifySelf: 'start', padding: '0.5rem 1rem', borderRadius: '0.5rem', border: 0, background: 'var(--sapphire)', color: '#fff', fontWeight: 600, cursor: 'pointer' };
const ghost: React.CSSProperties = { padding: '0.5rem 1rem', borderRadius: '0.5rem', border: '1px solid var(--border-default)', background: 'transparent', cursor: 'pointer' };

export function SheetImport({ base, mayPublish, integrationsHref, kind = 'listings' }: { base: string; mayPublish: boolean; integrationsHref: string; kind?: 'listings' | 'contacts' }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [needsConnection, setNeedsConnection] = useState(false);
  const [file, setFile] = useState<{ id: string; title: string; tabs: { title: string; rows: number }[] } | null>(null);
  const [tab, setTab] = useState('');
  const [mode, setMode] = useState<'live' | 'draft'>('live');
  const [pending, start] = useTransition();

  const pick = () => {
    setError(null);
    setNeedsConnection(false);
    start(async () => {
      const session = await sheetPickerAction();
      if (!session.ok) {
        setError(session.error);
        setNeedsConnection(Boolean('needsConnection' in session && session.needsConnection));
        return;
      }
      let api: PickerApi;
      try {
        api = await loadPicker();
      } catch {
        setError('Google’s file picker could not be loaded. Check your connection and try again.');
        return;
      }
      const picked = await new Promise<{ id: string; name: string } | null>((resolve) => {
        new api.PickerBuilder()
          .addView(api.ViewId.SPREADSHEETS)
          .setOAuthToken(session.accessToken)
          .setDeveloperKey(session.apiKey)
          // The Cloud project number: picking grants THIS app the file (drive.file).
          .setAppId(session.appId)
          .setTitle('Choose the Google Sheet to import')
          .setCallback((data: PickerData) => {
            const action = data[api.Response.ACTION];
            if (action === api.Action.PICKED) {
              const doc = (data[api.Response.DOCUMENTS] as PickerDoc[] | undefined)?.[0];
              resolve(doc ? { id: String(doc[api.Document.ID] ?? ''), name: String(doc[api.Document.NAME] ?? '') } : null);
            } else if (action === api.Action.CANCEL) resolve(null);
          })
          .build()
          .setVisible(true);
      });
      if (!picked?.id) return;
      const r = await sheetTabsAction(picked.id);
      if (!r.ok) return setError(r.error);
      setFile({ id: picked.id, title: r.title || picked.name, tabs: r.tabs });
      setTab(r.tabs[0]?.title ?? '');
    });
  };

  const read = () => {
    if (!file || !tab) return;
    setError(null);
    start(async () => {
      const r = await importSheetAction({ spreadsheetId: file.id, tab, mode, kind });
      if (!r.ok) return setError(r.error);
      if (r.sameFileAs) alert(`You imported this same sheet on ${new Date(r.sameFileAs).toLocaleDateString('en-AU')}. The check will show its rows as duplicates.`);
      router.push(`${base}/${r.id}`);
    });
  };

  return (
    <div style={{ display: 'grid', gap: '0.75rem', maxWidth: '32rem' }}>
      {!file ? (
        <button type="button" onClick={pick} disabled={pending} style={btn}>
          {pending ? 'Opening Google…' : 'Pick a Google Sheet'}
        </button>
      ) : (
        <>
          <p style={{ margin: 0 }}>
            <strong>{file.title}</strong>{' '}
            <button type="button" onClick={() => setFile(null)} disabled={pending} style={{ ...ghost, padding: '0.125rem 0.5rem', fontSize: '0.8125rem' }}>
              Pick another
            </button>
          </p>
          <label>
            Tab
            <select value={tab} onChange={(e) => setTab(e.target.value)} style={{ display: 'block', marginTop: '0.25rem' }}>
              {file.tabs.map((t) => (
                <option key={t.title} value={t.title}>
                  {t.title}
                </option>
              ))}
            </select>
          </label>
          {mayPublish ? (
            <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
              <legend>Imported listings should be</legend>
              <label style={{ marginRight: '1rem' }}>
                <input type="radio" name="sheet-mode" checked={mode === 'live'} onChange={() => setMode('live')} /> as in the sheet (live, under offer, sold…)
              </label>
              <label>
                <input type="radio" name="sheet-mode" checked={mode === 'draft'} onChange={() => setMode('draft')} /> drafts, for me to publish later
              </label>
            </fieldset>
          ) : null}
          <button type="button" onClick={read} disabled={pending || !tab} style={btn}>
            {pending ? 'Reading the sheet…' : 'Read this tab and match columns'}
          </button>
        </>
      )}
      {error ? (
        <p role="alert" style={{ color: 'var(--rose)', margin: 0 }}>
          {error} {needsConnection ? <Link href={integrationsHref}>Open Integrations</Link> : null}
        </p>
      ) : null}
      <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
        Google’s own picker opens. Only the sheet you pick can be read — nothing else in your Drive — and it is never changed.
      </p>
    </div>
  );
}
