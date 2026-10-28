import Link from 'next/link';
import { DEAL_STAGES, DEAL_STAGE_LABELS, DealError, listDeals, type BoardDeal } from '@repo/core/deals';
import { can } from '@repo/core/permissions';
import contactStyles from '@/components/contacts/contacts.module.css';
import { getConsoleDb } from '../../lib/db';
import { loadListingActor } from '../../lib/load-actor';
import { requireConsoleAccess } from '../../lib/require-console-access';
import styles from './deals.module.css';

const DAY = new Intl.DateTimeFormat('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const day = (iso: string) => DAY.format(new Date(`${iso}T00:00:00Z`));

/**
 * The Pipeline board (ADR 0063): every open deal in its stage. Owners and admins see the agency's (and may
 * narrow to their own); anyone else, the deals of the listings they are named on. Shared by `/pipeline` and
 * `/my-pipeline`. Everything shown is SQL's; cards open the listing's Deal tab, or the property's page (ADR 0065) before there is a listing.
 */
export async function PipelineBoard({ surface, mine }: { surface: 'agency' | 'agent'; mine: boolean }) {
  const session = await requireConsoleAccess(surface);
  const actor = (await loadListingActor(session.actor.userId)) ?? session.actor;
  const base = surface === 'agency' ? '/pipeline' : '/my-pipeline';
  const listingBase = surface === 'agency' ? '/live-listings' : '/listings';
  const propertyBase = surface === 'agency' ? '/properties' : '/my-properties';
  const seesAll = can(actor, 'listing:read_all', { type: 'listing', agencyId: actor.agencyId as string });

  let data;
  try {
    data = await listDeals(getConsoleDb(), actor, { mine: seesAll ? mine : false });
  } catch (err) {
    return <p role="alert" style={{ padding: '1rem', color: 'var(--rose)' }}>{err instanceof DealError ? err.message : 'Could not load the pipeline'}</p>;
  }
  const today = new Date().toISOString().slice(0, 10);
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  const href = (d: BoardDeal) =>
    d.listingId ? `${listingBase}/${d.listingId}/edit?tab=deal` : `${propertyBase}/${d.propertyId}`;

  return (
    <div className={contactStyles.wrap}>
      <div className={contactStyles.head}>
        <div className={contactStyles.headText}>
          <h1 className={contactStyles.title}>{seesAll && !mine ? 'Pipeline' : 'My pipeline'}</h1>
          <p className={contactStyles.sub}>Every sale from appraisal to settlement. Click a card for its Deal tab.</p>
        </div>
        {seesAll ? (
          <div className={styles.filters}>
            <Link href={base} className={`${styles.chip} ${mine ? '' : styles.chipOn}`} aria-current={mine ? undefined : 'page'}>Whole agency</Link>
            <Link href={`${base}?mine=1`} className={`${styles.chip} ${mine ? styles.chipOn : ''}`} aria-current={mine ? 'page' : undefined}>Only mine</Link>
          </div>
        ) : null}
      </div>

      <div className={styles.stats}>
        <div className={styles.stat}><b>{data.counts.active}</b><span>Active deals</span></div>
        <div className={styles.stat}><b>{data.counts.underContract}</b><span>Under contract</span></div>
        <div className={styles.stat}><b>{data.counts.settlingIn30}</b><span>Settling in the next 30 days</span></div>
        <div className={styles.stat}><b>{data.counts.dueThisWeek}</b><span>A condition due within 7 days</span></div>
      </div>

      <div className={styles.board} role="list" aria-label="Stages">
        {DEAL_STAGES.map((stage) => {
          const inCol = data.deals.filter((d) => d.stage === stage);
          return (
            <section key={stage} className={styles.col} role="listitem" aria-label={`${DEAL_STAGE_LABELS[stage]}: ${inCol.length}`}>
              <div className={styles.colHead}>
                {DEAL_STAGE_LABELS[stage]}
                <span>{inCol.length}</span>
              </div>
              {inCol.length === 0 ? <p className={styles.empty}>None</p> : null}
              {inCol.map((d) => {
                const body = (
                  <>
                    <b>{d.address}</b>
                    <div className={styles.meta}>
                      {d.priceText ? <span>{d.priceText}</span> : null}
                      {d.settlementDate ? <span>Settles {day(d.settlementDate)}</span> : null}
                    </div>
                    <div className={styles.meta}>
                      <span className={styles.avatar} title={d.agentName ?? 'No agent'}>{d.agentInitials}</span>
                      {d.nextDue ? (
                        <span className={`${styles.pill} ${d.nextDue.dueOn < today ? styles.pillDue : d.nextDue.dueOn <= inDays(7) ? styles.pillWarn : ''}`}>
                          {d.nextDue.label} {d.nextDue.dueOn < today ? 'overdue' : day(d.nextDue.dueOn)}
                        </span>
                      ) : null}
                      {d.offers && (stage === 'offers' || stage === 'negotiation') ? (
                        <span className={`${styles.pill} ${styles.pillAuto}`}>{d.offers} offer{d.offers === 1 ? '' : 's'}</span>
                      ) : null}
                      {d.quietDays >= 7 && (stage === 'appraisal' || stage === 'negotiation') ? (
                        <span className={`${styles.pill} ${styles.pillWarn}`}>Quiet {d.quietDays} days</span>
                      ) : null}
                    </div>
                  </>
                );
                return (
                  <Link key={d.id} href={href(d)} className={styles.card}>{body}</Link>
                );
              })}
            </section>
          );
        })}
      </div>

      <p className={styles.note}>
        <span className={styles.glyph} aria-hidden>bolt</span>
        <span>
          Cards move by themselves when something happens: an appraisal → Appraisal, a drafted listing → Listing, the listing going live →
          Marketing, an offer → Offers, “Under offer” → Negotiation, “Mark sold” → Contract. Settlement and anything else is set on the
          listing’s Deal tab. Sales only for now.
        </span>
      </p>
    </div>
  );
}
