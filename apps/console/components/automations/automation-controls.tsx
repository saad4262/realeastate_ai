'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useToast } from '@/components/toast';
import { runAutomationNowAction, setAutomationStatusAction } from '@/lib/automation-actions';
import { setSkillEnabledAction } from '@/lib/skill-actions';
import { setWorkflowStatusAction } from '@/lib/workflow-actions';
import styles from './automation-status.module.css';

type Source = 'recurring' | 'workflow' | 'ai_skill' | 'task';

/** On, off and Run now for one row of Skills → Automations (ADR 0089). The server asks can() again. */
export function AutomationControls({ source, id, on, canToggle, canRun, onDone }: { source: Source; id: string; on: boolean; canToggle: boolean; canRun: boolean; onDone?: () => void }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, setPending] = useState(false);

  const act = async (run: () => Promise<{ ok: boolean; error?: string }>, done?: string) => {
    setPending(true);
    const r = await run().catch(() => ({ ok: false, error: 'That did not work. Please try again.' }));
    if (!r.ok) toast({ title: 'Not changed', description: r.error ?? '', variant: 'error' });
    else if (done) toast({ title: done, variant: 'success' });
    setPending(false);
    router.refresh();
    onDone?.();
  };

  const toggle = () => {
    if (source === 'recurring') return act(() => setAutomationStatusAction(id, on ? 'paused' : 'active'));
    if (source === 'workflow') return act(() => setWorkflowStatusAction(id, on ? 'paused' : 'active'));
    if (source === 'ai_skill') return act(() => setSkillEnabledAction(id, !on));
    return Promise.resolve();
  };

  return (
    <span className={styles.confirm}>
      {canRun ? (
        <button type="button" className={styles.controlBtn} disabled={pending} onClick={() => void act(() => runAutomationNowAction(id), 'Started')}>
          Run now
        </button>
      ) : null}
      {canToggle ? (
        <button type="button" className={styles.controlBtn} disabled={pending} onClick={() => void toggle()}>
          {on ? 'Turn off' : 'Turn on'}
        </button>
      ) : null}
    </span>
  );
}

/** The on/off of one automation card, in the Platform skills switch's look: it moves at once and settles when the server answers. */
export function AutomationSwitch({ source, id, name, on, disabled, className }: { source: Source; id: string; name: string; on: boolean; disabled: boolean; className: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [shown, setShown] = useState(on);
  const [pending, setPending] = useState(false);
  const flip = async () => {
    const next = !shown;
    setShown(next);
    setPending(true);
    const run =
      source === 'recurring'
        ? setAutomationStatusAction(id, next ? 'active' : 'paused')
        : source === 'workflow'
          ? setWorkflowStatusAction(id, next ? 'active' : 'paused')
          : setSkillEnabledAction(id, next);
    const r = await run.catch(() => ({ ok: false as const, error: 'That did not work. Please try again.' }));
    setPending(false);
    if (!r.ok) {
      setShown(!next);
      toast({ title: 'Not changed', description: 'error' in r ? r.error : '', variant: 'error' });
      return;
    }
    toast({ title: `${name} is ${next ? 'on' : 'off'}`, variant: 'success' });
    router.refresh();
  };
  return <button type="button" role="switch" aria-checked={shown} aria-label={name} className={className} disabled={disabled || pending} onClick={() => void flip()} />;
}
