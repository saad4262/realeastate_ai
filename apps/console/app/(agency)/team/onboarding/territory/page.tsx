'use client';

import { AddressAutocomplete } from '@/components/address-autocomplete';
import { WizardChrome } from '../wizard-chrome';
import { useOnboarding } from '../onboarding-state';
import { useStepValidation } from '../use-step-validation';
import { FieldError } from '../field-error';
import styles from '../wizard.module.css';

const SPEC_OPTIONS = [
  { id: 'prestige', title: 'Prestige Residential Sales' },
  { id: 'offmarket', title: 'Off-Market Luxury' },
  { id: 'water', title: 'Waterfront Development' },
];

const TIERS = [
  { id: 't1' as const, title: 'Tier 1 · Senior Partner', split: '70 / 30' },
  { id: 't2' as const, title: 'Tier 2 · Sales Partner', split: '60 / 40' },
  { id: 't3' as const, title: 'Tier 3 · Associate', split: '50 / 50' },
];

export default function OnboardingTerritoryPage() {
  const { draft, patch, setCommissionTier } = useOnboarding();
  const { errorFor, markTouched, guardNext } = useStepValidation(2);

  function addSuburb(value: string) {
    const name = value.trim();
    if (!name) return;
    // Case-insensitive: "bondi beach" and "Bondi Beach" are one territory, and
    // a duplicate here becomes a duplicate row on agent_profile.
    if (draft.territorySuburbs.some((s) => s.toLowerCase() === name.toLowerCase())) return;
    patch({ territorySuburbs: [...draft.territorySuburbs, name] });
  }

  function removeSuburb(name: string) {
    patch({
      territorySuburbs: draft.territorySuburbs.filter((s) => s !== name),
    });
  }

  function toggleSpec(title: string) {
    const has = draft.specialties.includes(title);
    patch({
      specialties: has
        ? draft.specialties.filter((s) => s !== title)
        : [...draft.specialties, title],
    });
  }

  return (
    <WizardChrome
      step={2}
      backHref="/team/onboarding"
      backLabel="Back to Licensing"
      nextHref="/team/onboarding/permissions"
      nextLabel="Next: Role Permissions & Digital Invite"
      onNext={guardNext}
    >
      <div className={styles.grid2eq}>
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <div>
              <h2 className={styles.sectionTitle}>Geographic Territory &amp; Suburb Quotas</h2>
              <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-secondary)' }}>
                Assigned exclusivity boundaries stored on agent_profile
              </p>
            </div>
            <span className={styles.pillBlue}>
              {draft.territorySuburbs.length} SUBURBS ALLOCATED
            </span>
          </div>

          <div className={styles.chipRow}>
            {draft.territorySuburbs.map((s) => (
              <button
                key={s}
                type="button"
                className={styles.chip}
                onClick={() => removeSuburb(s)}
              >
                {s}
                <span className={styles.glyphSm} aria-hidden>
                  close
                </span>
              </button>
            ))}
          </div>

          <div style={{ marginTop: 12 }} data-field="territorySuburbs">
            {/*
              Picking from the gazetteer rather than typing free text: a
              territory of "Bondi Bech" silently matches no listing and nobody
              finds out until the agent asks why their dashboard is empty.
              Typing still works — the field stays editable and Add takes
              whatever is in it, because new estates exist before maps know
              about them.
            */}
            <AddressAutocomplete
              label="Add suburb"
              placeholder="Start typing a suburb, e.g. Bronte"
              kinds={['locality']}
              clearOnSelect
              onSelected={(s) => {
                markTouched('territorySuburbs');
                addSuburb(s.label);
              }}
            />
          </div>
          <FieldError message={errorFor('territorySuburbs')} />

          <div className={styles.box} style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 600 }}>
              <span className={styles.muted}>Geo-fence radius</span>
              <span>{draft.territoryRadiusKm.toFixed(1)} km</span>
            </div>
            <input
              className={styles.slider}
              type="range"
              min={1}
              max={20}
              step={0.5}
              value={draft.territoryRadiusKm}
              onChange={(e) => patch({ territoryRadiusKm: Number(e.target.value) })}
            />
          </div>

          <div style={{ marginTop: 12 }}>
            <div className={styles.muted} style={{ marginBottom: 8 }}>
              Property specialisation
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {SPEC_OPTIONS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`${styles.cardSelect} ${draft.specialties.includes(s.title) ? styles.cardSelectOn : ''}`}
                  onClick={() => toggleSpec(s.title)}
                >
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{s.title}</div>
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Commission Structure &amp; Splits</h2>
            <span className={styles.pillAmber}>CONTRACT SCHEDULE D</span>
          </div>

          <div className={styles.tierGrid}>
            {TIERS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`${styles.cardSelect} ${draft.commissionTier === t.id ? styles.cardSelectOn : ''}`}
                onClick={() => setCommissionTier(t.id)}
              >
                <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>
                  {t.title}
                </div>
                <div
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 22,
                    fontWeight: 700,
                    marginTop: 6,
                  }}
                >
                  {t.split}
                </div>
              </button>
            ))}
          </div>
        </section>
      </div>
    </WizardChrome>
  );
}
