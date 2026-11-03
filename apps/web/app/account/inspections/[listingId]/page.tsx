import type { Metadata } from 'next';
import Link from 'next/link';
import { consumerSkillBlocks, consumerSkillOffMessage } from '@repo/core/consumer-skills';
import { CHECKLISTS, loadNotebook, MAX_CAMERA_BYTES, MAX_CHECK_NOTE, MAX_NOTES, MAX_PHOTOS_PER_HOME, NotebookError, PHOTO_LONG_EDGE, type Notebook } from '@repo/core/inspections';
import { inspectionPhotosConfigured } from '@repo/core/inspections/photo-storage';
import { WebShell } from '../../../../components/web-shell';
import { InspectionSummary } from '../../../../components/inspection-summary';
import { ensureConsumerAccount } from '../../../../lib/account';
import { getWebDb } from '../../../../lib/db';
import { requireWebUser } from '../../../../lib/session';
import { DeleteNotebookButton } from '../delete-buttons';
import { NotebookForm } from './notebook-form';
import { Photos } from './photos';
import styles from '../../account.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Inspection notes', robots: { index: false, follow: false } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One home's notebook (ADR 0080, C6 decisions 6–8; mock docs/mocks/consumer-inspections.html#notes): the fixed
 * checklist, the buyer's notes and photos. Owner-only by `can()`; a new notebook needs a home the public can see,
 * an old one stays readable and deletable after the home comes off the market.
 */
export default async function NotebookPage({ params }: { params: Promise<{ listingId: string }> }) {
  const { listingId } = await params;
  await requireWebUser(`/account/inspections/${listingId}`);
  const session = await ensureConsumerAccount();
  if (!session) return null;
  const db = getWebDb();
  const actor = { userId: session.id };

  let book: Notebook | null = null;
  if (UUID.test(listingId)) {
    try {
      book = await loadNotebook(db, actor, listingId);
    } catch (err) {
      if (!(err instanceof NotebookError)) throw err;
    }
  }
  const block = (await consumerSkillBlocks(db, actor)).get('inspection_notes');

  return (
    <WebShell account={{ signedIn: true }}>
      <main className={styles.page}>
        <p className="mb-2 text-sm">
          <Link href="/account/inspections" className="text-ink-soft hover:text-ink">
            ← Inspection notes
          </Link>
        </p>
        {!book ? (
          <>
            <h1 className={styles.title}>Inspection notes</h1>
            <p className={`${styles.body} mt-1`}>That home is not available.</p>
          </>
        ) : (
          <>
            <h1 className={styles.title}>
              <Link href={`/listing/${book.home.listingId}`} className="hover:underline">
                {book.home.address}
              </Link>
            </h1>
            <p className="my-2 rounded-lg bg-success-soft px-3 py-2 text-sm text-success">🔒 Only you can see this. The agency can&rsquo;t — not even that you took notes.</p>
            {block ? <p className={`${styles.body} mb-3`}>{consumerSkillOffMessage('inspection_notes', block)} You can still read and delete these notes.</p> : null}

            <section className={styles.card}>
              <h2 className={styles.cardLabel}>Checklist · {book.home.kind === 'apartment' ? 'apartment' : 'house'}</h2>
              <NotebookForm
                listingId={book.home.listingId}
                items={[...CHECKLISTS[book.home.kind]]}
                initialChecks={book.checks}
                initialNotes={book.notes}
                maxNotes={MAX_NOTES}
                maxCheckNote={MAX_CHECK_NOTE}
                disabled={Boolean(block)}
              />
              {book.home.kind === 'apartment' ? (
                <p className="mt-3 text-xs text-ink-faint">
                  Strata records: see the{' '}
                  <Link href={`/listing/${book.home.listingId}#before-you-buy`} className="underline">
                    before-you-buy checklist
                  </Link>{' '}
                  for {book.home.state}.
                </p>
              ) : null}
            </section>

            {inspectionPhotosConfigured() ? (
              <section className={styles.card}>
                <h2 className={styles.cardLabel}>Photos</h2>
                <Photos listingId={book.home.listingId} photos={book.photos} max={MAX_PHOTOS_PER_HOME} maxCameraBytes={MAX_CAMERA_BYTES} longEdge={PHOTO_LONG_EDGE} disabled={Boolean(block)} />
              </section>
            ) : null}

            {!block && book.noteId ? (
              <section className={styles.card}>
                <h2 className={styles.cardLabel}>This home, summarised</h2>
                <InspectionSummary listingIds={[book.home.listingId]} label="Summarise my notes for this home" />
              </section>
            ) : null}

            {book.noteId ? <DeleteNotebookButton listingId={book.home.listingId} after="/account/inspections" /> : null}
          </>
        )}
      </main>
    </WebShell>
  );
}
