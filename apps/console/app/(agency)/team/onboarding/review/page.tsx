'use client';

import { WizardChrome } from '../wizard-chrome';
import { useOnboarding } from '../onboarding-state';
import { useStepValidation } from '../use-step-validation';
import { TIER_SPLITS } from '@repo/core/team/schema';
import styles from '../wizard.module.css';

export default function OnboardingReviewPage() {
  const { draft } = useOnboarding();
  const { guardNext } = useStepValidation(4);
  const tier = TIER_SPLITS[draft.commissionTier];
  const name = draft.displayName || `${draft.firstName} ${draft.lastName}`.trim();

  return (
    <WizardChrome
      step={4}
      title="Agent Onboarding — Final Review & Dispatch"
      badge="SIGN-OFF READY"
      backHref="/team/onboarding/permissions"
      backLabel="Back to Permissions & Access"
      nextHref="/team/onboarding/dispatch"
      nextLabel="Dispatch Secure Invite & Activate Agent"
      onNext={guardNext}
      secondaryHref="/team/onboarding/governance"
      secondaryLabel="Open Governance Board"
    >
      <div className={styles.grid2eq}>
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Agent Dossier &amp; Verified Credentials</h2>
            <span className={styles.pillGreen}>Ready to store</span>
          </div>

          <div className={styles.box} style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={draft.photoUrl || '/stitch/avatars/daniel.jpg'}
              alt=""
              style={{
                width: 56,
                height: 56,
                borderRadius: 12,
                objectFit: 'cover',
                border: '1px solid var(--border-default)',
              }}
            />
            <div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>{name || '—'}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {draft.operationalRole} · Licence #{draft.licenceNumber || '—'} ·{' '}
                {draft.licenceClass}
              </div>
              <div className={styles.chipRow} style={{ marginTop: 8 }}>
                <span className={styles.chip}>{draft.email || '—'}</span>
                <span className={styles.chip}>{draft.phone || '—'}</span>
              </div>
            </div>
          </div>

          <div className={styles.chipRow}>
            {draft.territorySuburbs.map((s) => (
              <span key={s} className={styles.chip}>
                {s}
              </span>
            ))}
            <span className={styles.chip}>
              {tier.agent} / {tier.agency} split
            </span>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Commercial &amp; Statutory Terms</h2>
          </div>
          <div className={styles.box}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>Commission tier</span>
              <strong>{tier.label}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginTop: 8 }}>
              <span>Specialties</span>
              <strong>{draft.specialties.join(', ') || '—'}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginTop: 8 }}>
              <span>Radius</span>
              <strong>{draft.territoryRadiusKm} km</strong>
            </div>
          </div>
        </section>
      </div>
    </WizardChrome>
  );
}
