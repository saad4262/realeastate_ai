'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FIELD_LABELS, IMPORT_FIELDS, REQUIRED_FIELDS } from '@repo/core/imports/columns-client';
import type { ImportReportRow, ImportView } from '@repo/core/imports';
import {
  cancelImportAction,
  continueImportAction,
  getImportAction,
  setMappingAction,
  startDryRunAction,
  startImportAction,
} from '@/lib/import-actions';

const STATUS: Record<string, string> = {
  mapped: 'Match the columns, then check the file',
  validating: 'Checking every row…',
  validated: 'Checked — review the report, then import',
  importing: 'Importing…',
  done: 'Done',
  failed: 'Stopped',
  cancelled: 'Cancelled',
};

const box: React.CSSProperties = { border: '1px solid var(--border-default)', borderRadius: '0.5rem', background: 'var(--surface-card)', padding: '1rem', marginTop: '1rem' };
const btn: React.CSSProperties = { padding: '0.5rem 1rem', borderRadius: '0.5rem', border: 0, background: 'var(--sapphire)', color: '#fff', fontWeight: 600, cursor: 'pointer' };
const ghost: React.CSSProperties = { padding: '0.5rem 1rem', borderRadius: '0.5rem', border: '1px solid var(--border-default)', background: 'transparent', cursor: 'pointer' };

/**
 * One import (docs/adr/0029): match columns → check → report → import →
 * photos. While it runs, this page asks the server for one chunk after
 * another; closing it is fine — the cron tick carries on.
 */
