'use client';

import { useState, useTransition } from 'react';

type Line = { text: string; refs: string[] };

/**
 * Due-Diligence AI's button (ADR 0080, C2 decisions 3 and 6): a summary of the records and, on a listing,
 * questions for the agent. Every line comes back checked by core and cites its references. The questions go
 * into the listing's own enquiry form, which the buyer reads and sends — nothing is sent for them.
 */
export function DueDiligenceAi({ subject }: { subject: { listingId: string } | { propertyId: string } }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<{ summary: Line[]; questions: Line[] } | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<number>>(new Set());
  const [placed, setPlaced] = useState(false);

  function ask() {
    setError(null);
    start(async () => {
      const res = await fetch('/api/due-diligence', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(subject) }).catch(() => null);
      const body = (await res?.json().catch(() => null)) as { summary?: Line[]; questions?: Line[]; error?: string } | null;
      if (!res?.ok || !body?.summary) return setError(body?.error ?? 'The AI could not answer just now. Try again in a moment.');
      setAnswer({ summary: body.summary, questions: body.questions ?? [] });
      setChosen(new Set((body.questions ?? []).slice(0, 3).map((_, i) => i)));
    });
  }

  function place() {
    if (!answer) return;
    const picked = answer.questions.filter((_, i) => chosen.has(i));
    const text = `Hi, I'm interested in this property.\n\n${picked.map((q, i) => `${i + 1}. ${q.text}`).join('\n')}\n\nThanks`;
    const box = document.querySelector<HTMLTextAreaElement>('#enquire textarea[name="message"]');
    if (!box) return setError('The enquiry form is not on this page.');
    box.value = text.slice(0, 2000);
    box.closest('#enquire')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    box.focus();
    setPlaced(true);
  }

  const refs = (l: Line) => l.refs.map((r) => (
    <span key={r} className="ml-1 inline-grid h-4 place-items-center rounded bg-sunken px-1 align-middle text-[10px] font-bold text-ink-soft">{r}</span>
  ));

  if (!answer) {
    return (
      <div>
        <button type="button" onClick={ask} disabled={pending} className="rounded-full border border-line bg-white px-4 py-2 text-body-sm font-semibold text-ink hover:border-ink disabled:opacity-60">
          {pending ? 'Reading the records…' : 'listingId' in subject ? 'Summarise with AI and draft questions' : 'Summarise with AI'}
        </button>
        {error ? <p role="alert" className="mt-2 text-body-sm text-alert">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="grid gap-md">
      <div className="rounded-lg bg-info-soft p-md">
        <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-info">Written by the property guide</span>
        {answer.summary.length ? (
          answer.summary.map((l, i) => (
            <p key={i} className="mt-2 text-body-sm text-ink">
              {l.text}
              {refs(l)}
            </p>
          ))
        ) : (
          <p className="mt-2 text-body-sm text-ink-soft">Nothing it could say from our records alone.</p>
        )}
      </div>
      {answer.questions.length ? (
        <div>
          <p className="mb-1 text-label-sm font-bold uppercase tracking-wide text-ink-soft">Questions to ask the agent</p>
          <ul className="m-0 list-none p-0">
            {answer.questions.map((q, i) => (
              <li key={i} className="border-t border-line-subtle py-2 first:border-t-0">
                <label className="grid cursor-pointer grid-cols-[1.25rem_1fr] gap-3 text-body-sm text-ink">
                  <input
                    type="checkbox"
                    checked={chosen.has(i)}
                    onChange={() => setChosen((prev) => { const n = new Set(prev); if (n.has(i)) n.delete(i); else n.add(i); return n; })}
                    className="mt-1 size-4 accent-[var(--color-brand)]"
                  />
                  <span>
                    {q.text}
                    {refs(q)}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <button type="button" onClick={place} disabled={!chosen.size} className="mt-2 rounded-full bg-brand px-4 py-2 text-body-sm font-semibold text-brand-ink disabled:opacity-60">
            Put into the enquiry form
          </button>
          <p className="mt-1 text-label-sm text-ink-faint">{placed ? 'Added to the enquiry form — read it, then press Send there.' : 'You read and send it yourself; nothing is sent for you.'}</p>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-body-sm text-alert">{error}</p> : null}
    </div>
  );
}
