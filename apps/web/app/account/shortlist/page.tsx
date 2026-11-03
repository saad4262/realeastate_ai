import type { Metadata } from 'next';
import Link from 'next/link';
import { listShortlist, type ShortlistItem } from '@repo/core/shortlist';
import { priceLabel } from '@repo/core/listings/format';
import { mediaUrl } from '@repo/core/media/url';
import { WebShell } from '../../../components/web-shell';
import { ensureConsumerAccount } from '../../../lib/account';
import { getWebDb } from '../../../lib/db';
import { requireWebUser } from '../../../lib/session';
import { ShortlistRow } from './shortlist-row';
import styles from '../account.module.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Your shortlist', robots: { index: false, follow: false } };

const STANDING: Record<ShortlistItem['standing'], string> = {
  for_sale: 'For sale',
  for_rent: 'For rent',
  under_offer: 'Under offer',
  sold: 'Sold',
  leased: 'Leased',
  // ADR 0080 C4 decision 3: never "withdrawn", never why.
  not_advertised: 'No longer advertised',
};

/** `priceLabel` reads only the channel and the four price fields, so a shortlist row passes just those. */
const day = (d: Date) => d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Sydney' });

/**
 * The shortlist (ADR 0080, C4; mock docs/mocks/consumer-profile-watch.html#shortlist). One read. A home that is no
 * longer advertised stays, so the buyer's note is not lost; only the buyer sees any of it.
 */
export default async function ShortlistPage() {
  await requireWebUser('/account/shortlist');
  const session = await ensureConsumerAccount();
  if (!session) return null;
  const items = await listShortlist(getWebDb(), { userId: session.id });

  return (
    <WebShell account={{ signedIn: true }}>
      <main className={styles.page}>
        <p className="mb-2 text-sm">
          <Link href="/account" className="text-ink-soft hover:text-ink">
            ← Your account
          </Link>
        </p>
        <h1 className={styles.title}>Your shortlist</h1>
        <p className={`${styles.body} mt-1`}>
          {items.length ? `${items.length} ${items.length === 1 ? 'home' : 'homes'} · only you can see this` : 'Homes you save appear here — press Save on any listing.'}
        </p>
        {items.length ? (
          <ul className="m-0 list-none rounded-2xl border border-line bg-card p-0">
            {items.map((i) => {
              const live = i.standing === 'for_sale' || i.standing === 'for_rent';
              return (
                <ShortlistRow
                  key={i.listingId}
                  listingId={i.listingId}
                  href={live ? `/listing/${i.listingId}` : null}
                  photo={mediaUrl(i.mainPhotoKey)}
                  title={`${i.address}, ${i.suburb} ${i.state}`}
                  price={live || i.standing === 'under_offer' ? priceLabel({ channel: i.channel, priceDisplay: i.priceDisplay, priceFrom: i.priceFrom, priceTo: i.priceTo, rentPw: i.rentPw } as Parameters<typeof priceLabel>[0]) : null}
                  standing={STANDING[i.standing]}
                  specs={[i.bedrooms !== null ? `${i.bedrooms} bed` : null, i.bathrooms !== null ? `${i.bathrooms} bath` : null, i.carSpaces !== null ? `${i.carSpaces} car` : null].filter(Boolean).join(' · ')}
                  priceChanged={i.lastPriceChangeAt ? day(i.lastPriceChangeAt) : null}
                  note={i.note ?? ''}
                />
              );
            })}
          </ul>
        ) : null}
      </main>
    </WebShell>
  );
}
