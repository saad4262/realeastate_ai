import { LocalTime } from '@repo/ui';
import { can } from '@repo/core/permissions';
import {
  AUTOMATION_LIBRARY,
  LIBRARY_GROUPS,
  LIBRARY_NEED_WORDS,
  likeThisOn,
  listWaitingDrafts,
  listWorkflows,
  NOT_SURE,
  TRIGGER_GROUPS,
  TRIGGER_GUIDE,
  TRIGGER_KINDS,
  WORKFLOW_LIMITS,
  workflowRuns,
  type LibraryGroup,
  type WorkflowRunView,
  type WorkflowSummary,
} from '@repo/core/workflows';
import Link from 'next/link';
import contactStyles from '@/components/contacts/contacts.module.css';
import { getConsoleDb } from '../../lib/db';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { PauseAllButton, WaitingDrafts, WorkflowButtons } from './islands';
import styles from './workflows.module.css';

const STEP_WORDS: Record<string, string> = {
  done: 'Done',
  failed: 'Could not be done',
  scheduled: 'Waiting for its time',
  blocked: 'Waiting for the step before',
  running: 'Running',
  cancelled: 'Stopped',
  proposed: 'Waiting',
};

/**
 * Workflows (ADR 0041 Part C) — the Automations tab of Skills (ADR 0058): `/skills?tab=automations` and
 * `/my-skills?tab=automations`; the old `/workflows` and `/my-workflows` redirect there.
 * What each person sees and may change is can()'s (`workflow:read`, `workflow:manage`), in packages/core.
 * Workflows are made and changed by asking the assistant; this page reads them in words, pauses,
 * resumes and archives them, shows their runs, and holds the drafts waiting for the person (D1).
 */
