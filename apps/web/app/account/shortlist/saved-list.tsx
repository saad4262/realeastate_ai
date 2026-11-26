'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { startTransition, useId, useOptimistic, useState, useTransition } from 'react';
import { ListingMedia } from '../../../components/listing-card';
import { Icon } from '../../../components/icons';
import { notify, undoRemove } from '../../../lib/saved-homes';
import { saveNote, setSaved } from '../../../lib/shortlist-action';

/** One saved home, every word and figure already formatted on the server (numbers come from SQL, § 4). */
export type SavedHome = {
  id: string;
  /** Null when the home is not advertised any more: its page is gone, the card stays for the note. */
  href: string | null;
  available: boolean;
  mainPhotoKey: string | null;
  street: string;
  locality: string;
  suburb: string;
  price: string | null;
  standing: string;
  beds: number | null;
  baths: number | null;
  cars: number | null;
  savedOn: string;
  priceChanged: string | null;
  note: string;
};

type Change = { kind: 'remove'; id: string } | { kind: 'note'; id: string; note: string };

const MAX_NOTE = 500;
/** No Tailwind preflight on this site (tailwind.css): a <button> keeps the browser's border, fill and font unless told. */
const BTN = 'cursor-pointer border-0 font-[inherit]';

/**
 * The saved homes, on the market first (ADR 0100). State is the server's list plus what the visitor just did,
 * through `useOptimistic`: a removal or a note shows at once, and when the action's re-render lands the list is
 * the server's again, so a failure puts the home back with nothing to roll back by hand.
 */
export function SavedList({
  homes,
  sortNav,
  planMax,
}: {
  homes: SavedHome[];
  sortNav: ReactNode;
  planMax: number;
}) {
  const [shown, change] = useOptimistic(homes, (list: SavedHome[], c: Change) =>
    c.kind === 'remove'
      ? list.filter((h) => h.id !== c.id)
      : list.map((h) => (h.id === c.id ? { ...h, note: c.note } : h)),
  );

  function remove(home: SavedHome) {
    startTransition(async () => {
      change({ kind: 'remove', id: home.id });
      const r = await setSaved(home.id, false);
      if (!r.ok) return notify({ tone: 'error', text: r.error });
      const removed = r.removed;
      notify({
        tone: 'done',
        text: `Removed ${home.street}`,
        action: removed
          ? { label: 'Undo', run: () => void undoRemove(home.id, removed) }
          : undefined,
      });
    });
  }

  function note(id: string, text: string) {
    return new Promise<boolean>((resolve) =>
      startTransition(async () => {
        change({ kind: 'note', id, note: text.replace(/\s+/g, ' ').trim() });
        const r = await saveNote(id, text);
        if (!r.ok) notify({ tone: 'error', text: r.error });
        resolve(r.ok);
      }),
    );
  }

  const market = shown.filter((h) => h.available);
  const gone = shown.filter((h) => !h.available);

  const count = (
    <div className="mt-1 flex flex-wrap items-center justify-between gap-sm">
      <p className="m-0 text-body-md text-ink-soft">
        {shown.length
          ? `${shown.length} ${shown.length === 1 ? 'home' : 'homes'} · only you can see this list`
          : 'Only you can see this list.'}
      </p>
      {/* ADR 0080 C6: the planner picks each home's open time and the day most of them are open. */}
      {market.length ? (
        <Link
          href={`/inspections?l=${market
            .slice(0, planMax)
            .map((h) => h.id)
            .join(',')}`}
          className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-4 py-2 text-label-md font-semibold text-ink transition hover:border-ink"
        >
          Plan inspections
        </Link>
      ) : null}
    </div>
  );

  if (!shown.length)
    return (
      <>
        {count}
        <Empty />
      </>
    );

  return (
    <>
      {count}
      {shown.length > 1 ? sortNav : null}
      {market.length ? (
        <Section title="On the market" homes={market} onRemove={remove} onNote={note} />
      ) : null}
      {gone.length ? (
        <Section
          title="No longer advertised"
          hint="Kept with your notes. Sold, leased or taken off the market."
          homes={gone}
          onRemove={remove}
          onNote={note}
        />
      ) : null}
    </>
  );
}

