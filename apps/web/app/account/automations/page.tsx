import type { Metadata } from 'next';
import Link from 'next/link';
import { consumerSkillBlocks, consumerSkillOffMessage } from '@repo/core/consumer-skills';
import { ACTION_TEXT, ALLOWED, automationLog, DELIVERY_TEXT, listAutomations, MAX_AUTOMATIONS, SCOPE_TEXT, TRIGGER_TEXT, TRIGGERS } from '@repo/core/automation';
import { listSchedules } from '@repo/core/schedules';
import { AU_TIMEZONES, timezoneLabel } from '@repo/core/schedules';
import { WebShell } from '../../../components/web-shell';
import { ensureConsumerAccount } from '../../../lib/account';
import { getWebDb } from '../../../lib/db';
import { requireWebUser } from '../../../lib/session';
import { createAutomationAction, deleteAutomationAction, pauseAutomationAction, resumeAutomationAction, undoAutomationAction } from './actions';
import styles from '../account.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Automations', robots: { index: false, follow: false } };

const when = (d: Date) => d.toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Australia/Sydney' });

/**
 * Automation (ADR 0080, C8 decisions 8–11; mock docs/mocks/consumer-acting.html#automations): when something happens to
 * a home the buyer follows, tell them or tidy their own shortlist — never anything to an agent. Every action is on the
 * log with Undo. Off until switched on; reading, pausing, deleting and Undo always work.
 */
