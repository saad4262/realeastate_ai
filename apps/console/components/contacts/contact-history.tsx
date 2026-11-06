import Link from 'next/link';
import { LocalTime } from '@repo/ui';
import {
  CALL_DIRECTION_LABELS,
  CALL_OUTCOME_LABELS,
  durationWords,
  SITE_HISTORY_PAGE_SIZE,
  type ContactCall,
  type ContactCalls,
  type ContactCounts,
  type ContactLeadSummary,
  type ContactSignals,
  type ContactTexts,
  type ContactView,
  type MatchingListing,
  type SiteHistory,
} from '@repo/core/contacts';
import { SmsComposer } from '@/components/phone/sms-composer';
import phoneStyles from '@/components/phone/phone.module.css';
import { EngagementChip, tabHref } from './contact-profile';
import { LogCallForm, SummaryButton } from './history-islands';
import styles from './contacts.module.css';

/**
 * The profile's channels and its smart panel (ADR 0083). Emails, SMS, Calls and Messages stay in their own tabs and none
 * lists another; Timeline alone mixes them. Server components; every list arrived scoped in packages/core, and every
 * figure is SQL's (#4). The summary is the only model-written text on the page, and it carries its label (#7).
 */

function Stat({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statNum}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  );
}

// ── Overview ───────────────────────────────────────────────────────────────

export function SmartOverview({
  contact: c,
  basePath,
  counts,
  openLeads,
  views,
  signals,
  matching,
  matchingTotal,
  webUrl,
}: {
  contact: ContactView;
  basePath: string;
  counts: ContactCounts;
  openLeads: number;
  views: number;
  signals: ContactSignals;
  matching: MatchingListing[];
  matchingTotal: number;
  webUrl: string;
}) {
  return (
    <>
      <div className={styles.statsWide}>
        <Stat value={counts.enquiries} label={`Leads (${openLeads} open)`} />
        <Stat value={counts.conversations} label="Emails" />
        <Stat value={counts.sms} label="SMS" />
        <Stat value={counts.calls} label="Calls" />
        <Stat value={views} label="Listing views, 30 days" />
        <Stat value={matchingTotal} label="Matching listings" />
      </div>
      <div className={styles.grid2}>
        <section className={styles.card} aria-label="What to do next">
          <div className={styles.section} style={{ borderTop: 0 }}>
            <h2 className={styles.sectionTitle}>What to do next</h2>
            <p className={styles.sub}>
              <EngagementChip engagement={signals.engagement} /> {signals.why}
            </p>
            {signals.nudges.length ? (
              <div>
                {signals.nudges.map((n) => (
                  <div key={n.key} className={styles.nudge}>
                    <span>{n.text}</span>
                    <Link href={tabHref(basePath, c.id, n.tab)} className={styles.back}>Open →</Link>
                  </div>
                ))}
              </div>
            ) : (
              <p className={styles.muted}>Nothing is waiting on you here.</p>
            )}
          </div>
          {matching.length ? (
            <div className={styles.section}>
              <h2 className={styles.sectionTitle}>Listings that fit their brief</h2>
              {matching.map((m) => (
                <div key={m.id} className={styles.nudge}>
                  <a href={`${webUrl}/listing/${m.id}`} target="_blank" rel="noreferrer">{m.address}</a>
                  <span className={styles.muted}>{m.price ?? 'Price not stated'}</span>
                </div>
              ))}
              {matchingTotal > matching.length ? <p className={styles.muted}>and {matchingTotal - matching.length} more.</p> : null}
            </div>
          ) : null}
        </section>
        <section className={styles.card} aria-label="Summary">
          <div className={styles.section} style={{ borderTop: 0 }}>
            <h2 className={styles.sectionTitle}>Summary</h2>
            {c.mayNote ? <SummaryButton contactId={c.id} /> : <p className={styles.muted}>You can view this contact but not ask for a summary.</p>}
          </div>
        </section>
      </div>
    </>
  );
}