function Section(props: {
  title: string;
  hint?: string;
  homes: SavedHome[];
  onRemove: (h: SavedHome) => void;
  onNote: (id: string, note: string) => Promise<boolean>;
}) {
  return (
    <section className="mt-lg" aria-label={props.title}>
      <div className="mb-sm flex items-baseline gap-2">
        <h2 className="m-0 text-title-sm text-ink">{props.title}</h2>
        <span className="text-label-md text-ink-faint">{props.homes.length}</span>
      </div>
      {props.hint ? <p className="m-0 mb-sm text-body-sm text-ink-soft">{props.hint}</p> : null}
      <ul className="m-0 grid list-none gap-md p-0 sm:grid-cols-2">
        {props.homes.map((h) => (
          <li key={h.id}>
            <SavedCard
              home={h}
              onRemove={() => props.onRemove(h)}
              onNote={(n) => props.onNote(h.id, n)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function SavedCard({
  home,
  onRemove,
  onNote,
}: {
  home: SavedHome;
  onRemove: () => void;
  onNote: (note: string) => Promise<boolean>;
}) {
  const specs = [
    home.beds !== null ? { icon: 'bed' as const, value: home.beds, label: 'beds' } : null,
    home.baths !== null ? { icon: 'bath' as const, value: home.baths, label: 'baths' } : null,
    home.cars !== null ? { icon: 'car' as const, value: home.cars, label: 'car spaces' } : null,
  ].filter((s) => s !== null);

  return (
    <article className="relative flex h-full flex-col overflow-hidden rounded-lg border border-line-subtle bg-card shadow-card transition hover:border-line-strong hover:shadow-raised motion-reduce:transition-none">
      <ListingMedia
        listing={{
          id: home.id,
          mainPhotoKey: home.mainPhotoKey,
          address: home.street,
          suburb: home.suburb,
        }}
        className={`aspect-[16/10] w-full ${home.available ? '' : 'opacity-60 grayscale'}`}
        sizes="(max-width: 640px) 100vw, 480px"
      >
        <span
          className={`absolute left-sm top-sm rounded-sm px-2 py-1 text-label-sm uppercase ${home.available ? 'bg-brand text-brand-ink' : 'bg-ink/80 text-white'}`}
        >
          {home.standing}
        </span>
      </ListingMedia>

      {/* Above the card's link overlay, like every other control on it. */}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${home.street} from saved`}
        title="Remove from saved"
        className={`${BTN} absolute right-sm top-sm z-10 grid size-10 place-items-center rounded-full bg-card/95 text-brand shadow-card backdrop-blur-sm transition duration-200 ease-out hover:scale-110 active:scale-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand motion-reduce:transition-none motion-reduce:hover:scale-100`}
      >
        <svg
          viewBox="0 0 24 24"
          className="size-5"
          aria-hidden
          fill="currentColor"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinejoin="round"
        >
          <path d="M12 20s-7-4.4-9.2-9A4.8 4.8 0 0 1 12 6.6 4.8 4.8 0 0 1 21.2 11C19 15.6 12 20 12 20Z" />
        </svg>
      </button>

      <div className="flex flex-1 flex-col gap-1 p-md">
        {home.price ? (
          <p className="m-0 font-display text-headline-md text-ink">{home.price}</p>
        ) : null}
        <h3 className="m-0 text-body-lg font-semibold text-ink">
          {home.href ? (
            // The whole card opens the home, as a search result does; the address stays the one named link.
            <Link
              href={home.href}
              prefetch={false}
              className="text-ink after:absolute after:inset-0 hover:text-brand"
            >
              {home.street}
            </Link>
          ) : (
            home.street
          )}
        </h3>
        <p className="m-0 text-body-sm text-ink-soft">{home.locality}</p>

        {specs.length ? (
          <p className="m-0 mt-1 flex flex-wrap gap-x-md gap-y-1 text-body-sm text-ink">
            {specs.map((s) => (
              <span key={s.icon} className="flex items-center gap-1.5">
                <Icon name={s.icon} />
                {s.value}
                <span className="sr-only"> {s.label}</span>
              </span>
            ))}
          </p>
        ) : null}

        <p className="m-0 mt-1 flex flex-wrap items-center gap-x-sm gap-y-1 text-label-md text-ink-faint">
          <span>Saved {home.savedOn}</span>
          {home.priceChanged ? (
            <span className="rounded-sm bg-notice-soft px-1.5 py-0.5 text-notice">
              Price changed {home.priceChanged}
            </span>
          ) : null}
        </p>

        <NoteEditor note={home.note} street={home.street} onSave={onNote} />
      </div>
    </article>
  );
}

/** The private note: read, add or edit in place. Esc cancels; Ctrl or Cmd + Enter saves. */
function NoteEditor({
  note,
  street,
  onSave,
}: {
  note: string;
  street: string;
  onSave: (note: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note);
  const [pending, start] = useTransition();
  const field = useId();

  function open() {
    setDraft(note);
    setEditing(true);
  }

  function save() {
    if (draft.trim() === note) return setEditing(false);
    start(async () => {
      if (await onSave(draft)) setEditing(false);
    });
  }

  if (!editing) {
    return (
      <div className="relative z-10 mt-auto pt-sm">
        {note ? (
          <button
            type="button"
            onClick={open}
            className={`${BTN} w-full rounded-md bg-sunken px-sm py-2 text-left text-body-sm text-ink hover:bg-line-subtle" `}
            aria-label={`Edit your note on ${street}`}
          >
            <span className="block text-label-sm uppercase text-ink-faint">Your note</span>
            <span className="line-clamp-3 italic">“{note}”</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={open}
            className={`${BTN} flex items-center gap-1.5 rounded-md bg-transparent px-1 py-1 text-body-sm font-semibold text-brand hover:underline`}
          >
            <span aria-hidden>＋</span> Add a private note
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="relative z-10 mt-auto pt-sm">
      <label className="mb-1 block text-label-sm uppercase text-ink-faint" htmlFor={field}>
        Your note · only you can see it
      </label>
      <textarea
        id={field}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setEditing(false);
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
        }}
        maxLength={MAX_NOTE}
        rows={3}
        autoFocus
        placeholder="e.g. Big yard. Check the train noise at peak hour."
        className="w-full resize-y rounded-md border border-line bg-card font-[inherit] px-sm py-2 text-body-sm text-ink focus:border-brand focus:outline-none"
      />
      <div className="mt-1 flex items-center justify-between gap-sm">
        <span className="text-label-sm text-ink-faint" aria-live="polite">
          {draft.length}/{MAX_NOTE}
        </span>
        <span className="flex gap-1">
          <button
            type="button"
            onClick={() => setEditing(false)}
            className={`${BTN} rounded-full bg-transparent px-3 py-1.5 text-label-md font-semibold text-ink-soft hover:text-ink`}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={pending}
            className={`${BTN} rounded-full bg-brand px-3 py-1.5 text-label-md font-semibold text-brand-ink hover:bg-brand-deep disabled:cursor-default disabled:opacity-60`}
          >
            {pending ? 'Saving…' : 'Save note'}
          </button>
        </span>
      </div>
    </div>
  );
}

function Empty() {
  return (
    <div className="mt-lg grid justify-items-center gap-sm rounded-lg border border-dashed border-line bg-card px-md py-xl text-center">
      <span
        className="grid size-14 place-items-center rounded-full bg-brand-soft text-brand"
        aria-hidden
      >
        <svg
          viewBox="0 0 24 24"
          className="size-7"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinejoin="round"
        >
          <path d="M12 20s-7-4.4-9.2-9A4.8 4.8 0 0 1 12 6.6 4.8 4.8 0 0 1 21.2 11C19 15.6 12 20 12 20Z" />
        </svg>
      </span>
      <h2 className="m-0 text-title-sm text-ink">No saved homes yet</h2>
      <p className="m-0 max-w-[28rem] text-body-md text-ink-soft">
        Press the heart on any home to keep it here, with a private note. A price change shows on
        its card.
      </p>
      <div className="mt-sm flex flex-wrap justify-center gap-sm">
        <Link
          href="/"
          className="rounded-full bg-brand px-4 py-2 text-label-md font-semibold text-brand-ink hover:bg-brand-deep"
        >
          Find homes
        </Link>
        <Link
          href="/chat"
          prefetch={false}
          className="rounded-full border border-line px-4 py-2 text-label-md font-semibold text-ink hover:border-ink"
        >
          Ask the guide
        </Link>
      </div>
    </div>
  );
}
