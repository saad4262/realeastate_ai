'use client';

import { WizardChrome } from '../wizard-chrome';
import { useOnboarding } from '../onboarding-state';
import { useStepValidation } from '../use-step-validation';
import styles from '../wizard.module.css';
import type { OperationalRole } from '@repo/core/team/schema';

const ROLES: { id: OperationalRole; title: string; sub: string; wide?: boolean }[] = [
  { id: 'senior', title: 'Senior Sales Partner', sub: 'Maps to membership: agent' },
  { id: 'principal', title: 'Licensed Principal', sub: 'Maps to membership: admin' },
  { id: 'pm', title: 'Property Manager', sub: 'Maps to membership: property_manager' },
  { id: 'cadet', title: 'Cadet / Associate', sub: 'Maps to membership: assistant' },
  { id: 'custom', title: 'Custom Access Template', sub: 'Maps to membership: agent', wide: true },
];

const PERMS = [
  { id: 'listings', title: 'Listings Management & AI Studio' },
  { id: 'trust', title: 'Trust Account & Deposit Ledger' },
  { id: 'crm', title: 'Territory Restricted CRM Allocation' },
  { id: 'mkt', title: 'Autonomous Marketing Cap' },
  { id: 'fido', title: 'Mandatory FIDO2 / Passkey Auth' },
];

export default function OnboardingPermissionsPage() {
  const { draft, patch, setOperationalRole } = useOnboarding();
  const { guardNext } = useStepValidation(3);

  return (
    <WizardChrome
      step={3}
      backHref="/team/onboarding/territory"
      backLabel="Back to Territory"
      nextHref="/team/onboarding/review"
      nextLabel="Continue to Executive Review"
      onNext={guardNext}
    >
      <div className={styles.grid2eq}>
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <div>
              <h2 className={styles.sectionTitle}>Role-Based Access Control</h2>
              <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-secondary)' }}>
                Preset maps to membership.role; fine flags stored on agent_profile.permission_flags.
              </p>
            </div>
          </div>

          <div className={styles.roleGrid}>
            {ROLES.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`${styles.cardSelect} ${draft.operationalRole === r.id ? styles.cardSelectOn : ''}`}
                style={r.wide ? { gridColumn: '1 / -1' } : undefined}
                onClick={() => setOperationalRole(r.id)}
              >
                <div style={{ fontWeight: 700, fontSize: 13 }}>{r.title}</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{r.sub}</div>
              </button>
            ))}
          </div>

          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {PERMS.map((p) => {
              const on = Boolean(draft.permissionFlags[p.id]);
              return (
                <div key={p.id} className={styles.permRow}>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{p.title}</span>
                  <button
                    type="button"
                    className={`${styles.switch} ${on ? '' : styles.switchOff}`}
                    aria-label={p.title}
                    onClick={() =>
                      patch({
                        permissionFlags: {
                          ...draft.permissionFlags,
                          [p.id]: !on,
                        },
                      })
                    }
                  />
                </div>
              );
            })}
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Invite target</h2>
          </div>
          <div className={styles.box}>
            <div style={{ fontSize: 13 }}>
              <strong>{draft.displayName || '—'}</strong>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
              {draft.email || 'Email required on identity step'}
            </div>
            <p style={{ margin: '12px 0 0', fontSize: 12, color: 'var(--text-secondary)' }}>
              Dispatch creates an <code>agent_invite</code> row and (when service role is set)
              provisions Supabase Auth + membership + agent_profile.
            </p>
          </div>
        </section>
      </div>
    </WizardChrome>
  );
}
