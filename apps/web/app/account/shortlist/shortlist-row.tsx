'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { saveNote, setSaved } from '../../../lib/shortlist-action';

/** One saved home: its private note (edited in place) and Remove. A client island only for those two actions. */
export function ShortlistRow(props: {
  listingId: string;
  href: string | null;
  photo: string | null;
  title: string;
  price: string | null;
  standing: string;
  specs: string;
  priceChanged: string | null;
  note: string;
}) {
  const [note, setNote] = useState(props.note);
  const [editing, setEditing] = useState(false);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (gone) return null;

  const title = props.href ? (
    <Link href={props.href} className="font-semibold text-ink hover:underline">
      {props.title}
    </Link>
  ) : (
    <span className="font-semibold text-ink">{props.title}</span>
  );

  return (
    <li className="grid grid-cols-[5.5rem_1fr] gap-3 border-t border-line-subtle p-4 first:border-t-0 sm:grid-cols-[6rem_1fr_auto]">
      {/* eslint-disable-next-line @next/next/no-img-element -- a storage URL; the listing cards use the same */}
      {props.photo ? <img src={props.photo} alt="" className="h-16 w-full rounded-lg object-cover sm:h-[4.4rem]" /> : <span className="h-16 rounded-lg bg-sunken sm:h-[4.4rem]" />}
      <div className="min-w-0">
        {title}
        <p className="text-sm text-ink">
          {props.price ? <b>{props.price}</b> : null} <span className="text-ink-soft">{props.price ? '· ' : ''}{props.standing}</span>
        </p>
        {props.specs ? <p className="text-xs text-ink-soft">{props.specs}</p> : null}
        {props.priceChanged ? <p className="text-xs text-notice">Price changed on {props.priceChanged}</p> : null}
        {editing ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className="min-w-0 flex-1 rounded-lg border border-line px-2 py-1 text-sm" autoFocus />
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await saveNote(props.listingId, note);
                  if (r.ok) setEditing(false);
                  else setError(r.error);
                })
              }
              className="rounded-full bg-brand px-3 py-1 text-xs font-semibold text-brand-ink"
            >
              Save note
            </button>
          </div>
        ) : (
          <p className="mt-1 text-sm">
            {note ? <i className="text-ink">“{note}”</i> : null}{' '}
            <button type="button" onClick={() => setEditing(true)} className="text-xs text-ink-soft underline">
              {note ? 'Edit note' : 'Add a note'}
            </button>
          </p>
        )}
        {error ? <p role="alert" className="text-xs text-alert">{error}</p> : null}
      </div>
      <div className="col-span-2 sm:col-span-1">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await setSaved(props.listingId, false);
              if (r.ok) setGone(true);
              else setError(r.error);
            })
          }
          className="rounded-full border border-alert px-3 py-1 text-xs font-semibold text-alert"
        >
          ♥ Remove
        </button>
      </div>
    </li>
  );
}
