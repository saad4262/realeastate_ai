'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { automationIcon, readableDuration, type AutomationDetail, type AutomationStep, type RunProgress } from '@repo/core/recurring/detail-types';
import type { AutomationPaths } from '@repo/core/automation-status/links';
import { useToast } from '@/components/toast';
import { stopAutomationRunAction, stopTaskAction, stopWorkflowRunAction } from '@/lib/automation-actions';
import { AutomationControls } from './automation-controls';
import { Progress } from './progress';
import styles from './automation-detail.module.css';

/**
 * One automation in full (the user, 2026-11-10): what it does, the run going now with what is left, and its history. Beside its
 * chat, or in a drawer on Skills. It refreshes itself while it is on screen, faster while something is running.
 */

const STATE = { active: 'Active', off: 'Off', finished: 'Finished' } as const;
const TONE = { active: 'good', off: 'wait', finished: 'wait' } as const;
const RUN = { running: 'Running', done: 'Done', stopped: 'Stopped', failed: 'Failed', skipped: 'Skipped', succeeded: 'Done', started: 'Started', scheduled: 'Due', blocked: 'Waiting', cancelled: 'Skipped' } as Record<string, string>;

function when(at: string | null): string {
  if (!at) return '';
  return new Date(at).toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

function Numbers({ r, noun }: { r: RunProgress; noun: string }) {
  return (
    <div className={styles.numbers}>
      <span>
        <b>{r.sent}</b> {noun}
      </span>
      {r.remaining ? (
        <span>
          <b>{r.remaining}</b> left
        </span>
      ) : null}
      {r.failed ? (
        <span className={styles.bad}>
          <b>{r.failed}</b> failed
        </span>
      ) : null}
      {r.skipped ? (
        <span>
          <b>{r.skipped}</b> skipped
        </span>
      ) : null}
      <span className={styles.muted}>of {r.total}</span>
    </div>
  );
}

/** Each step with what happened and when: done at, due at, or — not yet due — how long after the one before. */
function Steps({ steps }: { steps: AutomationStep[] }) {
  return (
    <ol className={styles.steps}>
      {steps.map((s, i) => (
        <li key={i} data-status={s.status}>
          <span>{s.title}</span>
          <span className={styles.muted}>
            {RUN[s.status] ?? s.status}
            {s.at ? ` · ${when(s.at)}` : s.after ? ` · ${s.after}` : ''}
          </span>
          {s.error ? <span className={styles.bad}>{s.error}</span> : null}
        </li>
      ))}
    </ol>
  );
}

/** A workflow run's step going now, or due next, with its time. */
function nextStep(r: RunProgress): string | null {
  const s = r.steps?.find((x) => x.status === 'running' || x.status === 'scheduled');
  if (!s) return null;
  return s.status === 'running' ? `Going now: ${s.title}` : `Next: ${s.title}${s.at ? ` · ${when(s.at)}` : ''}`;
}

function StopButton({ run }: { run: () => Promise<{ ok: boolean; error?: string }> }) {
  const { toast } = useToast();
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState(false);
  if (!asking) {
    return (
      <button type="button" className={styles.btn} onClick={() => setAsking(true)}>
        Stop
      </button>
    );
  }
  return (
    <span className={styles.confirm}>
      <span className={styles.muted}>Stop the rest? What has gone stays gone.</span>
      <button
        type="button"
        className={styles.btn}
        disabled={pending}
        onClick={async () => {
          setPending(true);
          const r = await run().catch(() => ({ ok: false, error: 'That did not work.' }));
          if (!r.ok) toast({ title: 'Not stopped', description: r.error ?? '', variant: 'error' });
          setPending(false);
          setAsking(false);
        }}
      >
        Stop
      </button>
      <button type="button" className={styles.btn} onClick={() => setAsking(false)}>
        Keep going
      </button>
    </span>
  );
}

export function AutomationDetailPanel({ automationKey, paths, inChat = false }: { automationKey: string; paths: AutomationPaths; inChat?: boolean }) {
  const [d, setD] = useState<AutomationDetail | null>(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/automations?detail=${encodeURIComponent(automationKey)}`, { cache: 'no-store' }).catch(() => null);
    if (res?.status === 404) return setMissing(true);
    const body = res?.ok ? ((await res.json().catch(() => null)) as AutomationDetail | null) : null;
    if (body) {
      setD(body);
      setMissing(false);
    }
  }, [automationKey]);

  const running = Boolean(d?.current) || d?.steps.some((s) => s.status === 'scheduled' || s.status === 'running');
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, running ? 5_000 : 20_000);
    return () => clearInterval(timer);
  }, [load, running]);

  if (missing) return <p className={styles.muted}>This automation is no longer available.</p>;
  if (!d) return <p className={styles.muted}>Loading…</p>;

  const noun = d.source === 'workflow' ? 'steps done' : d.source === 'ai_skill' ? 'items' : 'sent';
  const c = d.current;
  const cLeft = c ? Math.max(0, c.total - c.sent - c.failed - c.skipped) : 0;
  // At the pace of this run so far: a guess, shown as "about".
  const cDone = c ? c.sent + c.failed : 0;
  const cTimeLeft = c && cDone > 0 && cLeft > 0 ? readableDuration(((Date.now() - new Date(c.at).getTime()) / cDone) * cLeft) : null;
  const stoppable = d.canStop ? (d.source === 'task' ? () => stopTaskAction(d.id) : d.current ? () => stopAutomationRunAction(d.current!.id) : null) : null;

  return (
    <div className={styles.panel}>
      <header className={styles.hero}>
        <span className={styles.heroIcon} aria-hidden>
          {automationIcon(d)}
        </span>
        <div className={styles.heroText}>
          <h2 className={styles.name}>{d.name}</h2>
          <span className={styles.pill} data-tone={c ? 'live' : TONE[d.state]}>
            {c ? 'Running now' : STATE[d.state]}
          </span>
        </div>
      </header>
      <p className={styles.summary}>{d.what}</p>
      <dl className={styles.facts}>
        <dt>Skill</dt>
        <dd>{d.skill}</dd>
        <dt>Runs</dt>
        <dd>{d.when}</dd>
        {d.nextAt ? (
          <>
            <dt>Next</dt>
            <dd>{when(d.nextAt)}</dd>
          </>
        ) : null}
        {d.lastAt ? (
          <>
            <dt>Last</dt>
            <dd>{when(d.lastAt)}</dd>
          </>
        ) : null}
        {d.owner ? (
          <>
            <dt>Owner</dt>
            <dd>{d.owner}</dd>
          </>
        ) : null}
      </dl>
      {d.note ? <p className={styles.note}>{d.note}</p> : null}

      <div className={styles.controls}>
        {d.source !== 'task' ? <AutomationControls source={d.source} id={d.id} on={d.state === 'active'} canToggle={d.canToggle} canRun={d.canRun} onDone={() => void load()} /> : null}
        {stoppable ? <StopButton run={async () => {
          const r = await stoppable();
          await load();
          return r;
        }} /> : null}
        {!inChat && d.mine && d.conversationId ? (
          <Link href={`${paths.home}?c=${d.conversationId}&automation=${d.key}`} className={styles.link}>
            Open its chat
          </Link>
        ) : null}
      </div>

      {c ? (
        <section className={styles.card}>
          <h3 className={styles.sectionTitle}>Running now</h3>
          {c.total ? (
            <Progress sent={c.sent} failed={c.failed} skipped={c.skipped} left={cLeft} noun={noun[0]!.toUpperCase() + noun.slice(1)} timeLeft={cTimeLeft} />
          ) : (
            <p className={styles.muted}>Finding who it is for…</p>
          )}
          <p className={styles.muted}>Started {when(c.at)}{c.manual ? ' · run by hand' : ''}</p>
        </section>
      ) : null}

      {d.steps.length ? (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Steps</h3>
          <Steps steps={d.steps} />
        </section>
      ) : null}

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>History</h3>
        {d.runs.length ? (
          <ul className={styles.runs}>
            {d.runs.map((r) => (
              <li key={r.id}>
                <div className={styles.runTop}>
                  <span className={styles.runStatus} data-status={r.status}>
                    {RUN[r.status] ?? r.status}
                  </span>
                  {r.who ? <span className={styles.runWho}>{r.who}</span> : null}
                  <span className={styles.muted}>{when(r.at)}</span>
                </div>
                {r.total ? <Numbers r={r} noun={noun} /> : null}
                {nextStep(r) ? <p className={styles.note}>{nextStep(r)}</p> : null}
                {r.detail ? <p className={styles.note}>{r.detail}</p> : null}
                {r.steps?.length ? (
                  <details className={styles.runSteps}>
                    <summary>Each step</summary>
                    <Steps steps={r.steps} />
                  </details>
                ) : null}
                {r.canStop ? (
                  <StopButton
                    run={async () => {
                      const out = await stopWorkflowRunAction(r.id);
                      await load();
                      return out;
                    }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.muted}>{d.source === 'task' ? 'A task runs once: its steps are above.' : d.source === 'ai_skill' && !d.mine ? 'Only its owner sees its runs.' : 'It has not run yet.'}</p>
        )}
      </section>
    </div>
  );
}