// ── Leads ──────────────────────────────────────────────────────────────────

const SOURCE_WORD: Record<string, string> = { website: 'website', manual: 'added by hand', assistant: 'the assistant', import: 'import' };

export function LeadSummary({ summary: s }: { summary: ContactLeadSummary }) {
  if (!s.total) return null;
  const kinds = [
    [s.byKind.enquiry, 'enquiry', 'enquiries'],
    [s.byKind.inspection, 'inspection', 'inspections'],
    [s.byKind.appraisal, 'appraisal', 'appraisals'],
    [s.byKind.offer, 'private offer', 'private offers'],
  ] as const;
  return (
    <section aria-label="Leads summary" style={{ display: 'grid', gap: '0.5rem' }}>
      <div className={styles.statsWide}>
        <Stat value={s.total} label="Total leads" />
        <Stat value={s.new} label="New" />
        <Stat value={s.contacted} label="Contacted" />
        <Stat value={s.qualified} label="Qualified" />
        <Stat value={s.closed} label="Closed" />
        <Stat value={s.waiting} label="Open, no reply yet" />
        <Stat value={s.averageFirstReplySeconds === null ? '—' : durationWords(s.averageFirstReplySeconds)} label="Average first reply" />
        <Stat value={s.openDeals} label="Open deals" />
      </div>
      <p className={styles.sub}>
        {kinds.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`).join(' · ')}
        {s.bySource.length ? ` — from ${s.bySource.map((x) => `${SOURCE_WORD[x.source] ?? x.source} (${x.count})`).join(', ')}` : ''}
        {s.firstAt ? <> · first <LocalTime iso={s.firstAt.toISOString()} style="date" /></> : null}
        {s.latestAt ? <> · latest <LocalTime iso={s.latestAt.toISOString()} style="date" /></> : null}
      </p>
    </section>
  );
}

// ── SMS ────────────────────────────────────────────────────────────────────

export function SmsTab({
  contact: c,
  texts,
  canTextFromMyNumber,
  textsHref,
}: {
  contact: ContactView;
  texts: ContactTexts;
  /** The person has a number of their own: core asks `sms:send` again when they press Send. */
  canTextFromMyNumber: boolean;
  textsHref: string;
}) {
  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <div className={styles.statsWide}>
        <Stat value={texts.total} label="Texts" />
        <Stat value={texts.received} label="Received" />
        <Stat value={texts.sent} label="Sent" />
        <Stat value={texts.failed} label="Not delivered" />
      </div>
      {texts.conversations.length === 0 ? (
        <section className={`${styles.card} ${styles.empty}`}>
          <p className={styles.emptyTitle}>No texts you can see</p>
          <p className={styles.emptyHint}>Texts to and from {c.phone ?? 'their number'} land here. Owners and admins see every agent’s number; an agent sees their own.</p>
        </section>
      ) : (
        texts.conversations.map((conv) => (
          <section key={`${conv.phoneNumberId}|${conv.counterpart}`} className={styles.card} aria-label={`Texts on ${conv.agentName}’s number`}>
            <div className={styles.section} style={{ borderTop: 0 }}>
              <div className={styles.convHead}>
                <h2 className={styles.sectionTitle}>{conv.agentName}’s number · {conv.numberDisplay}</h2>
                <Link href={`${textsHref}?n=${conv.phoneNumberId}&with=${encodeURIComponent(conv.counterpart)}`} className={styles.back}>Open in Texts →</Link>
              </div>
              <div className={phoneStyles.bubbles}>
                {conv.messages.map((m) => (
                  <div key={m.id} className={`${phoneStyles.bubble} ${m.direction === 'in' ? phoneStyles.bubbleIn : phoneStyles.bubbleOut}`}>
                    {m.body}
                    <span className={phoneStyles.bubbleMeta}>
                      <LocalTime iso={m.at.toISOString()} style="short" />
                      {m.direction === 'out'
                        ? ` · ${m.kind ? 'Automatic' : (m.byName ?? 'sent')} · ${m.status === 'failed' || m.status === 'undelivered' ? `not delivered${m.error ? `: ${m.error}` : ''}` : m.status}`
                        : ''}
                    </span>
                  </div>
                ))}
              </div>
              {conv.optedOut ? <p className={styles.chipMissing}>Opted out: this number replied STOP, so nobody at the agency can text it.</p> : null}
            </div>
          </section>
        ))
      )}
      {c.phone && canTextFromMyNumber && c.mayNote ? (
        <section className={styles.card} aria-label="Write a text">
          <div className={styles.section} style={{ borderTop: 0 }}>
            <h2 className={styles.sectionTitle}>Text {c.name} from your number</h2>
            <SmsComposer to={c.phone} />
          </div>
        </section>
      ) : null}
    </div>
  );
}

// ── Calls ──────────────────────────────────────────────────────────────────

function CallRow({ call, missedCallsHref }: { call: ContactCall; missedCallsHref: string }) {
  if (call.source === 'logged') {
    return (
      <tr>
        <td><LocalTime iso={call.at.toISOString()} style="short" /></td>
        <td>{CALL_DIRECTION_LABELS[call.direction]}{call.minutes !== null ? `, ${call.minutes} min` : ''}</td>
        <td>
          <span className={styles.chip}>{CALL_OUTCOME_LABELS[call.outcome]}</span>
          {call.note ? <div className={styles.sub}>{call.note}</div> : null}
        </td>
        <td>{call.who ?? 'Former member'} · logged by hand</td>
      </tr>
    );
  }
  return (
    <tr>
      <td><LocalTime iso={call.at.toISOString()} style="short" /></td>
      <td>Incoming{call.from ? ` from ${call.from}` : ''}</td>
      <td>
        <span className={styles.chipWarm}>Missed</span>
        {call.outcome === 'texted' ? <span className={styles.muted}> Texted automatically</span> : null}
        {call.handled ? <span className={styles.muted}> Dealt with</span> : null}
        {call.aiStatus ? (
          <div className={styles.sub}>
            AI call back: {call.aiStatus}{call.aiDurationS !== null ? `, ${Math.max(Math.round(call.aiDurationS / 60), 1)} min` : ''}
            {call.aiSummary ? <> <span className={styles.chipAi}>Written by AI</span> {call.aiSummary}</> : null}
          </div>
        ) : null}
        <div><Link href={`${missedCallsHref}?call=${call.id}`} className={styles.back}>Details →</Link></div>
      </td>
      <td>{call.who}’s number</td>
    </tr>
  );
}

export function CallsTab({ contact: c, calls, missedCallsHref }: { contact: ContactView; calls: ContactCalls; missedCallsHref: string }) {
  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <div className={styles.statsWide}>
        <Stat value={calls.total} label="Calls" />
        <Stat value={calls.missed} label="Missed" />
        <Stat value={calls.aiCallBacks} label="AI call backs" />
        <Stat value={calls.logged} label="Logged by hand" />
        <Stat value={calls.lastAt ? <LocalTime iso={calls.lastAt.toISOString()} style="date" /> : '—'} label="Last call" />
      </div>
      <div className={styles.grid2}>
        <section className={styles.card} aria-label="Call history">
          {calls.rows.length === 0 ? (
            <div className={styles.empty}>
              <p className={styles.emptyTitle}>No calls yet</p>
              <p className={styles.emptyHint}>Missed calls and AI call backs arrive here by themselves once the agent’s number is connected.</p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className={styles.table}>
                <thead>
                  <tr><th>When</th><th>Call</th><th>Result</th><th>Who</th></tr>
                </thead>
                <tbody>
                  {calls.rows.map((r) => <CallRow key={`${r.source}-${r.id}`} call={r} missedCallsHref={missedCallsHref} />)}
                </tbody>
              </table>
            </div>
          )}
        </section>
        {c.mayNote ? (
          <section className={styles.card} aria-label="Log a call">
            <div className={styles.section} style={{ borderTop: 0 }}>
              <h2 className={styles.sectionTitle}>Log a call</h2>
              <LogCallForm contactId={c.id} />
              <p className={styles.sub}>A call answered on your own mobile never reaches the platform, so it is logged here by hand.</p>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

// ── Messages ───────────────────────────────────────────────────────────────

/** Built empty on purpose (ADR 0083 §1): nothing feeds it yet, and no data is invented. */
export function MessagesTab({ contact: c }: { contact: ContactView }) {
  return (
    <section className={`${styles.card} ${styles.empty}`}>
      <p className={styles.emptyTitle}>No messages yet</p>
      <p className={styles.emptyHint}>Direct messages with {c.name} will appear here once a messaging channel is connected. Emails and SMS have their own tabs and are never mixed in here.</p>
    </section>
  );
}

// ── Activity ───────────────────────────────────────────────────────────────

const HISTORY_WORD: Record<SiteHistory['rows'][number]['kind'], string> = { view: 'Viewed', search: 'Searched', saved: 'Saved' };

export function SiteHistoryTab({
  history: h,
  basePath,
  contactId,
  who,
  webUrl,
}: {
  history: SiteHistory;
  basePath: string;
  contactId: string;
  who: 'agency' | 'agent' | 'admin';
  webUrl: string;
}) {
  const scopeWords = who === 'agent' ? 'the listings you are named on, and searches in their suburbs' : 'this agency’s listings, and searches in suburbs where it has a live listing';
  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <div className={styles.statsWide}>
        <Stat value={h.views} label="Listing views" />
        <Stat value={h.listings} label="Listings opened" />
        <Stat value={h.searches} label="Searches" />
        <Stat value={h.saved} label="Saved" />
      </div>
      <p className={styles.sub}>
        Only {scopeWords}.{' '}
        {h.tie === 'confirmed' ? <span className={styles.chip}>Tied to their website account</span> : null}
        {h.tie === 'email' ? <span className={styles.chipMissing} title="Sign-up does not confirm an email, so this account may not be them.">Same email as a website account, not confirmed</span> : null}
      </p>
      <section className={styles.card} aria-label="Website activity">
        {h.tie === 'none' ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>No website account found</p>
            <p className={styles.emptyHint}>Their activity appears here once they sign in on the site with this email, or enquire from an account.</p>
          </div>
        ) : h.rows.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>Nothing yet</p>
            <p className={styles.emptyHint}>They have an account, but have not looked at any of these listings or searched these suburbs.</p>
          </div>
        ) : (
          <div className={styles.section} style={{ borderTop: 0 }}>
            <div>
              {h.rows.map((r) => (
                <div key={`${r.kind}-${r.id}`} className={styles.historyRow}>
                  <span className={styles.historyWhen}><LocalTime iso={r.at.toISOString()} style="short" /></span>
                  <span>
                    <span className={styles.chip}>{HISTORY_WORD[r.kind]}</span>{' '}
                    {r.listingId ? <a href={`${webUrl}/listing/${r.listingId}`} target="_blank" rel="noreferrer">{r.what}</a> : r.what}
                  </span>
                </div>
              ))}
            </div>
            {h.page > 1 || h.total > h.page * SITE_HISTORY_PAGE_SIZE ? (
              <div className={styles.inlineFields}>
                {h.page > 1 ? <Link href={tabHref(basePath, contactId, 'activity', { page: String(h.page - 1) })} className={styles.back}>← Newer</Link> : null}
                {h.total > h.page * SITE_HISTORY_PAGE_SIZE ? <Link href={tabHref(basePath, contactId, 'activity', { page: String(h.page + 1) })} className={styles.back}>Older →</Link> : null}
              </div>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}
