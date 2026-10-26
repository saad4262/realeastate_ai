import { LocalTime } from '@repo/ui';
import { DOCUMENT_KIND_LABELS, DOCUMENT_MIME_TYPES, type DocumentKind, type DocumentTarget } from '@repo/core/documents/schema';
import type { DocumentView } from '@repo/core/documents';
import { DocumentUploader } from './document-uploader';
import { DocumentRowActions, RefreshWhileReading } from './document-islands';
import styles from './documents.module.css';

/**
 * A list of documents with its upload box (ADR 0053) — the contact's Documents tab, a listing's
 * documents and the knowledge base all draw this. A Server Component: the list arrived already
 * narrowed by the visibility rule in packages/core, every control is drawn from a `may…` flag
 * can() set, and the islands are the only client code.
 *
 * A title opens the file through /api/documents/[id], which asks the same rule again and hands
 * out a storage link that works for a minute — there is no public URL to a document.
 */

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function StatusChip({ d }: { d: DocumentView }) {
  if (d.status === 'ready') {
    const how = d.extractedVia === 'vision' ? ' (read from the scan)' : '';
    return <span className={styles.statusReady} title={`The assistant can search this${how}`}>Ready</span>;
  }
  if (d.status === 'failed') return <span className={styles.statusFailed}>Could not be read</span>;
  return <span className={styles.statusWorking}>Reading…</span>;
}

export function DocumentsPanel({
  heading,
  target,
  documents,
  mayUpload,
  kinds,
  defaultKind,
  allowPrivate,
  properties,
  storageReady,
  emptyTitle,
  emptyHint,
  cannotUploadNote,
}: {
  heading: string;
  target: DocumentTarget;
  documents: DocumentView[];
  mayUpload: boolean;
  kinds: readonly DocumentKind[];
  defaultKind: DocumentKind;
  allowPrivate: boolean;
  properties?: { id: string; address: string }[];
  /** Storage is configured on this server; without it the upload box says so instead of failing. */
  storageReady: boolean;
  emptyTitle: string;
  emptyHint: string;
  cannotUploadNote?: string;
}) {
  const reading = documents.some((d) => d.status === 'pending' || d.status === 'extracting');
  return (
    <section className={styles.card} aria-label={heading}>
      <RefreshWhileReading active={reading} />
      {mayUpload ? (
        <div className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Add documents</h2>
            <span className={styles.note}>The assistant reads each one within a few minutes.</span>
          </div>
          {storageReady ? (
            <DocumentUploader target={target} kinds={kinds} defaultKind={defaultKind} allowPrivate={allowPrivate} properties={properties ?? []} />
          ) : (
            <p className={styles.note}>Document storage is not set up on this server yet (SUPABASE_SERVICE_ROLE_KEY and the documents bucket — see DEPLOY.md).</p>
          )}
        </div>
      ) : cannotUploadNote ? (
        <div className={styles.section}>
          <p className={styles.note}>{cannotUploadNote}</p>
        </div>
      ) : null}

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>{heading}</h2>
          {documents.length ? <span className={styles.note}>{documents.length === 100 ? 'The latest 100' : `${documents.length}`}</span> : null}
        </div>
        {documents.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>{emptyTitle}</p>
            <p className={styles.note}>{emptyHint}</p>
          </div>
        ) : (
          <ul className={styles.list}>
            {documents.map((d) => (
              <li key={d.id} className={styles.item}>
                <span className={styles.icon} aria-hidden>
                  {DOCUMENT_MIME_TYPES[d.mimeType] ?? 'file'}
                </span>
                <div className={styles.body}>
                  {/* A route, not a page: it redirects to the file. Plain <a>, so the browser downloads rather than navigates the app. */}
                  <a href={`/api/documents/${d.id}`} className={styles.title} target="_blank" rel="noopener">
                    {d.title}
                  </a>
                  <span className={styles.chips}>
                    <span className={styles.chip}>{DOCUMENT_KIND_LABELS[d.kind] ?? d.kind}</span>
                    <StatusChip d={d} />
                    {d.isPrivate ? <span className={styles.chip} title="Only admins and the person who added it">Private</span> : null}
                    {d.fromEmail ? <span className={styles.chip} title="Arrived as an email attachment">From email</span> : null}
                  </span>
                  <span className={styles.meta}>
                    {d.fromEmail ? 'Email attachment' : d.uploaderName ? `Added by ${d.uploaderName}` : 'Added'} · <LocalTime iso={d.createdAt.toISOString()} style="short" /> · {size(d.sizeBytes)}
                    {d.status === 'ready' && d.pageCount ? ` · ${d.pageCount} ${d.extractedVia === 'docx' || d.extractedVia === 'plain' ? (d.pageCount === 1 ? 'section' : 'sections') : d.pageCount === 1 ? 'page' : 'pages'}` : ''}
                  </span>
                  {d.error ? <span className={d.status === 'failed' ? styles.failNote : styles.waitNote}>{d.error}</span> : null}
                </div>
                <DocumentRowActions id={d.id} title={d.title} mayDelete={d.mayDelete} failed={d.status === 'failed'} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
