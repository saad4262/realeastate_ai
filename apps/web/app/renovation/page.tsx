import type { Metadata } from 'next';
import Link from 'next/link';
import { consumerSkillBlocks, consumerSkillOffMessage } from '@repo/core/consumer-skills';
import { renovationListing } from '@repo/core/renovation';
import { WebShell } from '../../components/web-shell';
import { getWebDb } from '../../lib/db';
import { currentWebUser } from '../../lib/session';
import { RenovationPlanner } from './renovation-planner';
import { QuoteCompare } from './quote-compare';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Plan a renovation',
  description: 'Turn what you would change into a plan: what is involved, what drives the cost, the trades and permits — and compare your quotes.',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Renovation AI (ADR 0080, C3; mock docs/mocks/consumer-renovation.html, approved by the product team). The page
 * renders the frame; the plan and the rooms come from their endpoints, the quotes stay in this browser. With
 * `?listing=` it starts from a public listing — the server checks it is one. No price from us anywhere.
 */
export default async function RenovationPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const listingParam = typeof raw.listing === 'string' && UUID.test(raw.listing) ? raw.listing : null;
  const db = getWebDb();
  const user = await currentWebUser();
  const [blocks, found] = await Promise.all([consumerSkillBlocks(db, user ? { userId: user.id } : null), listingParam ? renovationListing(db, listingParam) : Promise.resolve(null)]);
  const block = blocks.get('renovation');

  return (
    <WebShell account={{ signedIn: Boolean(user) }}>
      <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6">
        <h1 className="font-display text-3xl font-semibold tracking-tight text-ink">Plan a renovation</h1>
        <p className="mt-1 max-w-[70ch] text-ink-soft">
          Tell us what you would change. We will turn it into a plan: what is involved, what drives the cost, and who and what you will need.
        </p>
        {found ? (
          <p className="mt-2 text-sm text-ink">
            For{' '}
            <Link href={`/listing/${found.listingId}`} className="font-semibold underline">
              {found.address}
            </Link>
          </p>
        ) : null}

        {block ? (
          <p role="status" className="mt-6 rounded-xl border border-line bg-card px-4 py-3 text-sm text-ink">
            {consumerSkillOffMessage('renovation', block)}{' '}
            {block === 'switched_off' ? (
              <Link href="/account/skills" className="font-semibold underline">
                Open Skills
              </Link>
            ) : null}
          </p>
        ) : (
          <>
            <RenovationPlanner listing={found ? { id: found.listingId, state: found.state, hasPhotos: found.photoUrls.length > 0 } : null} />
            <QuoteCompare scope={found ? `listing:${found.listingId}` : 'general'} />
            <p className="mt-4 border-t border-line pt-3 text-xs leading-relaxed text-ink-soft">
              General information, not building, planning or financial advice. A registered building surveyor, a certifier or the council decides what needs a permit. We show no prices for renovation work: there is no official, current price list in Australia.
            </p>
          </>
        )}
      </main>
    </WebShell>
  );
}
