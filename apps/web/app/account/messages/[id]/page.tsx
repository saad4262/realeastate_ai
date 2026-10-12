import type { Metadata } from 'next';
import Link from 'next/link';
import { LocalTime } from '@repo/ui';
import { getCustomerThread, MailError, type CustomerThreadView } from '@repo/core/mail';
import { WebShell } from '../../../../components/web-shell';
import { ensureConsumerAccount } from '../../../../lib/account';
import { getWebDb } from '../../../../lib/db';
import { requireWebUser } from '../../../../lib/session';
import { MailSync, MarkSeen, ReplyBox } from '../islands';
import styles from '../messages.module.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Conversation',
  robots: { index: false, follow: false },
};

/**
 * One conversation with an agency, read-only (docs/adr/0016).
 *
 * They can reply here, or from their mail app: the agency's messages carry a
 * Reply-To that brings an email answer back into this same conversation. New
 * mail is pulled while the page is open (MailSync). A thread that is not theirs
 * is "not found" — the same words as one that does not exist.
 */
export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireWebUser(`/account/messages/${id}`);
  const session = await ensureConsumerAccount();
  if (!session) return null;

  let view: CustomerThreadView | null = null;
  let error: string | null = null;
  try {
    view = await getCustomerThread(getWebDb(), { userId: session.id, email: session.email ?? '' }, id);
  } catch (err) {
    error = err instanceof MailError ? err.message : 'Could not open that conversation';
  }

  return (
    <WebShell account={{ signedIn: true }}>
      <main className={styles.page}>
        <Link href="/account/messages" className={styles.back}>
          ← All messages
        </Link>

        {!view ? (
          <p className={styles.alert} role="alert">
            {error}
          </p>
        ) : (
          <>
            <MarkSeen threadId={view.id} />
            <h1 className={styles.title}>{view.subject}</h1>
            <p className={styles.sub}>With {view.agencyName}</p>

            <div className={styles.thread}>
              {view.opening ? (
                <article className={`${styles.msg} ${styles.mine}`}>
                  <div className={styles.meta}>
                    <span className={styles.from}>You</span>
                    <time dateTime={view.opening.createdAt.toISOString()}>
                      <LocalTime iso={view.opening.createdAt.toISOString()} />
                    </time>
                  </div>
                  <div className={styles.bubble}>{view.opening.text}</div>
                </article>
              ) : null}

              {view.messages.map((m) => (
                <article key={m.id} className={`${styles.msg} ${m.byYou ? styles.mine : styles.theirs}`}>
                  <div className={styles.meta}>
                    <span className={styles.from}>{m.from}</span>
                    <time dateTime={m.createdAt.toISOString()}><LocalTime iso={m.createdAt.toISOString()} /></time>
                    {m.sentVia ? <span>{m.sentVia}</span> : null}
                  </div>
                  <div className={styles.bubble}>{m.text}</div>
                </article>
              ))}
            </div>

            {view.messages.some((m) => !m.byYou) ? null : (
              <p className={styles.hint}>
                {view.agencyName} has not replied yet. Their reply will show up here and in your email.
              </p>
            )}
            <ReplyBox threadId={view.id} agencyName={view.agencyName} />
            <MailSync />
          </>
        )}
      </main>
    </WebShell>
  );
}