export function ImportDetail({ id, listingsHref }: { id: string; listingsHref: string }) {
  const [view, setView] = useState<ImportView | null>(null);
  const [problems, setProblems] = useState<ImportReportRow[]>([]);
  const [mapping, setMapping] = useState<Record<string, number | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [update, setUpdate] = useState(false);
  const driving = useRef(false);

  const load = useCallback(async () => {
    const r = await getImportAction(id);
    if (!r.ok) return setError(r.error);
    setView(r.view);
    setProblems(r.problems);
    setMapping((m) => (Object.keys(m).length ? m : (r.view.mapping as Record<string, number | null>)));
  }, [id]);

  const drive = useCallback(async () => {
    if (driving.current) return;
    driving.current = true;
    try {
      for (;;) {
        const r = await continueImportAction(id);
        if (!r.ok) {
          setError(r.error);
          break;
        }
        await load();
        if (!['validating', 'importing'].includes(r.status)) break;
        if (r.busy) await new Promise((res) => setTimeout(res, 3000));
      }
    } finally {
      driving.current = false;
    }
  }, [id, load]);

  useEffect(() => {
    void load().then(() => undefined);
  }, [load]);
  const running = !!view && view.mayRun && ['validating', 'importing'].includes(view.status);
  useEffect(() => {
    if (running) void drive();
  }, [running, drive]);

  if (!view) return <p>{error ?? 'Loading…'}</p>;
  const c = view.counts;
  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    const r = await fn();
    if (!r.ok) setError(r.error ?? 'That did not work');
    await load();
  };

  return (
    <div style={{ padding: '1.5rem', maxWidth: '72rem' }}>
      <h1 style={{ margin: 0, font: '700 1.375rem/1.2 var(--font-display)' }}>{view.fileName}</h1>
      <p style={{ color: 'var(--text-secondary)' }}>
        {view.totalRows.toLocaleString('en-AU')} rows · {STATUS[view.status]} · imported as{' '}
        {view.mode === 'pending' ? 'waiting for approval' : view.mode === 'draft' ? 'drafts' : 'in the file (live, sold…)'}
      </p>
      {error ? <p role="alert" style={{ color: 'var(--rose)' }}>{error}</p> : null}

      {view.status === 'mapped' && view.mayRun ? (
        <section style={box}>
          <h2 style={{ marginTop: 0, fontSize: '1rem' }}>Match the columns</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>For each of our fields, pick the column in your file. Fields marked * are required.</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(16rem, 1fr))', gap: '0.5rem' }}>
            {IMPORT_FIELDS.map((f) => (
              <label key={f} style={{ display: 'grid', fontSize: '0.8125rem' }}>
                {FIELD_LABELS[f]}
                {REQUIRED_FIELDS.includes(f) ? ' *' : ''}
                <select value={mapping[f] ?? ''} onChange={(e) => setMapping({ ...mapping, [f]: e.target.value === '' ? null : Number(e.target.value) })}>
                  <option value="">— not in my file —</option>
                  {view.headers.map((h, i) => (
                    <option key={i} value={i}>
                      {h || `Column ${i + 1}`}
                      {view.sample[0]?.[i] ? ` (e.g. ${String(view.sample[0][i]).slice(0, 30)})` : ''}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div style={{ marginTop: '1rem', overflowX: 'auto' }}>
            <table style={{ fontSize: '0.75rem', borderCollapse: 'collapse' }}>
              <thead>
                <tr>{view.headers.map((h, i) => <th key={i} style={{ textAlign: 'left', padding: '0.25rem 0.5rem', borderBottom: '1px solid var(--border-default)' }}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {view.sample.slice(0, 20).map((r, i) => (
                  <tr key={i}>{view.headers.map((_, j) => <td key={j} style={{ padding: '0.25rem 0.5rem', whiteSpace: 'nowrap', maxWidth: '14rem', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r[j]}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" style={{ ...btn, marginTop: '1rem' }} onClick={() => act(async () => {
            const m = await setMappingAction(id, mapping);
            if (!m.ok) return m;
            return startDryRunAction(id);
          })}>
            Check every row (nothing is imported yet)
          </button>
        </section>
      ) : null}

      <section style={box}>
        <h2 style={{ marginTop: 0, fontSize: '1rem' }}>Rows</h2>
        <p style={{ margin: 0, fontSize: '0.875rem' }}>
          {c.pending ? `${c.pending} still to check · ` : ''}
          {c.valid} ready · {c.error} with problems · {c.duplicate} duplicates (skipped{view.updateDuplicates ? ', updated' : ''}) ·{' '}
          {c.imported} imported · {c.updated} updated · {c.failed} failed
          {c.photosDone + c.photosFailed + c.photosPending ? ` · photos: ${c.photosDone} in, ${c.photosFailed} failed, ${c.photosPending} to go` : ''}
        </p>
        {view.status === 'validated' && view.mayRun ? (
          <div style={{ marginTop: '0.75rem', display: 'grid', gap: '0.5rem', justifyItems: 'start' }}>
            {view.mayUpdateDuplicates && c.duplicate ? (
              <label style={{ fontSize: '0.875rem' }}>
                <input type="checkbox" checked={update} onChange={(e) => setUpdate(e.target.checked)} /> Update from file: rows that match one of your active listings update that listing instead of being skipped (owners and admins only)
              </label>
            ) : null}
            <button type="button" style={btn} disabled={!c.valid && !(update && c.duplicate)} onClick={() => act(() => startImportAction(id, update))}>
              Import {c.valid} {c.valid === 1 ? 'listing' : 'listings'}{update && c.duplicate ? ` and update ${c.duplicate}` : ''}
            </button>
          </div>
        ) : null}
        {view.status === 'done' ? (
          <p style={{ marginTop: '0.75rem' }}>
            Finished. <Link href={listingsHref}>Open your listings</Link>
            {view.mode === 'pending' ? ' — they are waiting for an owner or admin to approve them.' : '.'}
          </p>
        ) : null}
        <p style={{ marginTop: '0.75rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <a href={`/api/imports/${id}/report`}>Download the full row report (CSV)</a>
          {view.mayCancel && ['mapped', 'validating', 'validated', 'importing'].includes(view.status) ? (
            <button type="button" style={ghost} onClick={() => confirm('Cancel this import? Rows already imported stay.') && act(() => cancelImportAction(id))}>
              Cancel import
            </button>
          ) : null}
        </p>
      </section>

      {problems.length ? (
        <section style={box}>
          <h2 style={{ marginTop: 0, fontSize: '1rem' }}>Rows to look at ({problems.length}{problems.length === 500 ? '+' : ''})</h2>
          <table style={{ width: '100%', fontSize: '0.8125rem', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Row</th>
                <th style={{ textAlign: 'left' }}>Status</th>
                <th style={{ textAlign: 'left' }}>What to fix / note</th>
              </tr>
            </thead>
            <tbody>
              {problems.map((p) => (
                <tr key={p.rowNumber} style={{ borderTop: '1px solid var(--border-default)' }}>
                  <td style={{ padding: '0.25rem 0.5rem' }}>{p.rowNumber}</td>
                  <td style={{ padding: '0.25rem 0.5rem' }}>{p.status}</td>
                  <td style={{ padding: '0.25rem 0.5rem' }}>
                    {[...p.errors, ...p.warnings].map((e, i) => (
                      <div key={i}>
                        <strong>{e.column}</strong> {e.message}
                      </div>
                    ))}
                    {p.photos.filter((x) => x.status === 'failed').map((x, i) => (
                      <div key={`p${i}`}>Photo {x.url.slice(0, 60)} — {x.error}</div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}
