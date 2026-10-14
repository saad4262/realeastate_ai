import { LocalTime } from '@repo/ui';
import { can } from '@repo/core/permissions';
import { listWaitingDrafts, listWorkflows, workflowRuns, type WorkflowRunView } from '@repo/core/workflows';
import contactStyles from '@/components/contacts/contacts.module.css';
import { getConsoleDb } from '../../lib/db';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { PauseAllButton, WaitingDrafts, WorkflowButtons } from './islands';

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
 * Workflows (ADR 0041 Part C) — shared by the agency's `/workflows` and the agent's `/my-workflows`.
 * What each person sees and may change is can()'s (`workflow:read`, `workflow:manage`), in packages/core.
 * Workflows are made and changed by asking the assistant; this page reads them in words, pauses,
 * resumes and archives them, shows their runs, and holds the drafts waiting for the person (D1).
 */
export async function WorkflowsPage({ surface, runsOf }: { surface: 'agency' | 'agent'; runsOf?: string }) {
  const session = await requireConsoleAccess(surface);
  const db = getConsoleDb();
  const [workflows, drafts] = await Promise.all([listWorkflows(db, session.actor), listWaitingDrafts(db, session.actor)]);
  let runs: WorkflowRunView[] = [];
  if (runsOf && workflows.some((w) => w.id === runsOf)) runs = await workflowRuns(db, session.actor, runsOf);
  const base = surface === 'agency' ? '/workflows' : '/my-workflows';
  const mayPauseAll = can(session.actor, 'workflow:create_agency', { type: 'workflow', agencyId: session.actor.agencyId as string });

  return (
    <div className={contactStyles.wrap}>
      <div className={contactStyles.head}>
        <div className={contactStyles.headText}>
          <h1 className={contactStyles.title}>{surface === 'agency' ? 'Workflows' : 'My workflows'}</h1>
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
                    <ol style={{ margin: '0.25rem 0 0', paddingLeft: '1.25rem' }}>
                      {w.words.then.map((t, i) => <li key={i}>{t}</li>)}
                    </ol>
                    <a href={`${base}?runs=${w.id}#runs`} className={contactStyles.muted}>Its runs</a>
                  </span>
                  {w.mayManage && w.status !== 'archived' ? <WorkflowButtons id={w.id} status={w.status as 'active' | 'paused'} /> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

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
    </div>
  );
}
