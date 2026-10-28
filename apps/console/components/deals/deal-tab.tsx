import { DEAL_STAGES, DEAL_STAGE_LABELS, DealError, dealBuyerOptions, getDealForListing, stageIndex } from '@repo/core/deals';
import type { Actor } from '@repo/core/permissions';
import { getConsoleDb } from '../../lib/db';
import { loadListingActor } from '../../lib/load-actor';
import { DealEditor } from './deal-editor';
import { CommissionPanel } from './commission-panel';
import styles from './deals.module.css';

/**
 * A listing's Deal tab (ADR 0063): where its sale is in the seven stages, the sale's details, its
 * conditions and its history. Reads are core's; the island changes them through actions that ask again.
 */
export async function DealTab({ actor: sessionActor, listingId, surface }: { actor: Actor; listingId: string; surface: 'agency' | 'agent' }) {
  const db = getConsoleDb();
  // With the listings it is named on: `listing:edit` decides who may change the deal.
  const actor = (await loadListingActor(sessionActor.userId)) ?? sessionActor;
  let view;
  try {
    view = await getDealForListing(db, actor, listingId);
  } catch (err) {
    return <p role="alert" className={styles.error}>{err instanceof DealError ? err.message : 'Could not load the deal'}</p>;
  }
  if (!view) {
    return (
      <p className={styles.note}>
        <span className={styles.glyph} aria-hidden>schedule</span>
        <span>No deal for this listing yet. One opens by itself within a minute of the listing being drafted, going live or being marked sold (sales only).</span>
      </p>
    );
  }
  const buyerOptions = await dealBuyerOptions(db, actor, listingId);
  const now = stageIndex(view.stage);

  return (
    <div style={{ display: 'grid', gap: '0.875rem' }}>
      <div className={styles.stepper} aria-label={`Stage: ${DEAL_STAGE_LABELS[view.stage]}`}>
        {DEAL_STAGES.map((s, i) => (
          <div key={s} className={`${styles.step} ${view.status === 'settled' || i < now ? styles.stepDone : i === now ? styles.stepNow : ''}`} aria-current={i === now ? 'step' : undefined}>
            <i />
            {DEAL_STAGE_LABELS[s]}
          </div>
        ))}
      </div>
      <DealEditor
        contactBase={surface === 'agency' ? '/customers' : '/my-contacts'}
        buyerOptions={buyerOptions.map((b) => ({ id: b.id, name: b.name }))}
        deal={{
          id: view.id,
          stage: view.stage,
          status: view.status,
          agentName: view.agentName,
          salePrice: view.salePrice,
          buyer: view.buyer,
          vendor: view.vendor,
          contractDate: view.contractDate,
          depositAmount: view.depositAmount,
          depositPaidOn: view.depositPaidOn,
          settlementDate: view.settlementDate,
          buyerSolicitor: view.buyerSolicitor,
          settledAt: view.settledAt?.toISOString() ?? null,
          conditions: view.conditions.map((c) => ({ ...c, doneAt: c.doneAt?.toISOString() ?? null })),
          events: view.events.map((e) => ({ ...e, at: e.at.toISOString() })),
          mayEdit: view.mayEdit,
        }}
      />
      {/* ADR 0064: the agency sets it; the deal's agent sees it. */}
      <CommissionPanel dealId={view.id} agentName={view.agentName} salePrice={view.salePrice} status={view.status} c={view.commission} />
    </div>
  );
}
