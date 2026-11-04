import type { Metadata } from 'next';
import Link from 'next/link';
import { consumerSkillBlocks, consumerSkillOffMessage } from '@repo/core/consumer-skills';
import { forYou, hiddenHomes, type ForYou } from '@repo/core/discovery';
import { WebShell } from '../../../components/web-shell';
import { SuggestionCard } from '../../../components/suggestion-card';
import { WatchButton } from '../../../components/watch-button';
import { ensureConsumerAccount } from '../../../lib/account';
import { getWebDb } from '../../../lib/db';
import { requireWebUser } from '../../../lib/session';
import { notForMe, showAgain } from './actions';
import styles from '../account.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'For you', robots: { index: false, follow: false } };

/**
 * Discovery AI's For you (ADR 0080, C7 decisions 1–4; mock docs/mocks/consumer-discovery.html#foryou): from the
 * buyer's Personal Property AI profile while it is on — never from what they viewed. Each card says what it matches
 * and its one difference; homes not for sale that this site sold over a year ago sit apart, watch first. Worked out
 * when the page opens; nothing is stored but what the buyer hides.
 */
export default async function ForYouPage() {
  await requireWebUser('/account/for-you');
  const session = await ensureConsumerAccount();
  if (!session) return null;
  const db = getWebDb();
  const actor = { userId: session.id };
  const blocks = await consumerSkillBlocks(db, actor);
  const block = blocks.get('discovery');
  const [view, hidden] = await Promise.all([block ? Promise.resolve<ForYou | null>(null) : forYou(db, actor), hiddenHomes(db, actor)]);

  return (
    <WebShell account={{ signedIn: true }}>
      <main className={styles.page}>
        <p className="mb-2 text-sm">
          <Link href="/account" className="text-ink-soft hover:text-ink">
            ← Your account
          </Link>
        </p>
        <h1 className={styles.title}>For you</h1>
        {block ? (
          <p className={`${styles.body} mt-1`}>{consumerSkillOffMessage('discovery', block)}</p>
        ) : view?.state === 'profile_off' ? (
          <section className={styles.card}>
            <p className={styles.body}>
              For you uses your Personal Property AI profile, which is off. <Link href="/account/skills" className="underline">Switch it on</Link>, or look at “Similar homes” on any listing. Nothing is suggested from what you viewed.
            </p>
          </section>
        ) : view?.state === 'gap' ? (
          <section className={styles.card}>
            <p className={styles.body}>
              Your profile has no suburbs yet. <Link href="/account/profile" className="underline">Add one to your profile</Link>, or save a search, and suggestions will follow.
            </p>
          </section>
        ) : view?.state === 'ready' ? (
          <>
            <p className={`${styles.body} mt-1`}>
              From your Personal Property AI profile. <Link href="/account/profile" className="underline">Edit it</Link> and this list changes with it.
            </p>
            <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
              <div className="grid content-start gap-4">
                {view.homes.length ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {view.homes.map((h) => (
                      <SuggestionCard
                        key={h.listingId}
                        home={h}
                        footer={
                          <span className="flex gap-3">
                            <form action={notForMe}>
                              <input type="hidden" name="propertyId" value={h.propertyId} />
                              <button type="submit" className="underline">
                                Not for me
                              </button>
                            </form>
                            <Link href={`/listing/${h.listingId}`} className="underline">
                              View
                            </Link>
                          </span>
                        }
                      />
                    ))}
                  </div>
                ) : (
                  <section className={styles.card}>
                    <p className={styles.body}>No home for sale on this site fits your profile right now, even allowing one difference. Try widening it on your profile.</p>
                  </section>
                )}

                {view.notForSale.length ? (
                  <section className={styles.card}>
                    <h2 className={styles.cardLabel}>Not for sale · sold on this site</h2>
                    <p className="mb-3 text-xs text-ink-soft">These owners have not put their homes on the market. Watch an address to hear if they do; an offer goes to the agency that sold it, and the owner may not want to sell.</p>
                    <ul className="m-0 grid list-none gap-3 p-0">
                      {view.notForSale.map((n) => (
                        <li key={n.propertyId} className="rounded-xl border border-line p-3">
                          <p className="m-0 font-semibold text-ink">Not for sale</p>
                          <Link href={`/property/${n.propertyId}`} className="text-sm text-ink hover:underline">
                            {n.address}
                          </Link>
                          <p className="m-0 text-xs text-ink-soft">{[n.bedrooms !== null ? `${n.bedrooms} bed` : null, n.propertyType, `sold on this site in ${n.soldText}`].filter(Boolean).join(' · ')}</p>
                          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                            <WatchButton propertyId={n.propertyId} returnTo="/account/for-you" />
                            <Link href={`/property/${n.propertyId}#offer`} className="text-ink-soft underline">
                              Make a private offer
                            </Link>
                            <form action={notForMe}>
                              <input type="hidden" name="propertyId" value={n.propertyId} />
                              <button type="submit" className="text-ink-soft underline">
                                Not for me
                              </button>
                            </form>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
              </div>

              <div className="grid content-start gap-4">
                <section className={styles.card}>
                  <h2 className={styles.cardLabel}>Your profile, as used here</h2>
                  <dl className="m-0 text-sm">
                    {view.summary.map((s) => (
                      <div key={s.label} className="flex justify-between gap-3 border-t border-line-subtle py-2 first:border-t-0">
                        <dt className="text-ink-soft">{s.label}</dt>
                        <dd className="m-0 text-right font-semibold text-ink">{s.value}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="mt-2 text-xs text-ink-faint">A suggestion may differ on one thing, and says which: a suburb within 5 km of yours, one more bedroom, or no price given. Never over your budget.</p>
                </section>
                <HiddenList hidden={hidden} />
              </div>
            </div>
          </>
        ) : null}
        {block || view?.state !== 'ready' ? <HiddenList hidden={hidden} /> : null}
      </main>
    </WebShell>
  );
}

function HiddenList({ hidden }: { hidden: { propertyId: string; address: string }[] }) {
  if (!hidden.length) return null;
  return (
    <section className={styles.card}>
      <h2 className={styles.cardLabel}>Hidden homes · {hidden.length}</h2>
      <ul className="m-0 list-none p-0 text-sm">
        {hidden.map((h) => (
          <li key={h.propertyId} className="flex items-center justify-between gap-3 border-t border-line-subtle py-2 first:border-t-0">
            <span className="text-ink">{h.address}</span>
            <form action={showAgain}>
              <input type="hidden" name="propertyId" value={h.propertyId} />
              <button type="submit" className="text-xs underline">
                Show again
              </button>
            </form>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-ink-faint">Only you see this. “Forget everything” on your profile clears it.</p>
    </section>
  );
}
