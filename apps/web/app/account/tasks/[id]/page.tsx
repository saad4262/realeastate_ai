import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTask, TASK_SECTION_TEXT } from '@repo/core/tasks';
import { WebShell } from '../../../../components/web-shell';
import { ensureConsumerAccount } from '../../../../lib/account';
import { getWebDb } from '../../../../lib/db';
import { requireWebUser } from '../../../../lib/session';
import { deleteTaskAction, pauseTaskAction, resumeTaskAction, skipEmptyAction } from '../actions';
import styles from '../../account.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Task', robots: { index: false, follow: false } };

const day = (d: Date) => d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Sydney' });

/** One task and its reports (ADR 0080, C8 decision 7): every run kept here, emailed or not. The owner's only. */
export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireWebUser(`/account/tasks/${id}`);
  const session = await ensureConsumerAccount();
  if (!session) return null;
  const found = await getTask(getWebDb(), { userId: session.id }, id);
  if (!found) notFound();
  const { task, runs } = found;

  return (
    <WebShell account={{ signedIn: true }}>
      <main className={styles.page}>
        <p className="mb-2 text-sm">
          <Link href="/account/tasks" className="text-ink-soft hover:text-ink">
            ← Tasks
          </Link>
        </p>
        <h1 className={styles.title}>{task.name}</h1>
        <p className={`${styles.body} mt-1`}>
          {task.when} · {task.area} · {task.sections.map((s) => TASK_SECTION_TEXT[s].pick).join(', ')}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          {task.status === 'active' ? (
            <form action={pauseTaskAction}>
              <input type="hidden" name="id" value={task.id} />
              <button className="rounded-full border border-line bg-white px-3 py-1">Pause</button>
            </form>
          ) : task.status !== 'done' ? (
            <form action={resumeTaskAction}>
              <input type="hidden" name="id" value={task.id} />
              <button className="rounded-full border border-line bg-white px-3 py-1">Resume</button>
            </form>
          ) : (
            <span className="text-ink-soft">Done — it ran once.</span>
          )}
          <form action={skipEmptyAction} className="flex items-center gap-2">
            <input type="hidden" name="id" value={task.id} />
            <label className="flex items-center gap-1">
              <input type="checkbox" name="skipEmpty" defaultChecked={task.skipEmpty} /> Skip empty emails
            </label>
            <button className="rounded-full border border-line bg-white px-3 py-1">Save</button>
          </form>
          <form action={deleteTaskAction}>
            <input type="hidden" name="id" value={task.id} />
            <button className="rounded-full border border-danger-soft bg-white px-3 py-1 text-danger">Delete</button>
          </form>
        </div>

        {runs.length === 0 ? (
          <section className={styles.card}>
            <p className={styles.body}>No report yet. The first runs {task.status === 'active' ? `on ${day(task.nextRunAt)}` : 'when the task is running'}.</p>
          </section>
        ) : (
          runs.map((r) => (
            <section key={r.id} className={styles.card}>
              <h2 className={styles.cardLabel}>
                {day(r.scheduledFor)} · {r.emailStatus === 'sent' ? 'emailed' : r.emailStatus === 'skipped' ? 'not emailed (nothing new)' : r.status === 'failed' ? 'failed' : 'not emailed'}
              </h2>
              {r.summary ? (
                <p className={styles.body}>
                  {r.summarySource === 'model' ? <span className="mr-1 rounded-full bg-info-soft px-2 py-0.5 text-[11px] text-info">Written by the property guide</span> : null}
                  {r.summary}
                </p>
              ) : null}
              {r.report?.sections.map((s) => (
                <div key={s.key} className="mt-3">
                  <h3 className="m-0 text-sm font-semibold text-ink">{s.title}</h3>
                  {s.rows.length ? (
                    <ul className="m-0 list-none p-0 text-sm">
                      {s.rows.map((row, i) => (
                        <li key={i} className="flex flex-wrap justify-between gap-2 border-t border-line-subtle py-1.5 first:border-t-0">
                          {row.href ? (
                            <Link href={row.href} className="text-ink hover:underline">
                              {row.text}
                            </Link>
                          ) : (
                            <span className="text-ink">{row.text}</span>
                          )}
                          {row.detail ? <span className="text-ink-soft">{row.detail}</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="m-0 text-sm text-ink-soft">{s.note ?? 'Nothing this time.'}</p>
                  )}
                </div>
              ))}
            </section>
          ))
        )}
        <p className="mt-3 text-xs text-ink-faint">Every figure is from this site&rsquo;s records.</p>
      </main>
    </WebShell>
  );
}
