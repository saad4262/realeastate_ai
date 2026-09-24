import styles from './overview.module.css';

const KPIS = [
  {
    label: 'Active Listings',
    delta: '↑ 8.4% MoM',
    deltaTone: 'up' as const,
    value: '42',
    hint: 'Avg DOM: 21d',
    bar: 72,
    barTone: 'blue' as const,
  },
  {
    label: 'Under Offer / Exchanged',
    delta: '14 Pending',
    deltaTone: 'amber' as const,
    value: '14',
    hint: '$48.2M AUD vol',
    bar: 58,
    barTone: 'amber' as const,
  },
  {
    label: 'Unconditional Sold (MTD)',
    delta: '↑ 14.1%',
    deltaTone: 'up' as const,
    value: '19',
    hint: '$64.8M AUD',
    bar: null,
    barTone: 'blue' as const,
  },
  {
    label: 'High-Intent Leads',
    delta: '94% AI-Qual',
    deltaTone: 'blue' as const,
    value: '128',
    hint: '8 Urgent',
    bar: 88,
    barTone: 'green' as const,
  },
  {
    label: 'Avg Response Velocity',
    delta: 'Top 1% REINSW',
    deltaTone: 'up' as const,
    value: '4.2 min',
    hint: 'Sydney avg: 48 mins',
    bar: null,
    barTone: 'blue' as const,
  },
  {
    label: 'Trust Accrual',
    delta: '99.8% Balanced',
    deltaTone: 'up' as const,
    value: '$1.84M',
    hint: 'Audited Statutory Trust',
    bar: null,
    barTone: 'green' as const,
  },
];

const RECS = [
  {
    tag: 'Price Strategy Alert',
    tagTone: 'amber' as const,
    suburb: 'Point Piper',
    title: '14 Wolseley Crescent, Point Piper',
    body: 'Comparable off-market absorption indicates listing is 4.5% below optimal clearing price. Adjust guide to $8.2M – $8.6M AUD prior to Saturday twilight.',
    cta: 'Adjust Guide & Notify 34 Buyers',
    icon: 'send',
    primary: true,
  },
  {
    tag: 'Lead Heatmap Surge',
    tagTone: 'blue' as const,
    suburb: 'Double Bay',
    title: '4 Bellevue Terrace, Double Bay',
    body: '9 verified overseas buyers viewed the digital twin in the last 24h. 3 HNW buyers ready for private digital contracts.',
    cta: 'Trigger Private Offer Room',
    icon: 'lock',
    primary: false,
  },
  {
    tag: 'Agent Velocity',
    tagTone: 'green' as const,
    suburb: 'Paddington',
    title: 'Sophie Clarke · 4 Sales in 12 Days',
    body: '100% clearance this month. 2 prestige Paddington vendor leads ($5.2M combined GAV) sit unallocated in triage.',
    cta: 'Route Leads to Sophie',
    icon: 'call_split',
    primary: false,
  },
];

const PIPELINE = [
  {
    address: '12 Fairfax Road',
    suburb: 'Bellevue Hill',
    status: 'Auction',
    event: 'Sat 18 Oct · 11:00',
    turnout: '48 RSVP',
    engagement: 'High',
    guide: '$6.8M – $7.2M',
  },
  {
    address: '4 Bellevue Terrace',
    suburb: 'Double Bay',
    status: 'Private Treaty',
    event: 'Offers due Fri',
    turnout: '—',
    engagement: 'Surge',
    guide: '$4.2M – $4.5M',
  },
  {
    address: '88 Ocean Street',
    suburb: 'Woollahra',
    status: 'Under Offer',
    event: 'Exchange pending',
    turnout: '—',
    engagement: 'Hot',
    guide: '$5.1M',
  },
  {
    address: '14 Wolseley Crescent',
    suburb: 'Point Piper',
    status: 'Auction',
    event: 'Sat 25 Oct · 10:30',
    turnout: '22 RSVP',
    engagement: 'Watch',
    guide: '$8.0M – $8.4M',
  },
];

