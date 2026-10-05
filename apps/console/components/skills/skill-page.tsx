import Link from 'next/link';
import { LocalTime } from '@repo/ui';
import { getMySkill, listSkillRuns, SkillError, SKILL_HANDLER_LABELS } from '@repo/core/skills';
import { requireIntegrations } from '@repo/core/integrations';
import { can } from '@repo/core/permissions';
import contactStyles from '@/components/contacts/contacts.module.css';
import { ConnectFirst } from '@/components/integrations/integration-ui';
import { getConsoleDb } from '../../lib/db';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { BodyEditor, EnabledToggle, RemoveSkillButton, RunNowButton, ScheduleForm } from './islands';

const STATUS_LABEL = { running: 'Running', succeeded: 'Done', failed: 'Failed', skipped: 'Skipped' } as const;

/** One of the agent's own skills: on/off, schedule, text, Run now, history. Nobody else's — not found. */
export async function SkillPage({ surface, id }: { surface: 'agency' | 'agent'; id: string }) {
  const session = await requireConsoleAccess(surface);
  const basePath = surface === 'agency' ? '/skills' : '/my-skills';
  const db = getConsoleDb();
  let s: Awaited<ReturnType<typeof getMySkill>>;
  try {
    s = await getMySkill(db, session.actor, id);
  } catch (err) {
    return <p role="alert" style={{ padding: '1rem', color: 'var(--rose)' }}>{err instanceof SkillError ? err.message : 'Failed to load the skill'}</p>;
  }
  const [runs, integrations] = await Promise.all([
    listSkillRuns(db, session.actor, s.id),
    s.requires.length ? requireIntegrations(db, session.actor, s.requires) : Promise.resolve(null),
  ]);
  const mayManage = can(session.actor, 'agent_skill:manage', { type: 'agent_skill', id: s.id, agencyId: s.agencyId, ownerId: s.userId });
  const blocked = integrations && !integrations.ok ? 'Connect the integrations below first' : null;
  const runBlocked = blocked ?? (s.enabled ? null : 'Switch the skill on to run it');

  return (
    <div className={contactStyles.wrap}>
      <Link href={basePath} className={contactStyles.back}>← All skills</Link>
      <div className={contactStyles.head}>
        <div className={contactStyles.headText}>
          <h1 className={contactStyles.title}>{s.name}</h1>
          <p className={contactStyles.sub}>{s.description} · {SKILL_HANDLER_LABELS[s.handler]}</p>
        </div>
        {mayManage ? (
          <div className={contactStyles.headActions}>
            <EnabledToggle id={s.id} enabled={s.enabled} blocked={blocked} />
            <RunNowButton id={s.id} basePath={basePath} disabledReason={runBlocked} />
          </div>
        ) : null}
      </div>

      {integrations && !integrations.ok
        ? integrations.results
            .filter((r) => r.state !== 'connected')
            .map((r) => <ConnectFirst key={r.provider} requirement={r} purpose="This skill needs it." />)
        : null}

      {s.consecutiveFailures >= 3 ? (
        <p className={contactStyles.error} role="alert">Paused after three failed runs in a row. Run it now to try again — a good run resumes the schedule.</p>
      ) : null}

      <div className={contactStyles.grid2}>
        <section className={contactStyles.card}>
          <div className={contactStyles.section} style={{ borderTop: 0 }}>
            <h2 className={contactStyles.sectionTitle}>Instructions</h2>
            <p className={contactStyles.note}>Change how it writes and what it leads with. What it can read is fixed — it only ever sees what you can open.</p>
            {mayManage ? <BodyEditor id={s.id} bodyMd={s.bodyMd} /> : <pre className={contactStyles.note} style={{ whiteSpace: 'pre-wrap' }}>{s.bodyMd}</pre>}
          </div>
        </section>
        <div style={{ display: 'grid', gap: '1rem', alignContent: 'start' }}>
          <section className={contactStyles.card}>
            <div className={contactStyles.section} style={{ borderTop: 0 }}>
              <h2 className={contactStyles.sectionTitle}>Schedule</h2>
              <p className={contactStyles.note}>
                {s.enabled && s.nextRunAt ? <>Next run <LocalTime iso={s.nextRunAt.toISOString()} /></> : 'Not scheduled while it is off.'}
              </p>
              {mayManage ? (
                <ScheduleForm
                  id={s.id}
                  cadence={s.cadence}
                  sendAtMinute={s.sendAtMinute}
                  sendOnWeekday={s.sendOnWeekday}
                  intervalMinutes={s.intervalMinutes}
                  timezone={s.timezone}
                  emailMe={s.emailMe}
                />
              ) : null}
            </div>
          </section>
          <section className={contactStyles.card}>
            <div className={contactStyles.section} style={{ borderTop: 0 }}>
              <h2 className={contactStyles.sectionTitle}>Run history</h2>
              {runs.length === 0 ? (
                <p className={contactStyles.note}>No runs yet.</p>
              ) : (
                <ul className={contactStyles.plainList}>
                  {runs.map((r) => (
                    <li key={r.id} className={contactStyles.plainItem}>
                      <Link href={`${basePath}/${s.id}/runs/${r.id}`} className={contactStyles.name}>
                        <LocalTime iso={r.startedAt.toISOString()} style="short" />
                      </Link>
                      <span className={contactStyles.muted}>
                        {STATUS_LABEL[r.status]} · {r.trigger === 'manual' ? 'run now' : 'scheduled'}
                        {r.costUsd > 0 ? ` · US$${r.costUsd.toFixed(4)}` : ''}
                        {r.error ? ` · ${r.error}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
          {mayManage ? <RemoveSkillButton id={s.id} basePath={basePath} /> : null}
        </div>
      </div>
    </div>
  );
}