export default async function AutomationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireWebUser('/account/automations');
  const session = await ensureConsumerAccount();
  if (!session) return null;
  const db = getWebDb();
  const actor = { userId: session.id };
  const [automations, log, blocks, searches] = await Promise.all([listAutomations(db, actor), automationLog(db, actor), consumerSkillBlocks(db, actor), listSchedules(db, actor)]);
  const block = blocks.get('automation');
  const error = typeof (await searchParams).error === 'string' ? ((await searchParams).error as string).slice(0, 200) : null;

  return (
    <WebShell account={{ signedIn: true }}>
      <main className={styles.page}>
        <p className="mb-2 text-sm">
          <Link href="/account" className="text-ink-soft hover:text-ink">
            ← Your account
          </Link>
        </p>
        <h1 className={styles.title}>Automations</h1>
        <p className={`${styles.body} mt-1`}>{block ? consumerSkillOffMessage('automation', block) : `When something happens to a home you follow, do what you asked. ${automations.length} of ${MAX_AUTOMATIONS}. Nothing here ever writes to an agent.`}</p>
        {error ? <p className="mt-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p> : null}

        <section className={styles.card}>
          {automations.length === 0 ? (
            <p className={styles.body}>No automations yet. Set one up below, or ask the guide: “if anything on my shortlist drops its price, tell me”.</p>
          ) : (
            <ul className="m-0 list-none p-0">
              {automations.map((a) => (
                <li key={a.id} className="flex flex-wrap items-start justify-between gap-2 border-t border-line-subtle py-3 text-sm first:border-t-0">
                  <span className="min-w-0">
                    <b className="font-semibold text-ink">{a.when}</b>
                    <span className="block text-ink-soft">→ {a.then}</span>
                  </span>
                  <span className="flex items-center gap-2 text-xs">
                    <span className={a.status === 'active' ? 'text-success' : 'text-ink-soft'}>{a.status === 'active' ? 'On' : 'Paused'}</span>
                    <form action={a.status === 'active' ? pauseAutomationAction : resumeAutomationAction}>
                      <input type="hidden" name="id" value={a.id} />
                      <button className="underline">{a.status === 'active' ? 'Pause' : 'Resume'}</button>
                    </form>
                    <form action={deleteAutomationAction}>
                      <input type="hidden" name="id" value={a.id} />
                      <button className="text-danger underline">Delete</button>
                    </form>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={styles.card}>
          <h2 className={styles.cardLabel}>What your automations did</h2>
          {log.length === 0 ? (
            <p className={styles.body}>Nothing yet.</p>
          ) : (
            <ul className="m-0 list-none p-0 text-sm">
              {log.map((e) => (
                <li key={e.id} className="flex flex-wrap items-start justify-between gap-2 border-t border-line-subtle py-2 first:border-t-0">
                  <span className="min-w-0">
                    <b className="font-semibold text-ink">
                      {e.actionTaken === 'added' ? `Added ${e.address} to your shortlist` : e.actionTaken === 'removed' ? `Took ${e.address} off your shortlist` : `Told you: ${e.address}`}
                    </b>{' '}
                    · {e.text}
                    <span className="block text-xs text-ink-faint">{e.automationWhen}</span>
                  </span>
                  <span className="flex items-center gap-2 text-xs text-ink-soft">
                    {when(e.createdAt)}
                    {e.emailedAt ? ' · emailed' : ''}
                    {e.actionTaken && !e.undoneAt ? (
                      <form action={undoAutomationAction}>
                        <input type="hidden" name="id" value={e.id} />
                        <button className="underline">Undo</button>
                      </form>
                    ) : e.undoneAt ? (
                      ' · undone'
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-ink-faint">Undo puts your shortlist back as it was and leaves the automation on.</p>
        </section>

        {!block ? (
          <form action={createAutomationAction} className={`${styles.card} grid gap-2 text-sm`}>
            <h2 className={styles.cardLabel}>New automation</h2>
            <label className="flex items-center justify-between gap-2">
              When
              <select name="trigger" defaultValue="price_reduced" className="max-w-[60%] rounded-lg border border-line px-2 py-1">
                {TRIGGERS.map((t) => (
                  <option key={t} value={t}>
                    {t === 'new_match' ? 'a new home matches a saved search' : `a home ${TRIGGER_TEXT[t]}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center justify-between gap-2">
              About
              <select name="scope" defaultValue="shortlist" className="max-w-[60%] rounded-lg border border-line px-2 py-1">
                {(['shortlist', 'watched', 'both'] as const).map((s) => (
                  <option key={s} value={s}>
                    {SCOPE_TEXT[s]}
                  </option>
                ))}
              </select>
            </label>
            {searches.length ? (
              <label className="flex items-center justify-between gap-2">
                Saved search (for a new match)
                <select name="searchId" defaultValue={searches[0]!.id} className="max-w-[60%] rounded-lg border border-line px-2 py-1">
                  {searches.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="flex items-center justify-between gap-2">
              Then
              <select name="action" defaultValue="tell" className="max-w-[60%] rounded-lg border border-line px-2 py-1">
                {(['tell', 'shortlist_add', 'shortlist_remove'] as const).map((a) => (
                  <option key={a} value={a}>
                    {ACTION_TEXT[a]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center justify-between gap-2">
              Email
              <select name="delivery" defaultValue="daily" className="rounded-lg border border-line px-2 py-1">
                <option value="daily">{DELIVERY_TEXT.daily}</option>
                <option value="instant">{DELIVERY_TEXT.instant}</option>
              </select>
            </label>
            <label className="flex items-center justify-between gap-2">
              Time zone
              <select name="timeZone" defaultValue="Australia/Sydney" className="rounded-lg border border-line px-2 py-1">
                {AU_TIMEZONES.map((z) => (
                  <option key={z} value={z}>
                    {timezoneLabel(z)}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="mt-2 justify-self-start rounded-full bg-brand px-4 py-2 font-semibold text-brand-ink">
              Save automation
            </button>
            <p className="m-0 text-xs text-ink-faint">
              What fits: {Object.entries(ALLOWED).filter(([, v]) => v.actions.length > 1).map(([t, v]) => `${t === 'new_match' ? 'a new match' : `“${TRIGGER_TEXT[t as keyof typeof TRIGGER_TEXT]}”`} can ${v.actions.filter((x) => x !== 'tell').map((x) => ACTION_TEXT[x].split(',')[0]!.toLowerCase()).join(' or ')}`).join('; ')}. Enquire, book or make an offer are not here on purpose — those go through Agent AI&rsquo;s draft, which you send yourself.
            </p>
          </form>
        ) : null}
      </main>
    </WebShell>
  );
}