export async function WorkflowsPage({ surface, runsOf, lib }: { surface: 'agency' | 'agent'; runsOf?: string; lib?: LibraryGroup }) {
  const session = await requireConsoleAccess(surface);
  const db = getConsoleDb();
  const [workflows, drafts] = await Promise.all([listWorkflows(db, session.actor), listWaitingDrafts(db, session.actor)]);
  let runs: WorkflowRunView[] = [];
  if (runsOf && workflows.some((w) => w.id === runsOf)) runs = await workflowRuns(db, session.actor, runsOf);
  const base = `${surface === 'agency' ? '/skills' : '/my-skills'}?tab=automations`;
  const mayPauseAll = can(session.actor, 'workflow:create_agency', { type: 'workflow', agencyId: session.actor.agencyId as string });

  // ADR 0068, the user's decision 3: ready-made automations are for owners and admins, on the agency console.
  const showLibrary = surface === 'agency' && mayPauseAll;
  return (
    <>
      {showLibrary ? <Library workflows={workflows} lib={lib} base={base} /> : null}
      <div className={contactStyles.head}>
        <div className={contactStyles.headText}>
          <p className={contactStyles.sub}>
            When something happens, steps that run by themselves — as you, with your permissions checked each time. Ask the assistant to make one
            (“whenever a website enquiry comes in, remind me the next day”). An email the AI writes is never sent by a workflow: it waits here for you.
          </p>
        </div>
        {mayPauseAll && workflows.some((w) => w.status === 'active') ? <PauseAllButton /> : null}
      </div>

      <section className={contactStyles.card}>
        <div className={contactStyles.section} style={{ borderTop: 0 }} id="waiting">
          <h2 className={contactStyles.sectionTitle}>Waiting for you ({drafts.length})</h2>
          {drafts.length === 0 ? (
            <p className={contactStyles.note}>No drafts are waiting.</p>
          ) : (
            <WaitingDrafts ids={drafts.map((d) => d.id)} surface={surface} />
          )}
        </div>
      </section>

      <section className={contactStyles.card} style={{ marginTop: '1rem' }}>
        <div className={contactStyles.section} style={{ borderTop: 0 }}>
          <h2 className={contactStyles.sectionTitle}>Workflows</h2>
          {workflows.length === 0 ? (
            <p className={contactStyles.note}>None yet. Open the assistant and describe what should happen, and when.</p>
          ) : (
            <ul className={contactStyles.plainList}>
              {workflows.map((w) => (
                <li key={w.id} className={contactStyles.plainItem} style={{ alignItems: 'flex-start' }}>
                  <span style={{ display: 'grid', gap: '0.2rem' }}>
                    <strong>{w.name}</strong>
                    <span className={contactStyles.muted}>
                      {w.status === 'active' ? 'On' : `Paused${w.pausedReason ? ` — ${w.pausedReason}` : ''}`} ·{' '}
                      {w.scope === 'agency' ? 'the whole agency' : w.mine ? 'your own leads and contacts' : `${w.ownerName}’s own`} · {w.runsToday} run{w.runsToday === 1 ? '' : 's'} today
                    </span>
                    <span>{w.words.when}</span>
                    {w.words.if.map((c, i) => (
                      <span key={`if${i}`} className={contactStyles.muted}>{i === 0 ? 'If' : 'and'} {c}</span>
                    ))}
                    {w.words.decide ? (
                      <div className={styles.decide}>
                        <div className={styles.decideHead}>
                          <span className={styles.glyph} aria-hidden>psychology</span>
                          <span><b>The AI reads the enquiry and its latest email, and decides:</b> “{w.words.decide.question}”</span>
                        </div>
                        {[...w.words.decide.choices, { label: NOT_SURE, then: w.words.then }].map((c) => (
                          <div key={c.label} className={styles.branch}>
                            <span className={styles.label}>{c.label}</span>
                            <ol>{c.then.map((t, i) => <li key={i}>{t}</li>)}</ol>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <ol style={{ margin: '0.25rem 0 0', paddingLeft: '1.25rem' }}>
                        {w.words.then.map((t, i) => <li key={i}>{t}</li>)}
                      </ol>
                    )}
                    <a href={`${base}&runs=${w.id}#runs`} className={contactStyles.muted}>Its runs</a>
                  </span>
                  {w.mayManage && w.status !== 'archived' ? <WorkflowButtons id={w.id} status={w.status as 'active' | 'paused'} /> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <TriggerGuide />
      {runsOf ? (
        <section className={contactStyles.card} style={{ marginTop: '1rem' }} id="runs">
          <div className={contactStyles.section} style={{ borderTop: 0 }}>
            <h2 className={contactStyles.sectionTitle}>Runs of “{workflows.find((w) => w.id === runsOf)?.name ?? 'this workflow'}”</h2>
            {runs.length === 0 ? (
              <p className={contactStyles.note}>It has not run yet.</p>
            ) : (
              <ul className={contactStyles.plainList}>
                {runs.map((r) => (
                  <li key={r.id} className={contactStyles.plainItem} style={{ alignItems: 'flex-start' }}>
                    <span style={{ display: 'grid', gap: '0.15rem' }}>
                      <LocalTime iso={r.at.toISOString()} />
                      {r.decision ? (
                        <span className={styles.chose}>
                          <span className={styles.glyph} aria-hidden>{r.decision.by === 'ai' ? (r.decision.choice ? 'psychology' : 'help') : 'toggle_off'}</span>
                          {r.decision.by === 'ai' ? 'AI chose ' : null}
                          <span className={styles.label}>{r.decision.choice ?? NOT_SURE}</span>
                          {r.decision.reason ? ` — ${r.decision.reason}` : null}
                        </span>
                      ) : null}
                      {r.error ? <span className={contactStyles.muted}>{r.error}</span> : null}
                      {r.steps.map((s, i) => (
                        <span key={i} className={contactStyles.muted}>
                          {i + 1}. {s.title} — {STEP_WORDS[s.status] ?? s.status}
                          {s.error ? `: ${s.error}` : ''}
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      ) : null}
    </>
  );
}

/**
 * What can start a workflow (ADR 0066): every trigger in the catalog, in groups, each with something the
 * person might say to the assistant. Pure data from core; nothing here is a control.
 */
function TriggerGuide() {
  const fresh = TRIGGER_KINDS.filter((k) => TRIGGER_GUIDE[k].isNew).length;
  return (
    <section className={contactStyles.card} style={{ marginTop: '1rem' }} aria-labelledby="trigger-guide">
      <div className={contactStyles.section} style={{ borderTop: 0 }}>
        <h2 id="trigger-guide" className={contactStyles.sectionTitle}>
          What can start a workflow <span className={contactStyles.muted} style={{ fontWeight: 400 }}>· {TRIGGER_KINDS.length} triggers, {fresh} new</span>
        </h2>
        <p className={contactStyles.note}>Say it to the assistant in your own words — the line in purple is an example.</p>
        <div className={styles.groups}>
          {TRIGGER_GROUPS.map((g) => {
            const kinds = TRIGGER_KINDS.filter((k) => TRIGGER_GUIDE[k].group === g);
            return (
              <div key={g} className={styles.group}>
                <h3 className={styles.groupTitle}>
                  {g}
                  {kinds.every((k) => TRIGGER_GUIDE[k].isNew) ? <span className={styles.new}>NEW</span> : null}
                </h3>
                {kinds.map((k) => {
                  const t = TRIGGER_GUIDE[k];
                  return (
                    <div key={k} className={styles.trig}>
                      <span className={`${styles.ico} ${t.isNew ? styles.icoNew : ''}`}>
                        <span className={styles.glyph} aria-hidden>{t.icon}</span>
                      </span>
                      <div>
                        <b>{t.title}</b>
                        {t.isNew ? <span className={styles.new}>NEW</span> : null}
                        <p>{t.description}</p>
                        {t.example ? <p className={styles.ask}>“{t.example}”</p> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        <p className={contactStyles.note} style={{ marginTop: '0.75rem' }}>
          Same rules for every trigger: an approved template is sent by itself only if the person may receive it then (consent, opt-out, limits); an
          email the AI writes always waits for you; a personal workflow acts only on your own records; {WORKFLOW_LIMITS.runsPerDay} runs a day at most.
        </p>
      </div>
    </section>
  );
}

/**
 * The Automation Library (ADR 0068, docs/mocks/automation-library.html): ready-made automations, each opening
 * the assistant with its words in the box — never sent until the person presses Send, never on until they
 * approve the card. "N like this on" counts the agency's active workflows on the same trigger.
 */
function Library({ workflows, lib, base }: { workflows: WorkflowSummary[]; lib?: LibraryGroup; base: string }) {
  const shown = AUTOMATION_LIBRARY.filter((e) => !lib || e.group === lib);
  const chip = (g: LibraryGroup | null) => (g ? `${base}&lib=${encodeURIComponent(g)}#library` : `${base}#library`);
  return (
    <section className={contactStyles.card} style={{ marginBottom: '1rem' }} aria-labelledby="library" id="library">
      <div className={contactStyles.section} style={{ borderTop: 0 }}>
        <h2 id="library" className={contactStyles.sectionTitle}>
          Automation Library <span className={contactStyles.muted} style={{ fontWeight: 400 }}>· {AUTOMATION_LIBRARY.length} ready-made, for the whole agency</span>
        </h2>
        <p className={contactStyles.note}>
          Pick one and the assistant sets it up with you — it asks which template, who and when, shows you the card, and it starts only when you approve.
        </p>
        <nav className={styles.libChips} aria-label="Library groups">
          <Link href={chip(null)} className={`${styles.libChip} ${!lib ? styles.libChipOn : ''}`} aria-current={!lib ? 'page' : undefined}>All</Link>
          {LIBRARY_GROUPS.map((g) => (
            <Link key={g} href={chip(g)} className={`${styles.libChip} ${lib === g ? styles.libChipOn : ''}`} aria-current={lib === g ? 'page' : undefined}>{g}</Link>
          ))}
        </nav>
        <div className={styles.lib}>
          {shown.map((e) => {
            const on = likeThisOn(e, workflows);
            return (
              <article key={e.id} className={styles.tpl}>
                <div className={styles.tplHead}>
                  <span className={`${styles.ico} ${e.decides ? styles.icoAi : styles.icoNew}`}><span className={styles.glyph} aria-hidden>{e.icon}</span></span>
                  <div>
                    <b>{e.title}</b>
                    {e.decides ? <span className={styles.new}>AI</span> : null}
                    <p>{e.summary}</p>
                  </div>
                </div>
                <ul className={styles.tplList}>
                  <li><b>When</b> {e.when}</li>
                  <li><b>{e.decides ? 'AI decides' : 'Then'}</b> {e.decides ? e.then.replace(/^the AI decides /, '') : e.then}</li>
                </ul>
                <div className={styles.tplFoot}>
                  {e.needs.map((n) => <span key={n} className={styles.need}>{LIBRARY_NEED_WORDS[n]}</span>)}
                  {on ? <span className={styles.onCount}>{on} like this on</span> : null}
                  <Link href={`/overview?ask=${encodeURIComponent(e.ask)}`} className={contactStyles.btn} style={{ marginLeft: 'auto' }}>Use this</Link>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
