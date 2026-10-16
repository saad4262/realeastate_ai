import type { AgentActivityRow, AgentMessages, WidgetData } from '@repo/core/widgets';
import { formatValue } from './format';
import styles from './dashboards.module.css';

/**
 * The Agents widget (ADR 0034): every person with their emails and work, and
 * on the full page each person's emails. Figures came from SQL as the viewer;
 * subjects and snippets are other people's words and are drawn as text only.
 */
type AgentsData = Extract<WidgetData, { kind: 'agents' }>;

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  agent: 'Agent',
  assistant: 'Assistant',
  property_manager: 'Property manager',
  read_only: 'Read only',
};
const KIND_LABELS: Record<string, string> = { enquiry: 'Enquiry', inspection: 'Inspection', appraisal: 'Appraisal', offer: 'Offer', agency: 'Agency address' };

const n = (v: number) => formatValue('count', v);

/** A time on the agency's clock; the day too unless it is today there. */
function when(iso: string | null, timeZone: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const day = (x: Date) => new Intl.DateTimeFormat('en-AU', { timeZone, dateStyle: 'short' }).format(x);
  const withDay = day(d) !== day(new Date());
  return new Intl.DateTimeFormat('en-AU', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    ...(withDay ? { weekday: 'short', day: 'numeric', month: 'short' } : {}),
  }).format(d);
}

function roleOf(r: AgentActivityRow): string {
  if (r.userId === null) return 'Agency address, unassigned leads and platform mail';
  if (!r.current) return 'No longer in the agency';
  return r.role ? (ROLE_LABELS[r.role] ?? r.role) : '';
}

/** The tile: the totals and the busiest people. */
export function AgentsFigures({ data, compact }: { data: AgentsData; compact: boolean }) {
  const top = data.rows.slice(0, compact ? 4 : 8);
  return (
    <>
      <div className={styles.big}>{n(data.received)}</div>
      <div className={styles.sub}>
        received · {n(data.sent)} sent{data.failed ? ` · ${n(data.failed)} failed` : ''} · {n(data.people)} {data.people === 1 ? 'person' : 'people'}
      </div>
      {top.length ? (
        <table className={styles.miniTable}>
          <thead>
            <tr>
              <th scope="col">Person</th>
              <th scope="col">In</th>
              <th scope="col">Out</th>
            </tr>
          </thead>
          <tbody>
            {top.map((r) => (
              <tr key={r.userId ?? 'none'}>
                <td>{r.name}</td>
                <td>{n(r.received)}</td>
                <td>{n(r.sent)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className={styles.muted}>Nobody in the agency yet.</p>
      )}
      {data.rows.length > top.length ? <p className={styles.muted}>and {data.rows.length - top.length} more on the dashboard</p> : null}
    </>
  );
}

/** The full page: every person in a table, then each person's emails. */
export function AgentsSection({
  data,
  people,
  timeZone,
  inboxPath,
}: {
  data: AgentsData;
  people: AgentMessages[];
  timeZone: string;
  /** The inbox of the console this page is open on, for "open the conversation". */
  inboxPath: string;
}) {
  const byPerson = new Map(people.map((p) => [p.userId ?? 'none', p]));
  return (
    <>
      <div className={styles.card}>
        <h3 className={styles.cardTitle}>Everyone in the agency</h3>
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Received</th>
                <th scope="col">Sent</th>
                <th scope="col">Failed</th>
                <th scope="col" title="Conversations whose last word came in and has no emailed answer yet — now">Waiting for a reply</th>
                <th scope="col">New leads</th>
                <th scope="col">Appointments</th>
                <th scope="col" title="Live and under offer — now">Active listings</th>
                <th scope="col" title="Assigned to them — now">Contacts</th>
                <th scope="col">Latest email</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.userId ?? 'none'} className={r.userId === null || !r.current ? styles.rowQuiet : undefined}>
                  <th scope="row">
                    <div className={styles.person}>{r.name}</div>
                    <div className={styles.personSub}>{[roleOf(r), r.email, r.phone].filter(Boolean).join(' · ')}</div>
                  </th>
                  <td data-label="Received">{n(r.received)}</td>
                  <td data-label="Sent">{n(r.sent)}</td>
                  <td data-label="Failed">{r.failed ? <span className={styles.bad}>{n(r.failed)}</span> : '0'}</td>
                  <td data-label="Waiting for a reply">{n(r.awaitingReply)}</td>
                  <td data-label="New leads">{n(r.newLeads)}</td>
                  <td data-label="Appointments">{n(r.appointments)}</td>
                  <td data-label="Active listings">{r.userId ? n(r.activeListings) : '—'}</td>
                  <td data-label="Contacts">{r.userId ? n(r.contacts) : '—'}</td>
                  <td data-label="Latest email">{when(r.lastEmailAt, timeZone)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className={styles.people}>
        {data.rows.map((r) => {
          const p = byPerson.get(r.userId ?? 'none');
          const total = p?.total ?? 0;
          return (
            <details key={r.userId ?? 'none'} className={styles.personCard}>
              <summary>
                <span className={styles.person}>{r.name}</span>
                <span className={styles.personSub}>
                  {n(r.received)} received · {n(r.sent)} sent{r.failed ? ` · ${n(r.failed)} failed` : ''}
                </span>
              </summary>
              {p && p.messages.length ? (
                <ul className={styles.mailList}>
                  {p.messages.map((m) => (
                    <li key={m.id} className={styles.mailRow}>
                      <span className={m.direction === 'in' ? styles.mailIn : styles.mailOut} aria-label={m.direction === 'in' ? 'Received' : 'Sent'}>
                        {m.direction === 'in' ? '↓ In' : '↑ Out'}
                      </span>
                      <span className={styles.mailTime}>{when(m.at, timeZone)}</span>
                      <span className={styles.mailBody}>
                        <a href={`${inboxPath}?thread=${encodeURIComponent(m.threadId)}`} className={styles.mailSubject}>
                          {m.subject || '(no subject)'}
                        </a>
                        <span className={styles.mailMeta}>
                          {m.direction === 'in' ? 'From ' : 'To '}
                          {m.other || 'unknown'} · {KIND_LABELS[m.kind] ?? m.kind}
                          {m.status === 'failed' ? <span className={styles.bad}> · failed to send</span> : null}
                        </span>
                        {m.snippet ? <span className={styles.mailSnippet}>{m.snippet}</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.empty}>No emails in this period.</p>
              )}
              {total > (p?.messages.length ?? 0) ? (
                <p className={styles.muted}>
                  and {n(total - (p?.messages.length ?? 0))} more — <a href={inboxPath}>open the inbox</a>
                </p>
              ) : null}
            </details>
          );
        })}
      </div>
    </>
  );
}
