'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { forgetEverything, resetField, setProfileField } from './actions';

/** Turn what the buyer typed into the field's value; null when it does not read. Strict like core's schema. */
function parse(field: string, raw: string): unknown {
  const t = raw.trim();
  if (field === 'suburbs' || field === 'propertyTypes') {
    const list = t.split(',').map((x) => x.trim()).filter(Boolean);
    return list.length ? list : null;
  }
  if (field === 'channel') return /^rent/i.test(t) ? 'rent' : /^(buy|sale)/i.test(t) ? 'sale' : null;
  const n = Number(t.replace(/[$,\s]/g, ''));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

const HINT: Record<string, string> = { suburbs: 'Pakenham, Officer', channel: 'buying or renting', priceTo: '800000', bedrooms: '3', propertyTypes: 'House, Townhouse' };

/** One fact: its value and source, Edit, Remove, and "Go back to learnt" when the buyer set it. */
export function FactRow(props: { field: string; label: string; shown: string | null; raw: string; source: string | null; byYou: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(props.raw);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const act = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        setEditing(false);
        router.refresh();
      } else setError(r.error ?? 'That did not save.');
    });

  return (
    <li className="border-t border-line-subtle py-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-ink">
          <b>{props.label}</b> — {props.shown ?? <i className="text-ink-soft">nothing yet</i>}
        </p>
        <span className="text-xs text-ink-soft">
          {props.source ?? ''}
          {' · '}
          <button type="button" onClick={() => setEditing(!editing)} className="underline">
            Edit
          </button>
          {props.shown ? (
            <>
              {' · '}
              <button type="button" disabled={pending} onClick={() => act(() => setProfileField(props.field, null))} className="underline">
                Remove
              </button>
            </>
          ) : null}
          {props.byYou ? (
            <>
              {' · '}
              <button type="button" disabled={pending} onClick={() => act(() => resetField(props.field))} className="underline">
                Go back to learnt
              </button>
            </>
          ) : null}
        </span>
      </div>
      {editing ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={HINT[props.field]} className="min-w-0 flex-1 rounded-lg border border-line px-2 py-1 text-sm" />
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              const v = parse(props.field, value);
              if (v === null) return setError(`Try something like “${HINT[props.field]}”.`);
              act(() => setProfileField(props.field, v));
            }}
            className="rounded-full bg-brand px-3 py-1 text-xs font-semibold text-brand-ink"
          >
            Save
          </button>
        </div>
      ) : null}
      {error ? <p role="alert" className="mt-1 text-xs text-alert">{error}</p> : null}
    </li>
  );
}

/** Forget everything, after one confirmation. */
export function ForgetButton() {
  const router = useRouter();
  const [sure, setSure] = useState(false);
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  if (done) return <p className="text-sm text-ink">Forgotten. The profile starts again from what you do next.</p>;
  return sure ? (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-ink">Forget everything the guide has learnt?</span>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await forgetEverything();
            if (r.ok) {
              setDone(true);
              router.refresh();
            }
          })
        }
        className="rounded-full border border-alert bg-alert px-3 py-1 text-xs font-semibold text-white"
      >
        Yes, forget it
      </button>
      <button type="button" onClick={() => setSure(false)} className="text-xs underline">
        Cancel
      </button>
    </span>
  ) : (
    <button type="button" onClick={() => setSure(true)} className="rounded-full border border-alert px-4 py-2 text-sm font-semibold text-alert">
      Forget everything
    </button>
  );
}
