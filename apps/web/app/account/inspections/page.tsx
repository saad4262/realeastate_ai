import type { Metadata } from 'next';
import Link from 'next/link';
import { consumerSkillBlocks, consumerSkillOffMessage } from '@repo/core/consumer-skills';
import { listNotebooks, MAX_NOTEBOOKS } from '@repo/core/inspections';
import { WebShell } from '../../../components/web-shell';
import { InspectionSummary } from '../../../components/inspection-summary';
import { ensureConsumerAccount } from '../../../lib/account';
import { getWebDb } from '../../../lib/db';
import { requireWebUser } from '../../../lib/session';
import { DeleteNotebookButton } from './delete-buttons';
import styles from '../account.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Inspection notes', robots: { index: false, follow: false } };

const day = (d: Date) => d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Sydney' });

/**
 * Inspection Assistant (ADR 0080, C6; mock docs/mocks/consumer-inspections.html#summary): the buyer's notebooks, one
 * per home, and the summary on a button. Only they can see this — no agency, not even that a note exists. Reading and
 * deleting always work; writing and the summary need the skill on.
 */
export default async function InspectionNotesPage() {
  await requireWebUser('/account/inspections');
  const session = await ensureConsumerAccount();
  if (!session) return null;
  const db = getWebDb();
  const actor = { userId: session.id };
  const [books, blocks] = await Promise.all([listNotebooks(db, actor), consumerSkillBlocks(db, actor)]);
  const block = blocks.get('inspection_notes');

  return (
    <WebShell account={{ signedIn: true }}>
      <main className={styles.page}>
        <p className="mb-2 text-sm">
          <Link href="/account" className="text-ink-soft hover:text-ink">
            ← Your account
          </Link>
        </p>
        <h1 className={styles.title}>Inspection notes</h1>
        <p className={`${styles.body} mt-1`}>
          {block ? consumerSkillOffMessage('inspection_notes', block) : 'Your checklist, notes and photos from each open home. Only you can see them — the agency can’t, not even that you took notes.'}
        </p>
        <p className="mb-3 text-xs text-ink-faint">
          {books.length} of {MAX_NOTEBOOKS} homes.
        </p>

        {books.length === 0 ? (
          <section className={styles.card}>
            <p className={styles.body}>
              On a listing, under its inspection times, choose “Take private notes at the inspection”. Or open a home from your{' '}
              <Link href="/inspections" className="underline">
                inspection plan
              </Link>
              .
            </p>
          </section>
        ) : (
          <>
            {!block ? (
              <section className={styles.card}>
                <h2 className={styles.cardLabel}>Your notes, summarised</h2>
                <InspectionSummary label="Summarise my latest inspections" />
              </section>
            ) : null}
            {books.map((b) => (
              <section key={b.listingId} className={styles.card}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="text-base font-semibold text-ink">
                      <Link href={`/account/inspections/${b.listingId}`} className="hover:underline">
                        {b.address}
                      </Link>
                    </h2>
                    <p className="text-xs text-ink-faint">
                      {b.issues} {b.issues === 1 ? 'issue' : 'issues'} marked · {b.marked} checked · {b.photos} {b.photos === 1 ? 'photo' : 'photos'}
                      {b.hasNotes ? ' · notes' : ''} · last changed {day(b.updatedAt)}
                    </p>
                  </div>
                  <DeleteNotebookButton listingId={b.listingId} />
                </div>
              </section>
            ))}
            <DeleteNotebookButton all />
          </>
        )}
      </main>
    </WebShell>
  );
}
