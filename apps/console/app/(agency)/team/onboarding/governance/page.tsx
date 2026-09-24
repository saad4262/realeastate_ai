import Link from 'next/link';
import styles from '../wizard.module.css';

export default function OnboardingGovernancePage() {
  return (
    <div className={styles.wrap} data-full-bleed>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div>
            <div className={styles.titleRow}>
              <h1 className={styles.title}>
                Statutory Onboarding Confirmation &amp; Invitation Dispatch
              </h1>
              <span className={styles.liveBadge}>Sign-off Board</span>
            </div>
            <p className={styles.sub}>
              Agency Lic #NSW-BPG-88219 · Governance engine mock · 09:42:18 AEST
            </p>
          </div>
          <div className={styles.footerRight}>
            <Link href="/team/onboarding/dispatch" className={styles.btnGhost}>
              Back to provisioning
            </Link>
            <Link href="/team" className={styles.btnPrimary}>
              <span className={styles.glyphSm} aria-hidden>
                key
              </span>
              Sign Statutory Declaration &amp; Dispatch
            </Link>
          </div>
        </header>

        <div className={styles.body}>
          <div className={styles.banner}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <div className={styles.bannerIcon}>
                <span className={styles.glyph} aria-hidden>
                  verified
                </span>
              </div>
              <div>
                <strong style={{ fontSize: 13 }}>Governance engine balanced</strong>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                  NSW Fair Trading live API sync · Zero non-conformance notes for this dossier.
                </div>
              </div>
            </div>
            <button type="button" className={styles.btnGhost}>
              <span className={styles.glyphSm} aria-hidden>
                folder_open
              </span>
              View Statutory Verification File
            </button>
          </div>

          <div className={styles.grid2eq}>
            <section className={styles.section}>
              <div className={styles.sectionHead}>
                <h2 className={styles.sectionTitle}>Identity &amp; Regulatory Ledger</h2>
                <span className={styles.pillGreen}>VERIFIED</span>
              </div>
              <div className={styles.box} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/stitch/avatars/daniel.jpg"
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
                  <div style={{ fontWeight: 700 }}>Daniel Vance</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    Fair Trading NSW · Licence #2049182 · Class 1
                  </div>
                </div>
              </div>
              <div className={styles.chipRow}>
                <button type="button" className={styles.btnGhost}>
                  Export Ledger
                </button>
                <button type="button" className={styles.btnGhost}>
                  Audit Terms
                </button>
                <button type="button" className={styles.btnGhost}>
                  Test Ping
                </button>
              </div>
            </section>

            <section className={styles.section}>
              <div className={styles.sectionHead}>
                <h2 className={styles.sectionTitle}>Commercial Roster &amp; Escrow</h2>
              </div>
              <div className={styles.box}>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  Territory locked (Bondi / Tamarama / Bronte / Point Piper) · commission 70/30 ·
                  desk $1,850 · marketing $4,500/qtr · trust scopes deferred until post-accept.
                </p>
              </div>

              <div className={styles.sectionHead}>
                <h2 className={styles.sectionTitle}>Dispatch Protocol &amp; Access</h2>
              </div>
              <div className={styles.chipRow}>
                <span className={styles.chip}>Email invite</span>
                <span className={styles.chip}>SMS OTP</span>
                <span className={styles.chip}>Hardware key optional</span>
                <span className={styles.chip}>Audit trail on</span>
                <span className={styles.chip}>TTL 48h</span>
              </div>
            </section>
          </div>
        </div>

        <footer className={styles.footer}>
          <div className={styles.footerLeft}>
            <Link href="/team/onboarding/review" className={styles.btnGhost}>
              Disapprove / Request Revisions
            </Link>
            <button type="button" className={styles.btnGhost}>
              Save Draft Protocol
            </button>
          </div>
          <Link href="/team" className={styles.btnPrimary}>
            Approve &amp; Dispatch Invitation
            <span className={styles.glyphSm} aria-hidden>
              arrow_forward
            </span>
          </Link>
        </footer>
      </div>
    </div>
  );
}
