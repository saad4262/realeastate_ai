import { AiComposer } from './ai-composer';
import styles from './ai.module.css';

const AUTOMATIONS = [
  {
    title: 'High-Intent Rapid Response',
    tone: 'g' as const,
    badge: 'Triggered 84x this week',
    body: 'When enquiry arrives from high-intent buyer → AI responds in <60s with digital twin walkthrough & auto-schedules private inspection on Sarah’s calendar.',
    left: '92% buyer satisfaction rating',
    right: 'Avg response: 38 seconds',
  },
  {
    title: 'Stagnant Listing Audit & Suburb Re-Banding',
    tone: 'a' as const,
    badge: 'Active on 3 listings',
    body: 'When listing reaches Day 18 without offer → AI initiates comparative market re-audit, cross-references fresh clearance figures, and prepares vendor realignment slide deck.',
    left: 'Monitored by: CoreLogic AI Telemetry Node',
    right: 'Next check: 14:00 today',
  },
  {
    title: 'Exchange Protocol, Trust Reconciliation & REINSW Filing',
    tone: 'b' as const,
    badge: 'Executed 19 times MTD',
    body: 'When contract exchanged → Auto-generate trust deposit receipts, statutory REINSW clearance certificates, and instantly dispatch hyper-local “Just Sold” targeted social campaign.',
    left: 'Zero human reconciliation errors in Q3',
    right: 'Statutory Audit: 100% Pass',
  },
];

/**
 * The AI console, still a design mock.
 *
 * It used to name "Bondi Prestige Group" as the agency and rank it against
 * invented competitors with invented market share. That was not a placeholder
 * anyone could tell was a placeholder — it read as a real league table about a
 * real agency, and it was shown to whoever opened the page.
 *
 * The market panels below now say what they are: nothing is connected. The
 * rest of the screen is still a mock and is labelled as one at the top.
 */
/**
 * A Server Component. Everything on this screen is static mock markup except
 * the composer, which is a small client island of its own — see ai-composer.
 */
