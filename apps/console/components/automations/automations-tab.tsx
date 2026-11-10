import Link from 'next/link';
import { LocalTime } from '@repo/ui';
import { AUTOMATION_KEY, listAutomationRuns, listEveryAutomation, type AutomationRunView } from '@repo/core/recurring';
import { listWaitingDrafts, workflowRuns, type WorkflowRunView } from '@repo/core/workflows';
import contactStyles from '@/components/contacts/contacts.module.css';
import { getConsoleDb } from '../../lib/db';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { WaitingDrafts } from '../workflows/islands';
import { AutomationsBoard } from './automations-board';
import { AutomationDrawer } from './chat-automations';
import styles from './automations-tab.module.css';

/**
 * Skills → Automations (ADR 0089): everything this person or agency has set up with the skills, in one list. It starts empty,
 * and fills from the skills' chats. Workflows, one-off tasks, scheduled AI skills and repeating automations differ only in when they run.
 */

const RUN_WORDS: Readonly<Record<string, string>> = { running: 'Running', done: 'Done', stopped: 'Stopped', failed: 'Failed', skipped: 'Skipped' };

function AutomationRuns({ runs }: { runs: AutomationRunView[] }) {
  if (!runs.length) return <p className={contactStyles.note}>It has not run yet.</p>;
  return (
    <ul className={contactStyles.plainList}>
      {runs.map((r) => (
        <li key={r.id} className={contactStyles.plainItem}>
          <span style={{ display: 'grid', gap: '0.15rem' }}>
            <strong>{RUN_WORDS[r.status] ?? r.status}</strong>
            <span className={contactStyles.muted}>
              {r.sent} of {r.total} sent{r.failed ? ` · ${r.failed} failed` : ''}{r.skipped ? ` · ${r.skipped} skipped` : ''}{r.trigger === 'manual' ? ' · run by hand' : ''}
            </span>
            {r.detail ? <span className={contactStyles.muted}>{r.detail}</span> : null}
          </span>
          <LocalTime iso={r.at.toISOString()} style="short" />
        </li>
      ))}
    </ul>
  );
}

function WorkflowRuns({ runs }: { runs: WorkflowRunView[] }) {
  if (!runs.length) return <p className={contactStyles.note}>It has not run yet.</p>;
  return (
    <ul className={contactStyles.plainList}>
      {runs.map((r) => (
        <li key={r.id} className={contactStyles.plainItem}>
          <span style={{ display: 'grid', gap: '0.15rem' }}>
            <strong>{RUN_WORDS[r.status] ?? r.status}</strong>
            {r.error ? <span className={contactStyles.muted}>{r.error}</span> : null}
          </span>
          <LocalTime iso={new Date(r.at).toISOString()} style="short" />
        </li>
      ))}
    </ul>
  );
}

export async function AutomationsTab({ surface, runs, open }: { surface: 'agency' | 'agent'; runs?: string; open?: string }) {
  const session = await requireConsoleAccess(surface);
  const db = getConsoleDb();
  const [rows, drafts] = await Promise.all([listEveryAutomation(db, session.actor), listWaitingDrafts(db, session.actor)]);
  const skills = surface === 'agency' ? '/skills' : '/my-skills';
  const base = `${skills}?tab=automations`;
  const home = surface === 'agency' ? '/overview' : '/assistant';
  const picked = runs ? rows.find((r) => r.id === runs && (r.source === 'recurring' || r.source === 'workflow')) : undefined;
  const history = picked?.source === 'recurring' ? await listAutomationRuns(db, session.actor, picked.id) : null;
  const flowHistory = picked?.source === 'workflow' ? await workflowRuns(db, session.actor, picked.id) : null;

  const paths = { home, email: surface === 'agency' ? '/bulk-email' : '/my-bulk-email', sms: surface === 'agency' ? '/bulk-sms' : '/my-bulk-sms', skills };
  const openKey = open && AUTOMATION_KEY.test(open) ? open : null;
  return (
    <>
      {openKey ? <AutomationDrawer automationKey={openKey} paths={paths} closeHref={base} /> : null}
      <div className={contactStyles.head}>
        <div className={contactStyles.headText}>
          <p className={contactStyles.sub}>
            What you have set up with your skills. Open a skill’s chat and say what you want done: it shows up here, with when it runs and whether it is on.
          </p>
        </div>
      </div>

      {drafts.length ? (
        <section className={contactStyles.card} id="waiting" style={{ marginBottom: '1rem' }}>
          <div className={contactStyles.section} style={{ borderTop: 0 }}>
            <h2 className={contactStyles.sectionTitle}>Waiting for you ({drafts.length})</h2>
            <WaitingDrafts ids={drafts.map((d) => d.id)} surface={surface} />
          </div>
        </section>
      ) : null}

      {rows.length ? (
        <AutomationsBoard rows={rows} home={home} base={base} />
      ) : (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No automations yet</p>
          <p className={styles.note}>
            Open a skill from <Link href={skills}>Platform skills</Link> and tell its chat what you need done.
          </p>
        </div>
      )}

      {picked ? (
        <section className={contactStyles.card} id="runs" style={{ marginTop: '1rem' }}>
          <div className={contactStyles.section} style={{ borderTop: 0 }}>
            <h2 className={contactStyles.sectionTitle}>History of {picked.name}</h2>
            {history ? <AutomationRuns runs={history} /> : null}
            {flowHistory ? <WorkflowRuns runs={flowHistory} /> : null}
          </div>
        </section>
      ) : null}
    </>
  );
}
