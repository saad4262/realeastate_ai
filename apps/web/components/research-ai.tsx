'use client';

import { useState, useTransition } from 'react';

type Ask = { kind: 'suburb'; state: string; suburb: string } | { kind: 'compare'; listingIds: string[]; buyer: string } | { kind: 'explain'; listingId: string };
type Line = { text: string; refs: string[] };

/**
 * C5's AI paragraph on a button (ADR 0080): Suburb AI, Comparison AI, Property Analyst. Every line comes back
 * checked by core — it cites a record, its figures are in that record, it passes no verdict — and shows its refs.
 */
export function ResearchAi({ ask, label }: { ask: Ask; label: string }) {
  const [lines, setLines] = useState<Line[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function run() {
    setError(null);
    start(async () => {
      const res = await fetch('/api/research', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ask) }).catch(() => null);
      const body = (await res?.json().catch(() => null)) as { lines?: Line[]; error?: string } | null;
      if (!res?.ok || !body?.lines) return setError(body?.error ?? 'The AI could not answer just now. Try again in a moment.');
      setLines(body.lines);
    });
  }

  if (!lines) {
    return (
      <div>
        <button type="button" onClick={run} disabled={pending} className="rounded-full border border-line bg-white px-4 py-2 text-body-sm font-semibold text-ink hover:border-ink disabled:opacity-60">
          {pending ? 'Reading the records…' : label}
        </button>
        {error ? <p role="alert" className="mt-2 text-body-sm text-alert">{error}</p> : null}
      </div>
    );
  }
  return (
    <div className="rounded-lg bg-info-soft p-md">
      <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-info">Written by the property guide</span>
      {lines.length ? (
        lines.map((l, i) => (
          <p key={i} className="mt-2 text-body-sm text-ink">
            {l.text}
            {l.refs.map((r) => (
              <span key={r} className="ml-1 inline-grid h-4 place-items-center rounded bg-white px-1 align-middle text-[10px] font-bold text-ink-soft">
                {r}
              </span>
            ))}
          </p>
        ))
      ) : (
        <p className="mt-2 text-body-sm text-ink-soft">Nothing it could say from the records alone.</p>
      )}
      <p className="mt-2 text-label-sm text-ink-faint">No value, no prediction, no verdict. Every figure is on this page.</p>
    </div>
  );
}