export function AiConsole({ agencyName }: { agencyName: string | null }) {
  return (
    <div className={styles.page} data-full-bleed style={{ padding: '1.5rem 2rem' }}>
      <div className={styles.head}>
        <div>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>LocalAgent AI Operating System</h1>
            <span className={styles.live}>
              <span style={{ width: 6, height: 6, borderRadius: 999, background: 'currentColor' }} />
              Autonomous v4.9 Active
            </span>
          </div>
          <p className={styles.sub}>
            Ingesting <strong>148 data points/sec</strong> · Agency Model:{' '}
            <strong>GPT-RealEstate-2030</strong> · Trust &amp; Privacy Guardrails Active (NSW Fair
            Trading &amp; REINSW Compliant)
          </p>
        </div>
        <div className={styles.telemetry}>
          <div className={styles.chipBox}>
            <div className={styles.chipLabel}>Latency</div>
            <div className={`${styles.chipVal} ${styles.chipGreen}`}>22ms Mesh</div>
          </div>
          <div className={styles.chipBox}>
            <div className={styles.chipLabel}>Active Vectors</div>
            <div className={styles.chipVal}>48,210 Off-Market</div>
          </div>
          <button type="button" className={styles.btnPrimary}>
            <span className={styles.glyphSm} aria-hidden>
              refresh
            </span>
            Sync Engine
          </button>
        </div>
      </div>

      <div className={styles.grid}>
        <div className={styles.stack}>
          <div className={styles.card}>
            <div className={styles.cardHead}>
              <h2 className={styles.cardTitle}>
                <span className={styles.glyphSm} style={{ color: 'var(--sapphire)' }} aria-hidden>
                  terminal
                </span>
                Autonomous Command Dispatch
              </h2>
              <div className={styles.winDots} aria-hidden>
                <span className={styles.winDot} />
                <span className={styles.winDot} />
                <span className={styles.winDot} />
              </div>
            </div>

            <div className={styles.thread}>
              <div className={styles.msg}>
                <div className={styles.avUser}>SJ</div>
                <div className={styles.bubbleUser}>
                  <div className={styles.msgMeta}>
                    <span className={styles.msgName}>Sarah Jenkins (Principal)</span>
                    <span className={styles.msgTime}>Today 08:41 AM</span>
                  </div>
                  <p className={styles.msgBody}>
                    Which listings have been on market &gt;21 days with below-average enquiry
                    velocity, and what are the recommended adjustments?
                  </p>
                </div>
              </div>

              <div className={styles.msg}>
                <div className={styles.avAi}>
                  <span className={styles.glyphSm} aria-hidden>
                    smart_toy
                  </span>
                </div>
                <div className={styles.bubbleAi}>
                  <div className={styles.msgMeta}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span className={styles.msgName} style={{ color: 'var(--sapphire)' }}>
                        LocalAgent Intelligence Engine
                      </span>
                      <span className={styles.tagBlue}>High Confidence 94%</span>
                    </div>
                    <span className={styles.msgTime}>0.38s execution</span>
                  </div>

                  <p className={styles.msgBody}>
                    Identified <strong style={{ color: '#e11d48' }}>2 listings</strong> exhibiting
                    stalled buyer momentum in the Eastern Suburbs portfolio:
                  </p>

                  <article className={styles.listing}>
                    <div className={styles.listingTop}>
                      <div className={styles.listingName}>14 Smith St, Bondi</div>
                      <span className={styles.tagAmber}>26 Days On Market</span>
                    </div>
                    <div className={styles.listingMeta}>
                      <span>
                        Guide: <strong>$3,450,000</strong>
                      </span>
                      <span className={styles.down}>
                        <span className={styles.glyphSm} aria-hidden>
                          trending_down
                        </span>
                        -18% enquiry velocity
                      </span>
                      <span>
                        Opens: <strong>11 total</strong>
                      </span>
                    </div>
                  </article>

                  <article className={styles.listing}>
                    <div className={styles.listingTop}>
                      <div className={styles.listingName}>92 Ocean Ave, Double Bay</div>
                      <span className={styles.tagRed}>24 Days On Market</span>
                    </div>
                    <div className={styles.listingMeta}>
                      <span>
                        Guide: <strong>$5,200,000</strong>
                      </span>
                      <span className={styles.down}>
                        <span className={styles.glyphSm} aria-hidden>
                          trending_down
                        </span>
                        -24% enquiry velocity
                      </span>
                      <span>
                        Opens: <strong>8 total</strong>
                      </span>
                    </div>
                  </article>

                  <div className={styles.diag}>
                    <div className={styles.diagLabel}>Submarket Banding Diagnostic</div>
                    Price guide is currently <strong style={{ color: '#e11d48' }}>6% above</strong>{' '}
                    suburb absorption bandwidth ($3.2M vs $3.0M equivalent sqm). 14 Smith St has
                    suffered from low click-through on digital portals due to daylight glare on
                    primary living hero shot.
                  </div>

                  <div>
                    <div
                      className={styles.diagLabel}
                      style={{ color: 'var(--text-primary)', display: 'flex', gap: 6, alignItems: 'center' }}
                    >
                      <span className={styles.glyphSm} style={{ color: 'var(--sapphire)' }} aria-hidden>
                        task_alt
                      </span>
                      Prescribed Strategic Adjustments
                    </div>
                    <ol className={styles.ol}>
                      <li>
                        Trigger <strong>$150,000 price realignment</strong> on realestate.com.au &amp;
                        Domain.
                      </li>
                      <li>Swap hero listing image to twilight terrace photo with high contrast vignette.</li>
                      <li>
                        Auto-dispatch segmented SMS/Email to{' '}
                        <span className={styles.linkish}>42 verified active buyers</span> with matching
                        criteria.
                      </li>
                    </ol>
                  </div>

                  <div className={styles.actionsRow}>
                    <button type="button" className={styles.btnPrimary}>
                      <span className={styles.glyphSm} aria-hidden>
                        bolt
                      </span>
                      Execute Adjustments on Both Listings
                    </button>
                    <button type="button" className={styles.btnGhost}>
                      <span className={styles.glyphSm} aria-hidden>
                        edit_note
                      </span>
                      Draft Vendor Strategy Briefing
                    </button>
                    <button type="button" className={styles.btnGhost}>
                      <span className={styles.glyphSm} aria-hidden>
                        event
                      </span>
                      Schedule Price Review Meeting
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <AiComposer />
          </div>

          <div className={styles.hero}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className={styles.heroImg} src="/stitch/ai-asset-0.jpg" alt="" />
            <div className={styles.heroOverlay}>
              <div className={styles.heroTag}>AI Suggested Hero Frame</div>
              <div style={{ fontWeight: 600, fontSize: 13 }}>
                Twilight Terrace Aspect (Projected +31% Engagement)
              </div>
            </div>
          </div>
        </div>

        <div className={styles.stack}>
          <div className={styles.card} style={{ padding: '1rem' }}>
            <div className={styles.marketHead} style={{ border: 'none', margin: 0, paddingBottom: 12 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    background: 'var(--sapphire-subtle)',
                    color: 'var(--sapphire)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <span className={styles.glyphSm} aria-hidden>
                    precision_manufacturing
                  </span>
                </div>
                <h3 className={styles.cardTitle} style={{ fontSize: '1rem' }}>
                  Automations In Production
                </h3>
              </div>
              <button type="button" className={styles.linkish} style={{ border: 'none', background: 'none', fontSize: 12 }}>
                View all
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {AUTOMATIONS.map((a) => (
                <article key={a.title} className={styles.autoCard}>
                  <div className={styles.autoTop}>
                    <div className={styles.autoTitle}>
                      <span
                        className={
                          a.tone === 'g' ? styles.dotG : a.tone === 'a' ? styles.dotA : styles.dotB
                        }
                      />
                      {a.title}
                    </div>
                    <span
                      className={
                        a.tone === 'g' ? styles.tagGreen : a.tone === 'a' ? styles.tagAmber : styles.tagBlue
                      }
                    >
                      {a.badge}
                    </span>
                  </div>
                  <p className={styles.autoBody}>{a.body}</p>
                  <div className={styles.autoFoot}>
                    <span>{a.left}</span>
                    <span>{a.right}</span>
                  </div>
                </article>
              ))}
            </div>
          </div>

          <div className={styles.card} style={{ padding: '1rem' }}>
            <div className={styles.marketHead}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    background: 'var(--emerald-subtle)',
                    color: 'var(--emerald)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <span className={styles.glyphSm} aria-hidden>
                    trending_up
                  </span>
                </div>
                <div>
                  <h3 className={styles.cardTitle} style={{ fontSize: '1rem' }}>
                    Market Temperature &amp; Predictive Yield Terminal
                  </h3>
                  <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-secondary)' }}>
                    Auction clearance, interest trends &amp; buyer flow forecast
                  </p>
                </div>
              </div>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Updated 4m ago</span>
            </div>

            <div className={styles.suburbGrid}>
              <div className={styles.suburb} style={{ gridColumn: '1 / -1' }}>
                <div className={styles.suburbTop}>
                  <span>No market data connected</span>
                </div>
                <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--text-secondary)' }}>
                  Suburb medians, clearance rates and competitor share need a data
                  feed this account does not have yet. Nothing invented is shown
                  here — {agencyName ? <strong>{agencyName}</strong> : 'your agency'} will
                  appear once one is connected.
                </p>
              </div>
            </div>
          </div>

          <div className={styles.finance}>
            <div>
              <div className={styles.financeLabel}>Forecasted Commission Closure</div>
              <div className={styles.financeVal}>$2,890,000 AUD</div>
              <div style={{ fontSize: 12, color: 'var(--emerald)', fontWeight: 600, marginTop: 4 }}>
                89% confidence · Statutory trust buffer $14.28M held
              </div>
            </div>
            <button type="button" className={styles.btnGhost} style={{ height: 40, padding: '0 1rem' }}>
              <span className={styles.glyphSm} aria-hidden>
                description
              </span>
              Run Ledger Reconciliation
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
