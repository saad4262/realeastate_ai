'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type ChangeEvent, type DragEvent } from 'react';
// The schema module, not the barrel: the barrel reaches the database client.
import {
  DOCUMENT_ACCEPT,
  DOCUMENT_KIND_LABELS,
  MAX_DOCUMENT_BYTES,
  documentMimeType,
  titleFromFilename,
  type DocumentKind,
  type DocumentTarget,
} from '@repo/core/documents/schema';
import { recordDocumentAction, signDocumentUploadAction } from '@/lib/document-actions';
import { putSignedUpload } from '@/lib/upload-file';
import styles from './documents.module.css';

/**
 * Drop files here (ADR 0053). Three steps per file, the photo uploader's order:
 *
 *   1. ask the server for permission and a signed URL   (Server Action)
 *   2. PUT the bytes straight to the private bucket      (this component)
 *   3. ask the server to record the row                  (Server Action — it HEADs the object first)
 *
 * The bytes never pass through this app, so a 20 MB contract does not have to fit in an action
 * body. `router.refresh()` afterwards: the list is server data, not a copy kept here.
 */

const MAX_FILES = 10;

type Row = { name: string; state: 'waiting' | 'uploading' | 'done' | 'failed'; error?: string };

export function DocumentUploader({
  target,
  kinds,
  defaultKind,
  allowPrivate,
  properties = [],
}: {
  target: DocumentTarget;
  kinds: readonly DocumentKind[];
  defaultKind: DocumentKind;
  /** Records only: the knowledge base is never private. */
  allowPrivate: boolean;
  /** On a contact: the addresses linked to them, to say which one a document is about. */
  properties?: { id: string; address: string }[];
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [over, setOver] = useState(false);
  const [kind, setKind] = useState<DocumentKind>(defaultKind);
  const [isPrivate, setPrivate] = useState(false);
  const [propertyId, setPropertyId] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);

  const setRow = (i: number, patch: Partial<Row>) => setRows((prev) => prev.map((r, k) => (k === i ? { ...r, ...patch } : r)));

  async function uploadOne(file: File, i: number): Promise<boolean> {
    const type = documentMimeType(file);
    if (!type) {
      setRow(i, { state: 'failed', error: 'Not a type we keep' });
      return false;
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      setRow(i, { state: 'failed', error: 'Larger than 25 MB' });
      return false;
    }
    setRow(i, { state: 'uploading' });
    const where: DocumentTarget = target.on === 'contact' && propertyId ? { ...target, propertyId } : target;
    try {
      const signed = await signDocumentUploadAction(where, { name: file.name, type, size: file.size });
      if (!signed.ok) throw new Error(signed.error);
      // The type the server signed for, so the bucket's own check and the key's extension agree.
      await putSignedUpload(signed, new File([file], file.name, { type: signed.contentType }));
      const saved = await recordDocumentAction(where, { key: signed.key, title: titleFromFilename(file.name), kind, isPrivate });
      if (!saved.ok) throw new Error(saved.error);
      setRow(i, { state: 'done' });
      return true;
    } catch (err) {
      setRow(i, { state: 'failed', error: err instanceof Error ? err.message : 'Upload failed' });
      return false;
    }
  }

  function take(list: FileList | null) {
    const files = [...(list ?? [])];
    if (!files.length || busy) return;
    setError(files.length > MAX_FILES ? `Up to ${MAX_FILES} files at a time — the first ${MAX_FILES} are being added.` : null);
    const batch = files.slice(0, MAX_FILES);
    setRows(batch.map((f) => ({ name: f.name, state: 'waiting' })));
    start(async () => {
      let any = false;
      for (const [i, file] of batch.entries()) any = (await uploadOne(file, i)) || any;
      if (any) router.refresh();
    });
  }

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    take(files);
    // Cleared so picking the same file again still fires a change.
    event.target.value = '';
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setOver(false);
    take(event.dataTransfer.files);
  }

  return (
    <div style={{ display: 'grid', gap: '0.75rem' }}>
      <div className={styles.options}>
        <label className={styles.field}>
          Kind
          <select className={styles.select} value={kind} onChange={(e) => setKind(e.target.value as DocumentKind)} disabled={busy}>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {DOCUMENT_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        {properties.length ? (
          <label className={styles.field}>
            About
            <select className={styles.select} value={propertyId} onChange={(e) => setPropertyId(e.target.value)} disabled={busy}>
              <option value="">No particular property</option>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.address}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {allowPrivate ? (
          <label className={styles.check} title="Only admins and you will see it">
            <input type="checkbox" checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} disabled={busy} />
            Private
          </label>
        ) : null}
      </div>

      <label
        className={`${styles.drop} ${over ? styles.dropActive : ''} ${busy ? styles.dropBusy : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!over) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <input type="file" className={styles.file} accept={DOCUMENT_ACCEPT} multiple disabled={busy} onChange={onPick} aria-label="Add documents" />
        <span className={styles.dropTitle}>{busy ? 'Uploading…' : 'Drop files here, or click to choose'}</span>
        <span className={styles.dropHint}>PDF, Word (.docx), photos (JPEG, PNG, WebP) or text — up to 25 MB each, {MAX_FILES} at a time.</span>
      </label>

      {error ? <p className={styles.error}>{error}</p> : null}
      {rows.length ? (
        <ul className={styles.progress} aria-live="polite">
          {rows.map((r, i) => (
            <li key={`${r.name}-${i}`}>
              <span>{r.name}</span>
              <span className={r.state === 'failed' ? styles.failNote : undefined}>
                {r.state === 'waiting' ? 'Waiting' : r.state === 'uploading' ? 'Uploading…' : r.state === 'done' ? 'Added — being read' : r.error}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
