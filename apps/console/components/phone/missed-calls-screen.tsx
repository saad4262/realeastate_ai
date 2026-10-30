import Link from 'next/link';
import {
  getMissedCall,
  getMissedCallSettings,
  listMissedCalls,
  missedCallSkillSummary,
  AI_REASON_WORDS,
  OUTCOME_WORDS,
  PhoneError,
  type MissedCallDetail,
  type MissedCallRow,
} from '@repo/core/phone';
import contactStyles from '@/components/contacts/contacts.module.css';
import { getConsoleDb } from '../../lib/db';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { HandledButton, MissedCallSettingsForm } from './missed-call-controls';
import styles from './phone.module.css';

/**
 * Daily work → Missed calls (ADR 0071; mock `docs/mocks/missed-calls.html`). An agent sees the calls
 * they missed; owners and admins every agent's, and the settings. `?call=` opens one call's timeline.
 * Every figure is a count of rows core returned; nothing here is worked out by a model.
 */

const when = (d: Date) => d.toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function whatHappened(r: Pick<MissedCallRow, 'outcome' | 'textStatus' | 'replied' | 'handledAt'>): { icon: string; words: string; tone: string } {
  if (r.handledAt) return { icon: 'task_alt', words: 'Handled', tone: styles.ok! };
  if (r.replied) return { icon: 'chat', words: 'Replied by text · in Texts', tone: styles.ok! };
  if (r.outcome === 'texted') return { icon: 'sms', words: r.textStatus === 'failed' || r.textStatus === 'undelivered' ? 'Text not delivered' : 'Texted · waiting for a reply', tone: r.textStatus === 'failed' ? styles.bad! : '' };
  if (r.outcome === 'text_failed') return { icon: 'error', words: OUTCOME_WORDS.text_failed, tone: styles.bad! };
  if (r.outcome === 'skill_off') return { icon: 'toggle_off', words: 'Listed only: Missed call text is off', tone: '' };
  return { icon: 'block', words: r.outcome ? OUTCOME_WORDS[r.outcome] : 'Kept', tone: styles.warn! };
}

/** The AI call back's part of a row (ADR 0072), or null when there is nothing to say about it. */
function aiPart(r: Pick<MissedCallRow, 'aiStatus' | 'aiReason' | 'aiPriority' | 'aiDueAt'>): { words: string; tone: string } | null {
  switch (r.aiStatus) {
    case 'scheduled':
      return { words: `AI calls ${r.aiDueAt ? when(r.aiDueAt) : 'soon'}`, tone: '' };
    case 'calling':
      return { words: 'AI calling now', tone: '' };
    case 'done':
      return { words: `AI spoke to them${r.aiPriority ? ` · ${r.aiPriority[0]!.toUpperCase()}${r.aiPriority.slice(1)}` : ''}`, tone: r.aiPriority === 'high' ? styles.bad! : styles.ok! };
    case 'no_answer':
      return { words: 'AI: no answer', tone: styles.warn! };
    case 'failed':
      return { words: 'AI call failed', tone: styles.bad! };
    case 'skipped':
      return r.aiReason && r.aiReason !== 'skill_off' ? { words: `No AI call: ${AI_REASON_WORDS[r.aiReason]}`, tone: '' } : null;
    default:
      return null;
  }
}

