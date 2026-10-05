import type { Metadata } from 'next';
import Link from 'next/link';
import { WebShell } from '../../../../components/web-shell';
import { requireWebUser } from '../../../../lib/session';
import { confirmVerificationAction } from '../actions';
import styles from '../messages.module.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Confirm your email',
  robots: { index: false, follow: false },
};

/**
 * Where the emailed link lands (docs/adr/0016).
 *
 * Nothing is recorded by opening it. Mail providers and link scanners fetch
 * links in incoming mail on their own, so a GET that confirmed would confirm
 * for them; the confirmation is the button, a POST, made by the signed-in
 * account the token names. Reads no database itself.
 */
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  const token = one(params.t);
  const rawThread = one(params.thread);
  const thread = /^[0-9a-f-]{36}$/i.test(rawThread) ? rawThread : '';
  const user = await requireWebUser(
    `/account/messages/verify?t=${encodeURIComponent(token)}${thread ? `&thread=${thread}` : ''}`,
  );

  return (
    <WebShell account={{ signedIn: true }}>
      <main className={styles.page}>
        <Link href="/account/messages" className={styles.back}>
          ← Messages
        </Link>
        <h1 className={styles.title}>Confirm your email</h1>
        <p className={styles.sub}>
          One click, and your conversations with agencies sent to <strong>{user.email}</strong> show
          up on this site — and you can reply from here.
        </p>
        <form action={confirmVerificationAction}>
          <input type="hidden" name="t" value={token} />
          <input type="hidden" name="thread" value={thread} />
          <button type="submit" className={styles.button}>
            Confirm and show my messages
          </button>
        </form>
      </main>
    </WebShell>
  );
}
