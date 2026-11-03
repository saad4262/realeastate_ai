import type { Metadata } from 'next';
import Link from 'next/link';
import { consumerSkillBlocks } from '@repo/core/consumer-skills';
import { listWatches, MAX_WATCHES, type WatchView } from '@repo/core/watch';
import { WebShell } from '../../../components/web-shell';
import { ensureConsumerAccount } from '../../../lib/account';
import { getWebDb } from '../../../lib/db';
import { requireWebUser } from '../../../lib/session';
import { UnwatchButton } from './unwatch-button';
import styles from '../account.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Watching', robots: { index: false, follow: false } };

const STANDING: Record<WatchView['standing'], string> = {
  none: 'Not for sale',
  for_sale: 'For sale',
  for_rent: 'For rent',
  under_offer: 'Under offer',
  sold: 'Sold',
  leased: 'Leased',
  not_advertised: 'Not advertised',
};

const day = (d: Date) => d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Sydney' });

/**
 * Watching (ADR 0080, C4; mock docs/mocks/consumer-profile-watch.html#watch): every address the buyer follows,
 * its standing now and everything reported about it. Stopping is always allowed, switch or not.
 */
export default async function WatchingPage() {
  await requireWebUser('/account/watching');
  const session = await ensureConsumerAccount();
  if (!session) return null;
  const db = getWebDb();
  const actor = { userId: session.id };
  const [watches, blocks] = await Promise.all([listWatches(db, actor), consumerSkillBlocks(db, actor)]);
  const monitorOn = !blocks.has('property_monitor');

  return (
    <WebShell account={{ signedIn: true }}>
      <main className={styles.page}>
        <p className="mb-2 text-sm">
          <Link href="/account" className="text-ink-soft hover:text-ink">
            ← Your account
          </Link>
        </p>
        <h1 className={styles.title}>Watching</h1>
        <p className={`${styles.body} mt-1`}>
          Addresses you follow. {monitorOn ? 'We email you once a day, at 8 am, when something changes.' : 'Property Monitor is off: nothing is checked or emailed.'}{' '}
          <Link href="/account/skills" className="underline">
            {monitorOn ? 'Manage in Skills' : 'Turn it on in Skills'}
          </Link>
        </p>
        <p className="mb-3 text-xs text-ink-faint">
          {watches.length} of {MAX_WATCHES} addresses. Only you can see this.
        </p>

        {watches.length === 0 ? (
          <section className={styles.card}>
            <p className={styles.body}>Press “Watch this address” on a listing — or on a home that is not for sale — to follow it here.</p>
          </section>
        ) : (
          watches.map((w) => (
            <section key={w.propertyId} className={styles.card}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-ink">
                    <Link href={w.listingId ? `/listing/${w.listingId}` : `/property/${w.propertyId}`} className="hover:underline">
                      {w.address}
                    </Link>{' '}
                    <span className="ml-1 rounded-full bg-sunken px-2 py-0.5 align-middle text-[11px] font-bold uppercase tracking-wide text-ink-soft">{STANDING[w.standing]}</span>
                  </h2>
                  <p className="text-xs text-ink-faint">Watching since {day(w.since)}</p>
                </div>
                <UnwatchButton propertyId={w.propertyId} />
              </div>
              <ul className="m-0 mt-2 list-none p-0">
                {w.events.length ? (
                  w.events.map((e, i) => (
                    <li key={i} className="grid grid-cols-[6.5rem_1fr] gap-2 border-t border-line-subtle py-2 text-sm first:border-t-0">
                      <span className="text-ink-soft">{day(e.happenedAt)}</span>
                      <span className="text-ink">{e.text}</span>
                    </li>
                  ))
                ) : (
                  <li className="text-sm text-ink-soft">Nothing yet. We will tell you when it is listed, changes price, goes under offer or sells.</li>
                )}
              </ul>
            </section>
          ))
        )}
      </main>
    </WebShell>
  );
}
