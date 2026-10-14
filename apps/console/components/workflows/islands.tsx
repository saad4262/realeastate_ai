'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { pauseAllWorkflowsAction, setWorkflowStatusAction } from '@/lib/workflow-actions';
import { ProposalCardView } from '../assistant/assistant-panel';

const ghost: React.CSSProperties = { padding: '0.25rem 0.625rem', borderRadius: '0.375rem', border: '1px solid var(--border-default)', background: 'transparent', cursor: 'pointer', fontSize: '0.8125rem' };

/** Pause / turn on / archive — what core allows is decided there; the page shows these only to its owner or an admin. */
export function WorkflowButtons({ id, status }: { id: string; status: 'active' | 'paused' }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const go = (next: 'active' | 'paused' | 'archived') =>
    start(async () => {
      setError(null);
      const r = await setWorkflowStatusAction(id, next);
      if (!r.ok) setError(r.error);
      else router.refresh();
    });
  return (
    <span style={{ display: 'inline-flex', gap: '0.375rem', alignItems: 'center', flexWrap: 'wrap' }}>
      {status === 'active' ? (
        <button type="button" style={ghost} disabled={pending} onClick={() => go('paused')}>Pause</button>
      ) : (
        <button type="button" style={ghost} disabled={pending} onClick={() => go('active')}>Turn on</button>
      )}
      <button type="button" style={ghost} disabled={pending} onClick={() => confirm('Archive this workflow? It stops for good; its record is kept.') && go('archived')}>
        Archive
      </button>
      {error ? <span role="alert" style={{ color: 'var(--rose)', fontSize: '0.8125rem' }}>{error}</span> : null}
    </span>
  );
}

export function PauseAllButton() {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <span>
      <button
        type="button"
        style={{ ...ghost, borderColor: 'var(--rose)', color: 'var(--rose)' }}
        disabled={pending}
        onClick={() =>
          confirm('Pause every workflow in the agency? Nothing new runs until each is turned on again.') &&
          start(async () => {
            const r = await pauseAllWorkflowsAction();
            setMsg(r.ok ? `Paused ${r.paused ?? 0}.` : r.error);
            router.refresh();
          })
        }
      >
        Pause all workflows
      </button>
      {msg ? <span style={{ marginLeft: '0.5rem', fontSize: '0.8125rem' }}>{msg}</span> : null}
    </span>
  );
}

/** "Waiting for you" (ADR 0041 D1): each AI-written draft as its own card — approve sends it, with every check. */
export function WaitingDrafts({ ids, surface }: { ids: string[]; surface: 'agency' | 'agent' }) {
  return (
    <div style={{ display: 'grid', gap: '0.75rem' }}>
      {ids.map((id) => (
        <ProposalCardView key={id} id={id} surface={surface} />
      ))}
    </div>
  );
}