export default function AgencyOverviewPage() {
  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.greeting}>
            Good morning, Sarah.
            <span className={styles.license}>
              <span style={{ width: 6, height: 6, borderRadius: 999, background: 'currentColor' }} />
              License #2049182 Active
            </span>
          </h1>
          <p className={styles.sub}>
            Tuesday, 14 October · Sydney Eastern Suburbs Network · All Systems Nominal
          </p>
        </div>
        <div className={styles.headerActions}>
          <button type="button" className={styles.btnGhost}>
            <span className={styles.glyphSm} aria-hidden>
              file_download
            </span>
            Export REINSW Board Pack
          </button>
          <button type="button" className={styles.btnPrimary}>
            <span className={styles.glyphSm} aria-hidden>
              add
            </span>
            New Exclusive Authority
          </button>
        </div>
      </div>

      <section className={styles.briefing} aria-label="AI executive briefing">
        <div className={styles.briefingAccent} />
        <div className={styles.briefingInner}>
          <div>
            <div className={styles.briefingTag}>
              <span className={styles.glyphSm} aria-hidden>
                smart_toy
              </span>
              LocalAgent AI Briefing Engine v4.2
              <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                · Generated 07:15 AEST
              </span>
            </div>
            <p className={styles.briefingText}>
              Your agency generated <strong>18 qualified leads</strong> yesterday (
              <span style={{ color: 'var(--emerald)', fontWeight: 600 }}>+24%</span> vs 4-wk avg).{' '}
              <strong>3 premium listings</strong> in Bellevue Hill &amp; Double Bay show{' '}
              <span style={{ color: 'var(--sapphire)', fontWeight: 600 }}>3.4× buyer velocity</span>.
              Agent Daniel Vance has{' '}
              <span style={{ color: '#d97706', fontWeight: 600 }}>2 overdue contract responses</span>.
              Estimated gross pipeline commission:{' '}
              <strong>$1,420,000 AUD</strong> across 11 pending exchanges.
            </p>
          </div>
          <div className={styles.briefingActions}>
            <button type="button" className={`${styles.briefingBtn} ${styles.briefingBtnPrimary}`}>
              <span>Execute Price Repositioning (2)</span>
              <span className={styles.glyphSm} aria-hidden>
                arrow_forward
              </span>
            </button>
            <button type="button" className={styles.briefingBtn}>
              <span>Auto-assign 8 Vaucluse Buyers</span>
              <span className={styles.glyphSm} aria-hidden>
                arrow_forward
              </span>
            </button>
            <button type="button" className={styles.briefingBtn}>
              <span>Review Daily Briefing PDF</span>
              <span className={styles.glyphSm} aria-hidden>
                open_in_new
              </span>
            </button>
          </div>
        </div>
      </section>

      <div className={styles.kpiGrid}>
        {KPIS.map((k) => (
          <div key={k.label} className={styles.kpi}>
            <div className={styles.kpiLabel}>
              <span>{k.label}</span>
              <span
                className={`${styles.kpiDelta} ${
                  k.deltaTone === 'up'
                    ? styles.kpiUp
                    : k.deltaTone === 'amber'
                      ? styles.kpiAmber
                      : styles.kpiBlue
                }`}
              >
                {k.delta}
              </span>
            </div>
            <div className={styles.kpiValue}>
              <span className={styles.kpiNum}>{k.value}</span>
              <span className={styles.kpiHint}>{k.hint}</span>
            </div>
            {k.bar != null ? (
              <div className={styles.bar}>
                <div
                  className={`${styles.barFill} ${
                    k.barTone === 'amber'
                      ? styles.barFillAmber
                      : k.barTone === 'green'
                        ? styles.barFillGreen
                        : ''
                  }`}
                  style={{ width: `${k.bar}%` }}
                />
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <section>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>
            <span className={styles.glyph} style={{ color: 'var(--sapphire)' }} aria-hidden>
              bolt
            </span>
            AI Proactive Recommendation Engine
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: '2px 8px',
                borderRadius: 999,
                background: 'var(--sapphire-subtle)',
                color: 'var(--sapphire)',
              }}
            >
              3 Actions Ready
            </span>
          </h2>
          <span className={styles.sectionMeta}>Sydney MLS &amp; off-market absorption</span>
        </div>
        <div className={styles.recGrid}>
          {RECS.map((r) => (
            <article key={r.title} className={styles.recCard}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span
                    className={`${styles.recTag} ${
                      r.tagTone === 'amber'
                        ? styles.tagAmber
                        : r.tagTone === 'green'
                          ? styles.tagGreen
                          : styles.tagBlue
                    }`}
                  >
                    {r.tag}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.suburb}</span>
                </div>
                <h3 className={styles.recTitle}>{r.title}</h3>
                <p className={styles.recBody}>{r.body}</p>
              </div>
              <button
                type="button"
                className={styles.recAction}
                style={
                  r.primary
                    ? { background: 'var(--text-primary)', color: '#fff', borderColor: 'var(--text-primary)' }
                    : r.tagTone === 'blue'
                      ? {
                          background: 'var(--sapphire-subtle)',
                          color: 'var(--sapphire)',
                          borderColor: 'color-mix(in srgb, var(--sapphire) 20%, transparent)',
                        }
                      : undefined
                }
              >
                {r.cta}
                <span className={styles.glyphSm} aria-hidden>
                  {r.icon}
                </span>
              </button>
            </article>
          ))}
        </div>
      </section>

      <section
        style={{
          background: 'var(--surface-elevated)',
          border: '1px solid var(--border-default)',
          borderRadius: 12,
          overflow: 'hidden',
          boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
        }}
      >
        <div
          style={{
            padding: '1rem',
            borderBottom: '1px solid var(--border-default)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <h2 className={styles.sectionTitle} style={{ margin: 0 }}>
            Live Listing &amp; Pipeline Velocity
            <span
              style={{
                fontSize: 11,
                fontWeight: 500,
                padding: '2px 8px',
                borderRadius: 4,
                border: '1px solid var(--border-default)',
                background: 'var(--surface-canvas)',
                color: 'var(--text-secondary)',
              }}
            >
              42 Total
            </span>
          </h2>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 13,
              textAlign: 'left',
            }}
          >
            <thead>
              <tr style={{ background: 'var(--surface-canvas)', color: 'var(--text-secondary)', fontSize: 11 }}>
                <th style={{ padding: '10px 16px', fontWeight: 600 }}>Property / Suburb</th>
                <th style={{ padding: '10px 8px', fontWeight: 600 }}>Status</th>
                <th style={{ padding: '10px 8px', fontWeight: 600 }}>Event / Date</th>
                <th style={{ padding: '10px 8px', fontWeight: 600 }}>Turnout</th>
                <th style={{ padding: '10px 8px', fontWeight: 600 }}>Engagement</th>
                <th style={{ padding: '10px 16px', fontWeight: 600, textAlign: 'right' }}>Guide</th>
              </tr>
            </thead>
            <tbody>
              {PIPELINE.map((row) => (
                <tr key={row.address} style={{ borderTop: '1px solid var(--border-default)' }}>
                  <td style={{ padding: '12px 16px' }}>
                    <div style={{ fontWeight: 600 }}>{row.address}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{row.suburb}</div>
                  </td>
                  <td style={{ padding: '12px 8px' }}>{row.status}</td>
                  <td style={{ padding: '12px 8px', color: 'var(--text-secondary)' }}>{row.event}</td>
                  <td style={{ padding: '12px 8px' }}>{row.turnout}</td>
                  <td style={{ padding: '12px 8px' }}>{row.engagement}</td>
                  <td
                    style={{
                      padding: '12px 16px',
                      textAlign: 'right',
                      fontVariantNumeric: 'tabular-nums',
                      fontWeight: 600,
                    }}
                  >
                    {row.guide}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
