'use client';

import { useState } from 'react';

type Line = { text: string; refs: string[] };
type Result = { lines: Line[]; homes: { ref: string; listingId: string; address: string }[] };

/**
 * "Summarise my day" (ADR 0080, C6 decision 9): written on request from the buyer's own marks and notes, checked by
 * core, shown with its label, never stored. Each line names the homes it came from.
 */
export function InspectionSummary({ listingIds, label = 'Summarise my notes' }: { listingIds?: string[]; label?: string }) {
  const [state, setState] = useState<{ status: 'idle' | 'loading' } | { status: 'done'; result: Result } | { status: 'error'; error: string }>({ status: 'idle' });

  async function go() {
    setState({ status: 'loading' });
    try {
      const res = await fetch('/api/inspections/summary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(listingIds?.length ? { listingIds } : {}) });
      const body = (await res.json().catch(() => null)) as (Result & { error?: string }) | null;
      if (!res.ok || !body || body.error) setState({ status: 'error', error: body?.error ?? 'The summary could not be written just now.' });
      else setState({ status: 'done', result: body });
    } catch {
      setState({ status: 'error', error: 'The summary could not be written just now.' });
    }
  }

  if (state.status === 'done') {
    const name = new Map(state.result.homes.map((h) => [h.ref, h.address]));
    return (
      <div className="rounded-xl bg-info-soft p-4 text-sm">
        <span className="rounded-full bg-white/70 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-info">Written by the property guide</span>
        {state.result.lines.length ? (
          state.result.lines.map((l, i) => (
            <p key={i} className="mb-0 mt-2 text-ink">
              {l.text} <span className="text-xs text-ink-faint">({l.refs.map((r) => name.get(r) ?? r).join('; ')})</span>
            </p>
          ))
        ) : (
          <p className="mb-0 mt-2 text-ink">Nothing could be summarised that your notes support. Your notes are all below.</p>
        )}
        <p className="mb-0 mt-3 text-xs text-ink-soft">From your ticks and notes only. It doesn&rsquo;t look at your photos and doesn&rsquo;t judge the homes or pick one. Not saved.</p>
        <button type="button" onClick={go} className="mt-2 text-xs font-semibold underline">
          Write it again
        </button>
      </div>
    );
  }
  return (
    <div>
      <button type="button" onClick={go} disabled={state.status === 'loading'} className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-brand-ink disabled:opacity-60">
        {state.status === 'loading' ? 'Writing…' : label}
      </button>
      {state.status === 'error' ? <p className="mt-2 text-sm text-alert">{state.error}</p> : null}
    </div>
  );
}