export async function MissedCallsScreen({
  surface,
  searchParams,
  tab = 'calls',
}: {
  surface: 'agency' | 'agent';
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
  tab?: 'calls' | 'settings';
}) {
  const session = await requireConsoleAccess(surface);
  const db = getConsoleDb();
  const sp = (await searchParams) ?? {};
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const base = surface === 'agency' ? '/missed-calls' : '/my-missed-calls';
  const waitingOnly = first(sp.show) === 'waiting';

  const head = (
    <div className={contactStyles.headText}>
      <h1 className={contactStyles.title}>Missed calls</h1>
      <p className={contactStyles.sub}>
        {surface === 'agency'
          ? 'Calls your agents didn’t answer, forwarded to their Twilio numbers. A caller is texted only while Missed call text is on in Skills for the agency and that agent.'
          : 'Calls you didn’t answer, forwarded to your Twilio number. A caller is texted only while Missed call text is on in Skills for you and the agency.'}
      </p>
      {surface === 'agency' ? (
        <div className={styles.row} role="tablist">
          <Link href={base} role="tab" aria-selected={tab === 'calls'} className={tab === 'calls' ? styles.btnPrimary : styles.btn}>Calls</Link>
          <Link href={`${base}/settings`} role="tab" aria-selected={tab === 'settings'} className={tab === 'settings' ? styles.btnPrimary : styles.btn}>Settings</Link>
        </div>
      ) : null}
    </div>
  );

  if (tab === 'settings') {
    let settings: Awaited<ReturnType<typeof getMissedCallSettings>>;
    let summary: Awaited<ReturnType<typeof missedCallSkillSummary>>;
    try {
      [settings, summary] = await Promise.all([getMissedCallSettings(db, session.actor), missedCallSkillSummary(db, session.actor)]);
    } catch (err) {
      return <p role="alert">{err instanceof PhoneError ? err.message : 'Could not load the settings.'}</p>;
    }
    return (
      <div className={contactStyles.wrap}>
        {head}
        <section className={styles.step}>
          <h2 className={styles.stepTitle}>Switched on in Skills</h2>
          <p className={styles.muted}>Missed call text runs for an agent only when the agency and that agent have both switched it on.</p>
          <div className={styles.row}>
            <span className={`${styles.pill} ${summary.agencyOn ? styles.ok : ''}`}>Agency: {summary.agencyOn ? 'on' : 'off'}</span>
            <span>{summary.agentsOn} of {summary.agentsWithNumber} agents with a number get it</span>
            <Link href="/skills" className={styles.btn} style={{ marginLeft: 'auto' }}>Manage in Skills</Link>
          </div>
          {summary.offFor.length ? <p className={styles.muted}>Not texting for: {summary.offFor.join(', ')}. Their missed calls are only listed here.</p> : null}
        </section>
        <MissedCallSettingsForm
          initial={{
            greeting: settings.greeting,
            smsTemplate: settings.smsTemplate,
            textsPerAgentDay: settings.textsPerAgentDay,
            textsPerAgencyDay: settings.textsPerAgencyDay,
            aiCallAfterMinutes: settings.aiCallAfterMinutes,
            callingHours: settings.callingHours,
            aiCallsPerAgentDay: settings.aiCallsPerAgentDay,
            aiCallsPerAgencyDay: settings.aiCallsPerAgencyDay,
          }}
          canManage={settings.canManage}
          agencyName={settings.agencyName}
        />
      </div>
    );
  }

  const callId = first(sp.call);
  let detail: MissedCallDetail | null = null;
  let detailError: string | null = null;
  if (callId) {
    try {
      detail = await getMissedCall(db, session.actor, callId);
    } catch (err) {
      detailError = err instanceof PhoneError ? err.message : 'Could not open that call.';
    }
  }
  if (detail || detailError) {
    return (
      <div className={contactStyles.wrap}>
        <Link href={base} className={styles.btnLink}>← Missed calls</Link>
        {detailError ? <p role="alert">{detailError}</p> : detail ? <CallDetail d={detail} surface={surface} /> : null}
      </div>
    );
  }

  let list: Awaited<ReturnType<typeof listMissedCalls>>;
  try {
    list = await listMissedCalls(db, session.actor, { waitingOnly });
  } catch (err) {
    return <p role="alert">{err instanceof PhoneError ? err.message : 'Could not load missed calls.'}</p>;
  }
  return (
    <div className={contactStyles.wrap}>
      {head}
      <div className={styles.fields} aria-label="The last 7 days">
        {(
          [
            [list.counts.missed, 'Missed in 7 days'],
            [list.counts.texted, 'Got a text'],
            [list.counts.replied, 'Replied'],
            [list.counts.waiting, 'Not handled yet'],
          ] as const
        ).map(([n, label]) => (
          <div key={label} className={styles.step} style={{ gap: '0.15rem' }}>
            <b style={{ fontSize: '1.4rem' }}>{n}</b>
            <span className={styles.muted}>{label}</span>
          </div>
        ))}
      </div>
      <div className={styles.row}>
        <Link href={base} className={waitingOnly ? styles.btn : styles.btnPrimary}>All</Link>
        <Link href={`${base}?show=waiting`} className={waitingOnly ? styles.btnPrimary : styles.btn}>Not handled</Link>
      </div>
      <section className={styles.step} style={{ padding: 0 }}>
        {list.rows.length === 0 ? (
          <p className={styles.muted} style={{ padding: '1rem' }}>No missed calls{waitingOnly ? ' waiting' : ''} in the last 7 days.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr><th>Caller</th><th>When</th>{list.everyAgent ? <th>Agent</th> : null}<th>What happened</th></tr>
              </thead>
              <tbody>
                {list.rows.map((r) => {
                  const w = whatHappened(r);
                  return (
                    <tr key={r.id}>
                      <td>
                        <Link href={`${base}?call=${r.id}`} style={{ color: 'inherit', fontWeight: 600 }}>{r.contactName ?? (r.from ? 'New caller' : 'Private number')}</Link>
                        <div className={`${styles.muted} ${styles.mono}`}>{r.display}</div>
                      </td>
                      <td className={styles.mono}>{when(r.at)}</td>
                      {list.everyAgent ? <td>{r.agentName}</td> : null}
                      <td>
                        <div className={styles.row} style={{ gap: '0.35rem' }}>
                          <span className={`${styles.pill} ${w.tone}`}><span className={styles.glyph} style={{ fontSize: 14 }} aria-hidden>{w.icon}</span>{w.words}</span>
                          {(() => {
                            const a = aiPart(r);
                            return a ? <span className={`${styles.pill} ${a.tone}`}><span className={styles.glyph} style={{ fontSize: 14 }} aria-hidden>smart_toy</span>{a.words}</span> : null;
                          })()}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function CallDetail({ d, surface }: { d: MissedCallDetail; surface: 'agency' | 'agent' }) {
  const contactHref = d.contactId ? `${surface === 'agency' ? '/customers' : '/my-contacts'}/${d.contactId}` : null;
  return (
    <div className={styles.texts} style={{ gridTemplateColumns: 'minmax(0, 1fr) 18rem' }}>
      <section className={styles.step}>
        <div className={styles.stepHead}>
          <h1 className={styles.stepTitle} style={{ fontSize: '1.15rem' }}>{d.contactName ?? d.display}</h1>
          <span className={styles.muted}>{when(d.at)} · missed by {d.agentName}</span>
        </div>
        <ol className={styles.list} style={{ listStyle: 'none', padding: 0, gap: '0.6rem' }}>
          <li><b>{when(d.at)}</b> · Missed call to {d.agentName}’s mobile, forwarded to their Twilio number.</li>
          <li>{d.outcome === 'texted' || d.outcome === 'text_failed' ? 'Heard the greeting, then a text was sent.' : 'Heard: “Sorry, they can’t take your call right now. They’ll get back to you soon.”'}</li>
          {d.text ? (
            <li>
              <b>Text {d.text.status === 'failed' || d.text.status === 'undelivered' ? 'not delivered' : d.text.status}</b> · {when(d.text.at)}
              <div className={`${styles.bubble} ${styles.bubbleOut}`} style={{ marginTop: '0.35rem' }}>{d.text.body}</div>
              {d.text.error ? <p className={styles.muted}>{d.text.error}</p> : null}
            </li>
          ) : (
            <li className={styles.muted}>{d.outcome ? OUTCOME_WORDS[d.outcome] : 'Not texted.'}</li>
          )}
          {d.replies.map((r, i) => (
            <li key={i}>
              <b>Replied</b> · {when(r.at)}
              <div className={`${styles.bubble} ${styles.bubbleIn}`} style={{ marginTop: '0.35rem' }}>{r.body}</div>
            </li>
          ))}
          {d.aiStatus === 'scheduled' ? <li><b>AI call back</b> due {d.aiDueAt ? when(d.aiDueAt) : 'soon'}. It won’t call if the caller texts back or this is marked handled first.</li> : null}
          {d.aiStatus === 'skipped' && d.aiReason && d.aiReason !== 'skill_off' ? <li className={styles.muted}>No AI call back: {AI_REASON_WORDS[d.aiReason]}.</li> : null}
          {d.aiStatus && ['calling', 'done', 'no_answer', 'failed'].includes(d.aiStatus) ? (
            <li>
              <b>{d.aiStatus === 'done' ? 'The AI called back' : d.aiStatus === 'no_answer' ? 'The AI called back: no answer' : d.aiStatus === 'calling' ? 'The AI is calling' : 'The AI call failed'}</b>
              {d.ai.endedAt ? ` · ${when(d.ai.endedAt)}` : ''}
              {d.ai.durationS ? ` · ${Math.floor(d.ai.durationS / 60)} min ${d.ai.durationS % 60} s` : ''}
              {d.ai.recordingUrl ? (
                <>
                  {' · '}
                  <a href={d.ai.recordingUrl} target="_blank" rel="noreferrer">Listen to the recording</a>
                </>
              ) : null}
            </li>
          ) : null}
          {d.handledAt ? <li><b>Handled</b> by {d.handledByName ?? 'someone'} · {when(d.handledAt)}</li> : null}
        </ol>
        {d.ai.summary ? (
          <div className={`${styles.note} ${styles.noteOk}`} style={{ display: 'grid' }}>
            <b>
              What they said{d.aiPriority ? ` · ${d.aiPriority} priority` : ''}
              <span className={styles.muted} style={{ fontWeight: 400 }}> — written by the AI from the call; check it before you act</span>
            </b>
            <span>{d.ai.summary}</span>
          </div>
        ) : null}
        {d.ai.transcript ? (
          <details>
            <summary className={styles.btnLink}>Read the transcript</summary>
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: '0.8125rem', margin: '0.5rem 0 0' }}>{d.ai.transcript}</pre>
          </details>
        ) : null}
      </section>
      <aside className={styles.step}>
        <b>{d.contactName ?? 'New caller'}</b>
        <span className={styles.mono}>{d.display}</span>
        <div className={styles.steps} style={{ gap: '0.4rem' }}>
          {d.from ? <a className={styles.btnPrimary} href={`tel:${d.from}`}>Call {d.contactName?.split(' ')[0] ?? 'them'}</a> : null}
          {d.textsHref ? <Link className={styles.btn} href={d.textsHref}>Open the texts</Link> : null}
          {contactHref ? <Link className={styles.btn} href={contactHref}>Open contact</Link> : null}
          {d.canHandle ? <HandledButton callId={d.id} handled={Boolean(d.handledAt)} /> : null}
        </div>
      </aside>
    </div>
  );
}
