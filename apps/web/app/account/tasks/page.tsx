import type { Metadata } from 'next';
import Link from 'next/link';
import { consumerSkillBlocks, consumerSkillOffMessage } from '@repo/core/consumer-skills';
import { listTasks, MAX_TASKS, TASK_SECTION_TEXT, TASK_SECTIONS } from '@repo/core/tasks';
import { AU_STATES, PROPERTY_TYPES } from '@repo/core/listings';
import { AU_TIMEZONES, timezoneLabel } from '@repo/core/schedules';
import { WebShell } from '../../../components/web-shell';
import { ensureConsumerAccount } from '../../../lib/account';
import { getWebDb } from '../../../lib/db';
import { requireWebUser } from '../../../lib/session';
import { createTaskAction } from './actions';
import styles from '../account.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Tasks', robots: { index: false, follow: false } };

const STATUS: Record<string, string> = { active: 'Running', paused: 'Paused', failing: 'Stopped after errors', done: 'Done' };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Tasks (ADR 0080, C8 decisions 5–7; mock docs/mocks/consumer-acting.html#tasks): research once or on a schedule, a
 * report by email and on the task's page. Off until the buyer switches it on; reading, pausing and deleting always work.
 */
export default async function TasksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireWebUser('/account/tasks');
  const session = await ensureConsumerAccount();
  if (!session) return null;
  const db = getWebDb();
  const actor = { userId: session.id };
  const [tasks, blocks] = await Promise.all([listTasks(db, actor), consumerSkillBlocks(db, actor)]);
  const block = blocks.get('tasks');
  const error = typeof (await searchParams).error === 'string' ? ((await searchParams).error as string).slice(0, 200) : null;
  const running = tasks.filter((t) => t.status !== 'done').length;

  return (
    <WebShell account={{ signedIn: true }}>
      <main className={styles.page}>
        <p className="mb-2 text-sm">
          <Link href="/account" className="text-ink-soft hover:text-ink">
            ← Your account
          </Link>
        </p>
        <h1 className={styles.title}>Tasks</h1>
        <p className={`${styles.body} mt-1`}>{block ? consumerSkillOffMessage('tasks', block) : `Research done once or on a schedule, with a report by email and here. ${running} of ${MAX_TASKS}.`}</p>
        {error ? <p className="mt-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p> : null}

        <section className={styles.card}>
          {tasks.length === 0 ? (
            <p className={styles.body}>No tasks yet. Set one up below, or ask the guide: “every Monday, send me new 3-bed houses in Pakenham and what sold”.</p>
          ) : (
            <ul className="m-0 list-none p-0">
              {tasks.map((t) => (
                <li key={t.id} className="flex flex-wrap items-start justify-between gap-2 border-t border-line-subtle py-3 first:border-t-0">
                  <span className="min-w-0">
                    <Link href={`/account/tasks/${t.id}`} className="font-semibold text-ink hover:underline">
                      {t.name}
                    </Link>
                    <span className="block text-xs text-ink-soft">
                      {t.when} · {t.area} · {t.sections.map((s) => TASK_SECTION_TEXT[s].pick).join(', ')}
                    </span>
                  </span>
                  <span className="text-xs text-ink-soft">{STATUS[t.status] ?? t.status}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {!block ? (
          <form action={createTaskAction} className={`${styles.card} grid gap-2 text-sm`}>
            <h2 className={styles.cardLabel}>New task</h2>
            <label className="flex items-center justify-between gap-2">
              Name <input name="name" required maxLength={80} placeholder="Monday in Pakenham" className="w-56 rounded-lg border border-line px-2 py-1" />
            </label>
            <label className="flex items-center justify-between gap-2">
              Suburb <input name="suburb" maxLength={80} placeholder="Pakenham" className="w-56 rounded-lg border border-line px-2 py-1" />
            </label>
            <label className="flex items-center justify-between gap-2">
              State
              <select name="state" defaultValue="" className="rounded-lg border border-line px-2 py-1">
                <option value="">Any</option>
                {AU_STATES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center justify-between gap-2">
              Buying or renting
              <select name="channel" defaultValue="sale" className="rounded-lg border border-line px-2 py-1">
                <option value="sale">Buying</option>
                <option value="rent">Renting</option>
              </select>
            </label>
            <label className="flex items-center justify-between gap-2">
              Up to ($) <input name="priceTo" inputMode="numeric" className="w-32 rounded-lg border border-line px-2 py-1" />
            </label>
            <label className="flex items-center justify-between gap-2">
              Bedrooms (at least)
              <select name="bedrooms" defaultValue="" className="rounded-lg border border-line px-2 py-1">
                <option value="">Any</option>
                {[1, 2, 3, 4, 5].map((b) => (
                  <option key={b}>{b}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center justify-between gap-2">
              Kind
              <select name="type" defaultValue="" className="rounded-lg border border-line px-2 py-1">
                <option value="">Any</option>
                {PROPERTY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t[0]!.toUpperCase() + t.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="m-0 mt-2 border-0 p-0">
              <legend className={styles.cardLabel}>In the report (up to 4)</legend>
              {TASK_SECTIONS.map((s) => (
                <label key={s} className="flex items-center gap-2 py-0.5">
                  <input type="checkbox" name="sections" value={s} defaultChecked={s === 'new_homes' || s === 'sold'} /> {TASK_SECTION_TEXT[s].pick}
                </label>
              ))}
            </fieldset>
            <label className="flex items-center justify-between gap-2">
              When
              <select name="cadence" defaultValue="weekly" className="rounded-lg border border-line px-2 py-1">
                <option value="weekly">Every week</option>
                <option value="daily">Every day</option>
                <option value="once">Once</option>
              </select>
            </label>
            <label className="flex items-center justify-between gap-2">
              Day (weekly)
              <select name="weekday" defaultValue="1" className="rounded-lg border border-line px-2 py-1">
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center justify-between gap-2">
              Time <input type="time" name="time" defaultValue="07:00" className="rounded-lg border border-line px-2 py-1" />
            </label>
            <label className="flex items-center justify-between gap-2">
              Time zone
              <select name="timezone" defaultValue="Australia/Sydney" className="rounded-lg border border-line px-2 py-1">
                {AU_TIMEZONES.map((z) => (
                  <option key={z} value={z}>
                    {timezoneLabel(z)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="skipEmpty" defaultChecked /> Skip the email when nothing is new
            </label>
            <button type="submit" className="mt-2 justify-self-start rounded-full bg-brand px-4 py-2 font-semibold text-brand-ink">
              Save task
            </button>
            <p className="m-0 text-xs text-ink-faint">Every figure in a report comes from this site&rsquo;s records. Nothing here ever writes to an agent.</p>
          </form>
        ) : null}
      </main>
    </WebShell>
  );
}
