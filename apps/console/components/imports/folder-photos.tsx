'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FolderReport, ImportReportRow, ImportView } from '@repo/core/imports';
import { imageDimensions, MAX_EDGE, prepareImage, putSignedUpload } from '@/lib/upload-file';
import {
  attachPhotoFolderAction,
  confirmImportPhotosAction,
  photoReportAction,
  signImportPhotosAction,
  waitingFolderPhotosAction,
} from '@/lib/import-actions';

/**
 * Photos from a folder on this computer (ADR 0102). The folder's paths and sizes go to the server, which
 * matches them to the import's listings; the files stay here, are shrunk, and go straight to Storage in
 * batches. The files live only in this tab: after a reload, dropping the same folder again carries on.
 */

const box: React.CSSProperties = { border: '1px solid var(--border-default)', borderRadius: '0.5rem', background: 'var(--surface-card)', padding: '1rem', marginTop: '1rem' };
const btn: React.CSSProperties = { padding: '0.5rem 1rem', borderRadius: '0.5rem', border: 0, background: 'var(--sapphire)', color: '#fff', fontWeight: 600, cursor: 'pointer' };
const ghost: React.CSSProperties = { padding: '0.5rem 1rem', borderRadius: '0.5rem', border: '1px solid var(--border-default)', background: 'transparent', cursor: 'pointer' };
const muted: React.CSSProperties = { color: 'var(--text-secondary)', fontSize: '0.8125rem' };

const BATCH = 50;
const PARALLEL = 4;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Only what could be a photo is sent to be matched; the server decides the rest. */
const PHOTO_NAME = /\.(jpe?g|png|webp|avif|heic|heif)$/i;

type Picked = { path: string; file: File };

/** Run `fn` over `items`, `n` at a time, keeping their order. */
async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/** Every file under the dropped folders, with its path from the dropped folder down (as the folder button gives it). */
async function filesFromDrop(items: DataTransferItemList): Promise<Picked[]> {
  const out: Picked[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ path: entry.fullPath.replace(/^\/+/, ''), file });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries answers in batches (100 in Chrome) until it answers with none.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e);
      }
    }
  };
  const roots = [...items].map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => Boolean(e));
  for (const r of roots) await walk(r);
  return out;
}

