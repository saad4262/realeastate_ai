import Link from 'next/link';
import { LocalTime } from '@repo/ui';
import {
  CC_LEVEL_WORDS,
  CC_RANGES,
  CC_SOURCES,
  CC_SOURCE_WORDS,
  controlCentreActivity,
  controlCentreQuerySchema,
  type CcResult,
  type ControlCentreQuery,
  type ControlCentreRow,
} from '@repo/core/control-centre';
import contactStyles from '@/components/contacts/contacts.module.css';
import styles from '@/components/phone/phone.module.css';
import { getConsoleDb } from '../../lib/db';
import { requireConsoleAccess } from '../../lib/require-console-access';

/**
 * Automation → Control Centre (ADR 0091 part A; mock `docs/mocks/control-centre.html`): everything the
 * automations did by themselves. An agent sees their own; owners and admins every agent's. Every figure
 * is counted in core from the rows; the state is the URL.
 */

const RANGE_WORDS: Record<ControlCentreQuery['range'], string> = { '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days' };
const RESULT: Record<CcResult, { words: string; icon: string; tone: string }> = {
  ok: { words: 'Done', icon: 'check', tone: styles.ok! },
  running: { words: 'Running', icon: 'progress_activity', tone: '' },
  wait: { words: 'Waiting for approval', icon: 'hourglass_top', tone: styles.warn! },
  skip: { words: 'Skipped', icon: 'block', tone: '' },
  bad: { words: 'Failed', icon: 'error', tone: styles.bad! },
};
const SOURCE_ICON: Record<ControlCentreRow['source'], string> = { workflow: 'account_tree', automation: 'repeat', phone: 'phone_missed', opportunity: 'lightbulb', skill: 'auto_awesome' };

