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
export function AutomationControls({ source, id, on, canToggle, canRun }: { source: Source; id: string; on: boolean; canToggle: boolean; canRun: boolean }) {
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
