'use client';

import { WizardChrome } from './wizard-chrome';
import { useOnboarding } from './onboarding-state';
import { useStepValidation } from './use-step-validation';
import { FieldError } from './field-error';
import styles from './wizard.module.css';

export default function OnboardingIdentityPage() {
  const { draft, patch } = useOnboarding();
  const { errorFor, markTouched, guardNext } = useStepValidation(1);

  const invalid = (field: Parameters<typeof errorFor>[0]) =>
    errorFor(field) ? styles.inputInvalid : '';

  return (
    <WizardChrome
      step={1}
      nextHref="/team/onboarding/territory"
      nextLabel="Continue to Territory & Specialties"
      onNext={guardNext}
    >
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>
            <span className={styles.num}>1</span>
            Executive Identity &amp; Public Bio
          </h2>
          <span className={styles.muted}>Mandatory REINSW profile field</span>
        </div>

        <div className={styles.grid2}>
          <div className={styles.photoCard}>
            <div style={{ position: 'relative' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                className={styles.photo}
                src={draft.photoUrl || '/stitch/avatars/daniel.jpg'}
                alt=""
              />
            </div>
            <div style={{ marginTop: 8, fontWeight: 600, fontSize: 13 }}>
              Executive Roster Headshot
            </div>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)', maxWidth: 200 }}>
              Photo URL optional for now (R2 upload lands with media milestone).
            </p>
            <input
              className={`${styles.input} ${invalid('photoUrl')}`}
              style={{ marginTop: 12 }}
              placeholder="https://… photo URL"
              data-field="photoUrl"
              value={draft.photoUrl ?? ''}
              onChange={(e) => patch({ photoUrl: e.target.value || null })}
              onBlur={() => markTouched('photoUrl')}
              aria-invalid={Boolean(errorFor('photoUrl'))}
            />
            <FieldError message={errorFor('photoUrl')} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className={styles.fieldRow}>
              <div className={styles.field}>
                <label htmlFor="firstName">
                  First Legal Name <span className={styles.req}>*</span>
                </label>
                <input
                  id="firstName"
                  className={`${styles.input} ${invalid('firstName')}`}
                  data-field="firstName"
                  value={draft.firstName}
                  onChange={(e) => patch({ firstName: e.target.value })}
                  onBlur={() => markTouched('firstName')}
                  aria-invalid={Boolean(errorFor('firstName'))}
                  required
                />
                <FieldError message={errorFor('firstName')} />
              </div>
              <div className={styles.field}>
                <label htmlFor="lastName">
                  Last Legal Name <span className={styles.req}>*</span>
                </label>
                <input
                  id="lastName"
                  className={`${styles.input} ${invalid('lastName')}`}
                  data-field="lastName"
                  value={draft.lastName}
                  onChange={(e) => patch({ lastName: e.target.value })}
                  onBlur={() => markTouched('lastName')}
                  aria-invalid={Boolean(errorFor('lastName'))}
                  required
                />
                <FieldError message={errorFor('lastName')} />
              </div>
            </div>
            <div className={styles.field}>
              <label htmlFor="displayName">Professional Display Name</label>
              <input
                id="displayName"
                className={`${styles.input} ${invalid('displayName')}`}
                data-field="displayName"
                value={draft.displayName}
                onChange={(e) => patch({ displayName: e.target.value })}
                onBlur={() => markTouched('displayName')}
                aria-invalid={Boolean(errorFor('displayName'))}
              />
              <FieldError message={errorFor('displayName')} />
            </div>
            <div className={styles.fieldRow}>
              <div className={styles.field}>
                <label htmlFor="email">
                  Corporate Agency Email <span className={styles.req}>*</span>
                </label>
                <input
                  id="email"
                  className={`${styles.input} ${invalid('email')}`}
                  data-field="email"
                  type="email"
                  autoComplete="off"
                  value={draft.email}
                  onChange={(e) => patch({ email: e.target.value })}
                  onBlur={() => markTouched('email')}
                  aria-invalid={Boolean(errorFor('email'))}
                  required
                />
                <FieldError message={errorFor('email')} />
              </div>
              <div className={styles.field}>
                <label htmlFor="phone">
                  Direct Mobile (Australian) <span className={styles.req}>*</span>
                </label>
                <input
                  id="phone"
                  className={`${styles.input} ${invalid('phone')}`}
                  data-field="phone"
                  type="tel"
                  inputMode="tel"
                  placeholder="0418 920 441"
                  value={draft.phone}
                  onChange={(e) => patch({ phone: e.target.value })}
                  onBlur={() => markTouched('phone')}
                  aria-invalid={Boolean(errorFor('phone'))}
                  required
                />
                <FieldError message={errorFor('phone')} />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>
            <span className={styles.num}>2</span>
            Statutory Real Estate Licence &amp; Fair Trading NSW
          </h2>
        </div>

        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label htmlFor="licenceNumber">
              Fair Trading Licence Number <span className={styles.req}>*</span>
            </label>
            <input
              id="licenceNumber"
              className={`${styles.input} ${invalid('licenceNumber')}`}
              data-field="licenceNumber"
              value={draft.licenceNumber}
              onChange={(e) => patch({ licenceNumber: e.target.value })}
              onBlur={() => markTouched('licenceNumber')}
              aria-invalid={Boolean(errorFor('licenceNumber'))}
              required
            />
            <FieldError message={errorFor('licenceNumber')} />
          </div>
          <div className={styles.field}>
            <label htmlFor="licenceClass">Licence class</label>
            <input
              id="licenceClass"
              className={`${styles.input} ${invalid('licenceClass')}`}
              data-field="licenceClass"
              value={draft.licenceClass}
              onChange={(e) => patch({ licenceClass: e.target.value })}
              onBlur={() => markTouched('licenceClass')}
              aria-invalid={Boolean(errorFor('licenceClass'))}
            />
            <FieldError message={errorFor('licenceClass')} />
          </div>
          <div className={styles.field}>
            <label htmlFor="licenceExpiry">Licence Triennial Expiry</label>
            <input
              id="licenceExpiry"
              className={`${styles.input} ${invalid('licenceExpiry')}`}
              data-field="licenceExpiry"
              type="date"
              value={draft.licenceExpiry ?? ''}
              onChange={(e) => patch({ licenceExpiry: e.target.value || null })}
              onBlur={() => markTouched('licenceExpiry')}
              aria-invalid={Boolean(errorFor('licenceExpiry'))}
            />
            <FieldError message={errorFor('licenceExpiry')} />
          </div>
        </div>
      </section>
    </WizardChrome>
  );
}
