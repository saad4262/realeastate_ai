'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { saveNotes } from '../actions';

type Mark = 'fine' | 'issue' | 'unchecked';
type Entry = { mark: Mark; note?: string };
const MARKS: { mark: Mark; label: string; on: string }[] = [
  { mark: 'fine', label: 'Looks fine', on: 'bg-success-soft text-success font-bold' },
  { mark: 'issue', label: 'Issue', on: 'bg-danger-soft text-danger font-bold' },
  { mark: 'unchecked', label: 'Didn’t check', on: 'bg-sunken text-ink font-bold' },
];

/**
 * The checklist and the notes (C6 decision 7): fixed items from core, the buyer's marks and words. Saved on the
 * button; core's strict schema checks every key and length.
 */
export function NotebookForm({ listingId, items, initialChecks, initialNotes, maxNotes, maxCheckNote, disabled }: { listingId: string; items: { key: string; group: string; label: string }[]; initialChecks: Record<string, Entry>; initialNotes: string; maxNotes: number; maxCheckNote: number; disabled: boolean }) {
  const router = useRouter();
  const [checks, setChecks] = useState<Record<string, Entry>>(initialChecks);
  const [notes, setNotes] = useState(initialNotes);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const groups = [...new Set(items.map((i) => i.group))];

  const set = (key: string, patch: Partial<Entry>) => {
    setStatus(null);
    setChecks((c) => {
      const next: Entry = { mark: c[key]?.mark ?? 'unchecked', ...(c[key]?.note ? { note: c[key]!.note } : {}), ...patch };
      if (!next.note?.trim()) delete next.note;
      return { ...c, [key]: next };
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await saveNotes(listingId, { checks, notes });
          setStatus(r.ok ? { ok: true, text: 'Saved.' } : { ok: false, text: r.error });
          if (r.ok) router.refresh();
        });
      }}
    >
      {groups.map((g) => (
        <fieldset key={g} className="m-0 mb-4 border-0 p-0" disabled={disabled}>
          <legend className="mb-1 text-xs font-bold uppercase tracking-wider text-ink-soft">{g}</legend>
          {items
            .filter((i) => i.group === g)
            .map((i) => {
              const mark = checks[i.key]?.mark ?? 'unchecked';
              return (
                <div key={i.key} className="border-t border-line-subtle py-2 first:border-t-0">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="text-ink">{i.label}</span>
                    <span className="inline-flex overflow-hidden rounded-full border border-line" role="radiogroup" aria-label={i.label}>
                      {MARKS.map((m) => (
                        <button key={m.mark} type="button" role="radio" aria-checked={mark === m.mark} onClick={() => set(i.key, { mark: m.mark })} className={`border-l border-line px-2 py-0.5 text-[11.5px] first:border-l-0 ${mark === m.mark ? m.on : 'text-ink-soft'}`}>
                          {m.label}
                        </button>
                      ))}
                    </span>
                  </div>
                  {mark === 'issue' || checks[i.key]?.note ? (
                    <input
                      type="text"
                      value={checks[i.key]?.note ?? ''}
                      maxLength={maxCheckNote}
                      placeholder="What you saw (optional)"
                      onChange={(e) => set(i.key, { note: e.target.value })}
                      className="mt-1 w-full rounded-lg border border-line px-2 py-1 text-sm"
                    />
                  ) : null}
                </div>
              );
            })}
        </fieldset>
      ))}
      <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-ink-soft" htmlFor="notes">
        Your notes
      </label>
      <textarea id="notes" value={notes} maxLength={maxNotes} disabled={disabled} onChange={(e) => (setStatus(null), setNotes(e.target.value))} rows={5} className="w-full rounded-xl border border-line px-3 py-2 text-sm" placeholder="What the agent said, what to ask, what you liked…" />
      <div className="mt-2 flex items-center gap-3">
        <button type="submit" disabled={pending || disabled} className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-brand-ink disabled:opacity-60">
          {pending ? 'Saving…' : 'Save notes'}
        </button>
        {status ? <span className={`text-sm ${status.ok ? 'text-success' : 'text-alert'}`}>{status.text}</span> : null}
      </div>
    </form>
  );
}