const fmtMb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
function fmtTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} sec`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <details style={{ marginTop: '0.375rem', fontSize: '0.8125rem' }}>
      <summary style={{ cursor: 'pointer' }}>
        {title} ({items.length.toLocaleString('en-AU')})
      </summary>
      <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.25rem', maxHeight: '12rem', overflowY: 'auto' }}>
        {items.slice(0, 300).map((t, i) => (
          <li key={i}>{t}</li>
        ))}
        {items.length > 300 ? <li>… and {items.length - 300} more</li> : null}
      </ul>
    </details>
  );
}

type Progress = { done: number; failed: number; total: number; bytes: number; startedAt: number };

export function FolderPhotos({ id, view, onChanged }: { id: string; view: ImportView; onChanged: () => Promise<void> }) {
  const picked = useRef(new Map<string, File>());
  const [pickedCount, setPickedCount] = useState(0);
  const [report, setReport] = useState<FolderReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [running, setRunning] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const paused = useRef(false);
  const autoStarted = useRef(false);
  const c = view.counts;
  // Photos can go once every listing of the file is in (link photos may still be fetching).
  const listingsIn = view.status === 'done' || (view.status === 'importing' && c.valid === 0);

  const upload = useCallback(
    async (retryFailed: boolean) => {
      setError(null);
      paused.current = false;
      setRunning(true);
      try {
        const w = await waitingFolderPhotosAction(id);
        if (!w.ok) return setError(w.error);
        const todo = w.photos.filter((p) => (p.status === 'local' || retryFailed) && picked.current.has(p.path));
        const prog: Progress = { done: 0, failed: 0, total: todo.length, bytes: 0, startedAt: Date.now() };
        setProgress({ ...prog });
        for (let i = 0; i < todo.length && !paused.current; i += BATCH) {
          const batch = todo.slice(i, i + BATCH);
          // Shrunk and without EXIF, as the listing page's own uploader does.
          const files = await pool(batch, PARALLEL, (p) => prepareImage(picked.current.get(p.path)!, p.kind === 'floorplan' ? MAX_EDGE.floorplan : MAX_EDGE.listingPhoto));
          const failed: { rowId: string; path: string; error: string }[] = [];
          const toSign = batch.flatMap((p, k) => {
            if (files[k]!.size > MAX_UPLOAD_BYTES) {
              failed.push({ rowId: p.rowId, path: p.path, error: 'Still larger than 10 MB after shrinking' });
              return [];
            }
            return [{ rowId: p.rowId, path: p.path, type: files[k]!.type || 'image/jpeg', file: files[k]! }];
          });
          const signed = toSign.length ? await signImportPhotosAction(id, toSign.map(({ rowId, path, type }) => ({ rowId, path, type }))) : { ok: true as const, signed: [] };
          if (!signed.ok) return setError(signed.error);
          const fileOf = new Map(toSign.map((t) => [`${t.rowId}|${t.path}`, t.file]));
          const uploaded: { rowId: string; path: string; key: string; width?: number; height?: number }[] = [];
          await pool(signed.signed, PARALLEL, async (s) => {
            if ('error' in s) {
              if (s.error !== 'Already uploaded') failed.push({ rowId: s.rowId, path: s.path, error: s.error });
              return;
            }
            const file = fileOf.get(`${s.rowId}|${s.path}`)!;
            try {
              await putSignedUpload(s, file);
              uploaded.push({ rowId: s.rowId, path: s.path, key: s.key, ...(await imageDimensions(file)) });
              prog.bytes += file.size;
            } catch (err) {
              failed.push({ rowId: s.rowId, path: s.path, error: (err instanceof Error ? err.message : 'Upload failed').slice(0, 200) });
            }
          });
          // One batch at a time, in order, so each listing's photos keep the folder's order.
          const r = await confirmImportPhotosAction(id, { uploaded, failed });
          if (!r.ok) return setError(r.error);
          prog.done += r.done;
          prog.failed += r.failed;
          setProgress({ ...prog });
          await onChanged();
        }
      } finally {
        setRunning(false);
        await onChanged();
      }
    },
    [id, onChanged],
  );

  const take = async (list: Picked[]) => {
    setError(null);
    const photos = list.filter((p) => PHOTO_NAME.test(p.path) && !p.path.split('/').some((s) => s.startsWith('.')));
    if (!photos.length) return setError('No photos found in that folder (JPEG, PNG, WebP or AVIF).');
    for (const p of photos) picked.current.set(p.path, p.file);
    setPickedCount(picked.current.size);
    const r = await attachPhotoFolderAction(id, photos.map((p) => ({ path: p.path, size: p.file.size })));
    if (!r.ok) return setError(r.error);
    setReport(r.report);
    autoStarted.current = false;
    await onChanged();
  };

  // Start by itself once the listings are in and this tab holds files still to send.
  useEffect(() => {
    if (listingsIn && pickedCount && c.photosLocal > 0 && !running && !autoStarted.current) {
      autoStarted.current = true;
      void upload(false);
    }
  }, [listingsIn, pickedCount, c.photosLocal, running, upload]);

  const elapsed = progress ? (Date.now() - progress.startedAt) / 1000 : 0;
  const finished = progress ? progress.done + progress.failed : 0;
  const eta = progress && finished > 0 && progress.total > finished ? ((progress.total - finished) / finished) * elapsed : null;
  const pct = progress && progress.total ? Math.round((finished / progress.total) * 100) : 0;

  return (
    <section style={box} aria-labelledby="folder-photos-title">
      <h2 id="folder-photos-title" style={{ marginTop: 0, fontSize: '1rem' }}>
        Add photos from a folder on this computer
      </h2>
      <p style={muted}>
        Choose the folder that holds your property folders, as it is. A folder named by a property&rsquo;s address (&ldquo;14 Henry Street
        Pakenham&rdquo;) or by your listing id, at any depth, goes to that listing. Photos are in name order, and the first is the main one. A file or
        folder named &ldquo;floor plan&rdquo; becomes a floorplan. A listing with photo links in your file keeps those.
      </p>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={async (e) => {
          e.preventDefault();
          setDragOver(false);
          setReading(true);
          try {
            await take(await filesFromDrop(e.dataTransfer.items));
          } catch {
            setError('This browser could not read that folder. Use “Choose folder” instead.');
          } finally {
            setReading(false);
          }
        }}
        style={{
          border: `2px dashed ${dragOver ? 'var(--sapphire)' : 'var(--border-default)'}`,
          borderRadius: '0.5rem',
          padding: '1.25rem',
          textAlign: 'center',
          background: dragOver ? 'color-mix(in srgb, var(--sapphire) 8%, transparent)' : 'transparent',
        }}
      >
        <p style={{ margin: '0 0 0.5rem' }}>{reading ? 'Reading the folder…' : 'Drag the folder here, or'}</p>
        <label style={{ ...btn, display: 'inline-block' }}>
          Choose folder
          <input
            type="file"
            multiple
            {...({ webkitdirectory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
            disabled={running || reading}
            style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
            onChange={async (e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              setReading(true);
              try {
                await take(files.map((file) => ({ path: file.webkitRelativePath || file.name, file })));
              } finally {
                setReading(false);
              }
            }}
          />
        </label>
      </div>
      {error ? (
        <p role="alert" style={{ color: 'var(--rose)' }}>
          {error}
        </p>
      ) : null}

      {report ? (
        <div style={{ marginTop: '0.75rem' }} role="status">
          <p style={{ margin: 0, fontWeight: 600 }}>
            {report.listings.toLocaleString('en-AU')} {report.listings === 1 ? 'listing' : 'listings'} matched ·{' '}
            {report.photos.toLocaleString('en-AU')} new {report.photos === 1 ? 'photo' : 'photos'}
            {report.withoutPhotos.length ? ` · ${report.withoutPhotos.length.toLocaleString('en-AU')} ${report.withoutPhotos.length === 1 ? 'listing has' : 'listings have'} no photos yet` : ''}
          </p>
          <List title="Folders that match no listing" items={report.unmatchedFolders} />
          <List title="Folders that match more than one listing (not used)" items={report.ambiguous.map((a) => `${a.folder}: rows ${a.rows.join(', ')}`)} />
          <List title="Photos not used" items={report.skipped.map((s) => `${s.path}: ${s.reason}`)} />
          <List title="Listings that keep the photo links in your file" items={report.linksWin.map((n) => `Row ${n}`)} />
          <List title="Listings with no photos" items={report.withoutPhotos.map((n) => `Row ${n}`)} />
          {!listingsIn && report.photos ? <p style={muted}>Nothing is uploaded yet. The photos go up when you import.</p> : null}
        </div>
      ) : null}

      {progress && progress.total ? (
        <div style={{ marginTop: '0.75rem' }} role="status" aria-live="polite">
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.875rem', fontWeight: 600 }}>
            <span>{running ? 'Uploading photos…' : finished >= progress.total ? 'Photos uploaded' : 'Upload paused'}</span>
            <span>{pct}%</span>
          </div>
          <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} style={{ height: '0.625rem', borderRadius: '999px', background: 'var(--border-default)', overflow: 'hidden', marginTop: '0.375rem' }}>
            <div style={{ width: `${Math.max(pct, 3)}%`, height: '100%', background: 'var(--sapphire)', transition: 'width 0.4s ease' }} />
          </div>
          <p style={{ ...muted, margin: '0.375rem 0 0' }}>
            {progress.done.toLocaleString('en-AU')} of {progress.total.toLocaleString('en-AU')} in
            {progress.failed ? ` · ${progress.failed} failed` : ''} · {fmtMb(progress.bytes)} sent in {fmtTime(elapsed)}
            {eta !== null && running ? ` · about ${fmtTime(eta)} left` : ''}
          </p>
          {running ? <p style={{ ...muted, margin: '0.25rem 0 0' }}>Keep this tab open: the photos are on this computer, so only this tab can send them.</p> : null}
        </div>
      ) : null}

      <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        {running ? (
          <button type="button" style={ghost} onClick={() => (paused.current = true)}>
            Pause
          </button>
        ) : null}
        {!running && listingsIn && pickedCount > 0 && c.photosLocal > 0 && progress ? (
          <button type="button" style={btn} onClick={() => void upload(false)}>
            Carry on uploading ({c.photosLocal.toLocaleString('en-AU')} left)
          </button>
        ) : null}
        {!running && listingsIn && pickedCount > 0 && c.listingsWithFailedPhotos > 0 ? (
          <button type="button" style={ghost} onClick={() => void upload(true)}>
            Try the failed photos again
          </button>
        ) : null}
      </div>
      {!running && listingsIn && c.photosLocal > 0 && pickedCount === 0 ? (
        <p role="note" style={{ marginTop: '0.75rem', padding: '0.5rem 0.75rem', borderRadius: '0.5rem', background: 'var(--surface-subtle, rgba(127,127,127,0.08))' }}>
          {c.photosLocal.toLocaleString('en-AU')} {c.photosLocal === 1 ? 'photo is' : 'photos are'} still on your computer. Drop or choose the same folder to
          carry on: photos already in are not sent again.
        </p>
      ) : null}
    </section>
  );
}

const summaryText = (r: ImportReportRow) => {
  const s = r.photoSummary;
  if (!s.total) return 'No photos';
  return [`${s.done} in`, s.waiting ? `${s.waiting} waiting` : '', s.failed ? `${s.failed} failed` : ''].filter(Boolean).join(' · ');
};

/** What every listing got (ADR 0102): from the file's links, a folder, or nothing. */
export function PhotoReport({ id, view }: { id: string; view: ImportView }) {
  const [onlyMissing, setOnlyMissing] = useState(true);
  const [rows, setRows] = useState<ImportReportRow[] | null>(null);
  const c = view.counts;
  const countsKey = `${c.photosDone}|${c.photosFailed}|${c.photosLocal}|${c.photosPending}|${c.imported}|${view.status}`;

  useEffect(() => {
    let live = true;
    void photoReportAction(id, onlyMissing).then((r) => {
      if (live && r.ok) setRows(r.rows.filter((x) => ['valid', 'imported', 'updated'].includes(x.status)));
    });
    return () => {
      live = false;
    };
  }, [id, onlyMissing, countsKey]);

  return (
    <section style={box} aria-labelledby="photo-report-title">
      <h2 id="photo-report-title" style={{ marginTop: 0, fontSize: '1rem' }}>
        Photos by listing
      </h2>
      <p style={{ margin: 0, fontSize: '0.875rem' }}>
        {c.listingsWithPhotos.toLocaleString('en-AU')} with photos · {c.listingsWithoutPhotos.toLocaleString('en-AU')} without ·{' '}
        {c.listingsWithFailedPhotos.toLocaleString('en-AU')} with a failed photo
        {c.photosDone + c.photosPending + c.photosLocal + c.photosFailed
          ? ` · photos: ${c.photosDone.toLocaleString('en-AU')} in, ${(c.photosPending + c.photosLocal).toLocaleString('en-AU')} waiting, ${c.photosFailed.toLocaleString('en-AU')} failed`
          : ''}
      </p>
      <label style={{ display: 'block', marginTop: '0.5rem', fontSize: '0.875rem' }}>
        <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} /> Only listings without photos, or with a failed one
      </label>
      {rows === null ? (
        <p style={muted}>Loading…</p>
      ) : rows.length ? (
        <div style={{ overflowX: 'auto', marginTop: '0.5rem' }}>
          <table style={{ width: '100%', fontSize: '0.8125rem', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Row</th>
                <th style={{ textAlign: 'left' }}>Listing</th>
                <th style={{ textAlign: 'left' }}>From</th>
                <th style={{ textAlign: 'left' }}>Photos</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.rowNumber} style={{ borderTop: '1px solid var(--border-default)' }}>
                  <td style={{ padding: '0.25rem 0.5rem' }}>{r.rowNumber}</td>
                  <td style={{ padding: '0.25rem 0.5rem' }}>{r.address ?? '—'}</td>
                  <td style={{ padding: '0.25rem 0.5rem' }}>{r.photoSummary.source === 'links' ? 'Links in your file' : r.photoSummary.source === 'folder' ? 'Your folder' : '—'}</td>
                  <td style={{ padding: '0.25rem 0.5rem' }}>
                    {summaryText(r)}
                    {r.photos
                      .filter((p) => p.status === 'failed')
                      .slice(0, 5)
                      .map((p, i) => (
                        <div key={i} style={muted}>
                          {(p.path ?? p.url ?? '').split('/').slice(-2).join('/')}: {p.error}
                        </div>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 500 ? <p style={muted}>The first 500. Download the full row report for every listing.</p> : null}
        </div>
      ) : (
        <p style={muted}>{onlyMissing ? 'Every listing has its photos.' : 'No listings yet.'}</p>
      )}
    </section>
  );
}