export async function ControlCentreScreen({ surface, searchParams }: { surface: 'agency' | 'agent'; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireConsoleAccess(surface);
  const sp = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const q = controlCentreQuerySchema.parse(Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, first(v)])));
  const base = surface === 'agency' ? '/control-centre' : '/my-control-centre';
  const missedCalls = surface === 'agency' ? '/missed-calls' : '/my-missed-calls';

  /** The URL for this view with some filters changed. A changed filter starts again at page 1. */
  const href = (change: Partial<ControlCentreQuery>) => {
    const next = { ...q, page: 1, ...change };
    const p = new URLSearchParams();
    if (next.range !== '24h') p.set('range', next.range);
    if (next.source !== 'all') p.set('source', next.source);
    if (next.result !== 'all') p.set('result', next.result);
    if (next.who) p.set('who', next.who);
    if (next.page > 1) p.set('page', String(next.page));
    const s = p.toString();
    return s ? `${base}?${s}` : base;
  };
  const chip = (on: boolean) => (on ? styles.btnPrimary : styles.btn);

  let data: Awaited<ReturnType<typeof controlCentreActivity>>;
  try {
    data = await controlCentreActivity(getConsoleDb(), session.actor, q);
  } catch {
    return <p role="alert">Could not load the Control Centre.</p>;
  }
  if (!data) return <p role="alert">The Control Centre is not available to you.</p>;

  const tiles = [
    { n: data.tiles.ran, label: 'ran by themselves', result: 'ok' as const },
    { n: data.tiles.tasks, label: 'tasks and reminders made', result: null },
    { n: data.tiles.sent, label: 'emails and texts sent', result: null },
    { n: data.tiles.opportunities, label: 'opportunities found', result: null },
    { n: data.tiles.waiting, label: 'waiting for approval', result: 'wait' as const },
    { n: data.tiles.failed, label: 'failed or skipped', result: 'bad' as const },
  ];
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));

  return (
    <div className={contactStyles.wrap}>
      <div className={contactStyles.headText}>
        <h1 className={contactStyles.title}>Control Centre</h1>
        <p className={contactStyles.sub}>
          {surface === 'agency'
            ? 'Everything the agency’s automations did by themselves, what is waiting for someone, and what went wrong.'
            : 'Everything your automations did by themselves, what is waiting for you, and what went wrong.'}
        </p>
      </div>

      <div className={styles.row} aria-label="Period">
        {CC_RANGES.map((r) => (
          <Link key={r} href={href({ range: r })} className={chip(q.range === r)} aria-current={q.range === r ? 'true' : undefined}>{RANGE_WORDS[r]}</Link>
        ))}
      </div>

      <div className={styles.fields} aria-label={RANGE_WORDS[q.range]}>
        {tiles.map((t) => {
          const body = (
            <>
              <b style={{ fontSize: '1.4rem' }}>{t.n}</b>
              <span className={styles.muted}>{t.label}</span>
            </>
          );
          return t.result ? (
            <Link key={t.label} href={href({ result: q.result === t.result ? 'all' : t.result })} className={styles.step} style={{ gap: '0.15rem', textDecoration: 'none', color: 'inherit', outline: q.result === t.result ? '2px solid var(--text-primary)' : undefined }} aria-pressed={q.result === t.result}>
              {body}
            </Link>
          ) : (
            <div key={t.label} className={styles.step} style={{ gap: '0.15rem' }}>{body}</div>
          );
        })}
      </div>

      <div className={styles.row} aria-label="Show">
        <Link href={href({ source: 'all' })} className={chip(q.source === 'all')}>Everything</Link>
        {CC_SOURCES.map((s) => (
          <Link key={s} href={href({ source: s })} className={chip(q.source === s)}>{CC_SOURCE_WORDS[s]}</Link>
        ))}
      </div>

      {data.people && data.people.length > 1 ? (
        <div className={styles.row} aria-label="Whose">
          <Link href={href({ who: undefined })} className={chip(!q.who)}>Everyone</Link>
          {data.people.map((p) => (
            <Link key={p.id} href={href({ who: p.id })} className={chip(q.who === p.id)}>{p.name}</Link>
          ))}
        </div>
      ) : null}

      <section className={styles.step} style={{ padding: 0 }}>
        {data.rows.length === 0 ? (
          <p className={styles.muted} style={{ padding: '1rem' }}>Nothing here for this filter in the {RANGE_WORDS[q.range].toLowerCase()}.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr><th>Time</th><th>What happened</th><th>From</th><th>Level</th><th>Result</th></tr>
              </thead>
              <tbody>
                {data.rows.map((r) => {
                  const res = RESULT[r.result];
                  const title = r.source === 'phone' ? <Link href={`${missedCalls}?call=${r.id}`} style={{ color: 'inherit' }}>{r.what}</Link> : r.what;
                  return (
                    <tr key={r.key}>
                      <td className={styles.mono} style={{ whiteSpace: 'nowrap' }}><time dateTime={r.at}><LocalTime iso={r.at} style="short" /></time></td>
                      <td>
                        <b>{title}</b>
                        {r.ai ? <span className={styles.pill} style={{ marginLeft: 6 }}>AI</span> : null}
                        {r.sub || r.owner ? <div className={styles.muted}>{[r.sub, r.owner].filter(Boolean).join(' · ')}</div> : null}
                      </td>
                      <td><span className={styles.row} style={{ gap: '0.3rem', flexWrap: 'nowrap' }}><span className={styles.glyph} style={{ fontSize: 16 }} aria-hidden>{SOURCE_ICON[r.source]}</span>{CC_SOURCE_WORDS[r.source]}</span></td>
                      <td><span className={`${styles.pill} ${r.level === 'auto' ? styles.ok : styles.warn}`}>{CC_LEVEL_WORDS[r.level]}</span></td>
                      <td>
                        <span className={`${styles.pill} ${res.tone}`}><span className={styles.glyph} style={{ fontSize: 14 }} aria-hidden>{res.icon}</span>{res.words}</span>
                        {r.note ? <div className={styles.muted} style={{ marginTop: 4 }}>{r.note}</div> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {pages > 1 ? (
        <div className={styles.row}>
          {q.page > 1 ? <Link href={href({ ...q, page: q.page - 1 })} className={styles.btn}>Newer</Link> : null}
          <span className={styles.muted}>Page {q.page} of {pages}</span>
          {q.page < pages ? <Link href={href({ ...q, page: q.page + 1 })} className={styles.btn}>Older</Link> : null}
        </div>
      ) : null}
      <p className={styles.muted}>Counts and the list come from the database. Workflow runs are kept 90 days.</p>
    </div>
  );
}
