import Link from 'next/link';
import { LocalTime } from '@repo/ui';
import { AUTOMATION_KEY, listAutomationRuns, listEveryAutomation, type AutomationRow, type AutomationRunView } from '@repo/core/recurring';
import { listWaitingDrafts, workflowRuns, type WorkflowRunView } from '@repo/core/workflows';
import contactStyles from '@/components/contacts/contacts.module.css';
import { getConsoleDb } from '../../lib/db';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { WaitingDrafts } from '../workflows/islands';
import { AutomationControls } from './automation-controls';
import { AutomationDrawer } from './chat-automations';
import styles from './automations-tab.module.css';

/**
 * Skills → Automations (ADR 0089): everything this person or agency has set up with the skills, in one list. It starts empty,
 * and fills from the skills' chats. Workflows, one-off tasks, scheduled AI skills and repeating automations differ only in when they run.
 */

const STATE_WORDS = { active: 'Active', off: 'Off', finished: 'Finished' } as const;
const RUN_WORDS: Readonly<Record<string, string>> = { running: 'Running', done: 'Done', stopped: 'Stopped', failed: 'Failed', skipped: 'Skipped' };

function When({ label, iso }: { label: string; iso: string | null }) {
  if (!iso) return null;
  return (
    <span className={styles.meta}>
      {label} <LocalTime iso={iso} style="short" />
    </span>
  );
}

/** Its own chat, with the panel beside it, when it is this person's; otherwise the panel here. A chat is only its author's. */
export function automationRowHref(row: Pick<AutomationRow, 'key' | 'mine' | 'conversationId'>, home: string, base: string): string {
  return row.mine && row.conversationId ? `${home}?c=${row.conversationId}&automation=${row.key}` : `${base}&open=${row.key}`;
}

function Row({ row, home, base }: { row: AutomationRow; home: string; base: string }) {
  const hasHistory = row.source === 'recurring' || row.source === 'workflow';
  return (
    <li className={styles.item}>
      <div className={styles.main}>
        <div className={styles.top}>
          <Link href={automationRowHref(row, home, base)} className={`${styles.name} ${styles.rowLink}`}>
            {row.name}
          </Link>
          <span className={styles.state} data-state={row.state}>
            {STATE_WORDS[row.state]}
          </span>
        </div>
        <p className={styles.what}>{row.what}</p>
        <div className={styles.facts}>
          <span className={styles.skill}>From {row.skill}</span>
          <span className={styles.meta}>{row.when}</span>
          <When label="Next" iso={row.nextAt} />
          <When label="Last ran" iso={row.lastAt} />
          {row.owner ? <span className={styles.meta}>{row.owner}</span> : null}
        </div>
        {row.note ? <p className={styles.note}>{row.note}</p> : null}
        <div className={styles.links}>
          {hasHistory ? <a href={`${base}&open=${row.key}`}>Details</a> : null}
        </div>
      </div>
      {row.source !== 'task' ? <AutomationControls source={row.source} id={row.id} on={row.state === 'active'} canToggle={row.canToggle} canRun={row.canRun} /> : null}
    </li>
  );
}

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

  const count = (state: AutomationRow['state']) => rows.filter((r) => r.state === state).length;
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
        <p className={styles.summary}>
          <b>{count('active')}</b> active · <b>{count('off')}</b> off{count('finished') ? <> · <b>{count('finished')}</b> finished</> : null}. The top bar’s Automations shows what is running now.
        </p>
      ) : null}
      {rows.length ? (
        <ul className={styles.list}>
          {rows.map((r) => (
            <Row key={r.key} row={r} home={home} base={base} />
          ))}
        </ul>
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
