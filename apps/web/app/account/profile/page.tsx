import type { Metadata } from 'next';
import Link from 'next/link';
import { loadProfile, PROFILE_FIELDS, sourceWords } from '@repo/core/profile';
import { WebShell } from '../../../components/web-shell';
import { ensureConsumerAccount } from '../../../lib/account';
import { getWebDb } from '../../../lib/db';
import { requireWebUser } from '../../../lib/session';
import { FactRow, ForgetButton } from './profile-controls';
import styles from '../account.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Personal Property AI', robots: { index: false, follow: false } };

const LABELS = { suburbs: 'Suburbs', channel: 'Buying or renting', priceTo: 'Up to', bedrooms: 'Bedrooms', propertyTypes: 'Property type' } as const;
const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });

/**
 * Personal Property AI (ADR 0080, C4; mock docs/mocks/consumer-profile-watch.html#profile). What the guide has
 * learnt from the buyer's own actions, each with where it came from, every one editable, and Forget everything.
 * Only the buyer sees it.
 */
export default async function ProfilePage() {
  await requireWebUser('/account/profile');
  const session = await ensureConsumerAccount();
  if (!session) return null;
  const view = await loadProfile(getWebDb(), { userId: session.id });

  return (
    <WebShell account={{ signedIn: true }}>
      <main className={styles.page}>
        <p className="mb-2 text-sm">
          <Link href="/account" className="text-ink-soft hover:text-ink">
            ← Your account
          </Link>
        </p>
        <h1 className={styles.title}>Personal Property AI</h1>
        <p className={`${styles.body} mt-1`}>
          What the guide has learnt from what you do here — so it can start from it. Only you can see this, and you can change or delete any of it.
        </p>

        {!view.on ? (
          <section className={styles.card}>
            <h2 className={styles.cardLabel}>Off</h2>
            <p className={styles.body}>Nothing is learnt while it is off, and nothing learnt before is used. Turn it on in Skills to start — it learns only from what you do after that.</p>
            <Link href="/account/skills" className={styles.secondary}>
              Open Skills
            </Link>
          </section>
        ) : (
          <>
            <section className={styles.card}>
              <h2 className={styles.cardLabel}>What we have learnt</h2>
              <ul className="m-0 list-none p-0">
                {PROFILE_FIELDS.map((field) => {
                  const fact = view.facts[field];
                  const shown =
                    fact === null
                      ? null
                      : field === 'priceTo'
                        ? AUD.format(fact.value as number)
                        : field === 'bedrooms'
                          ? `${fact.value as number} or more`
                          : field === 'channel'
                            ? fact.value === 'rent'
                              ? 'Renting'
                              : 'Buying'
                            : (fact.value as string[]).join(', ');
                  return (
                    <FactRow
                      key={field}
                      field={field}
                      label={LABELS[field]}
                      shown={shown}
                      raw={fact ? (Array.isArray(fact.value) ? (fact.value as string[]).join(', ') : String(fact.value)) : ''}
                      source={fact ? sourceWords(fact.sources) : null}
                      byYou={fact?.by === 'you'}
                    />
                  );
                })}
              </ul>
              <p className="mt-3 text-xs text-ink-faint">
                Counted by the site from your own saved searches, shortlist, watched addresses and the filters in your chats since{' '}
                {view.learningSince.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Sydney' })}. Nothing about you as a person — no income, family or age.
              </p>
            </section>
            <section className={styles.card}>
              <h2 className={styles.cardLabel}>Forget everything</h2>
              <p className={styles.body}>The profile starts again from nothing, and your edits go. Your saved searches, shortlist and watched addresses are kept — they are yours to manage on their own pages.</p>
              <ForgetButton />
            </section>
          </>
        )}
      </main>
    </WebShell>
  );
}
