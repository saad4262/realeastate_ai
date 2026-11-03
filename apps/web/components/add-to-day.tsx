'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

/**
 * "Add to my day" on a listing's open-home times (ADR 0080, C6 decision 4) and the tray that follows. The choice is
 * kept in this browser only — a convenience, like a remembered tab: the plan itself lives in its link
 * (`/inspections?l=…&s=…`), and the server rebuilds it from the agents' times every time it opens.
 */
const KEY = 'inspection-day';
const EVENT = 'inspection-day-changed';
const MAX = 8;

type Day = Record<string, string>; // listingId → the chosen open time's id

function read(): Day {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as unknown;
    return raw && typeof raw === 'object' ? (raw as Day) : {};
  } catch {
    return {};
  }
}

function write(day: Day) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(day));
  } catch {
    // Private windows may refuse storage; the button simply does not remember.
  }
  window.dispatchEvent(new Event(EVENT));
}

function useDay(): Day {
  const [day, setDay] = useState<Day>({});
  useEffect(() => {
    const sync = () => setDay(read());
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return day;
}

export function AddToDay({ listingId, sessionId }: { listingId: string; sessionId: string }) {
  const day = useDay();
  const chosen = day[listingId] === sessionId;
  const full = !day[listingId] && Object.keys(day).length >= MAX;
  return (
    <button
      type="button"
      disabled={full}
      title={full ? `A day holds up to ${MAX} homes` : undefined}
      onClick={() => {
        const next = { ...read() };
        if (chosen) delete next[listingId];
        else next[listingId] = sessionId;
        write(next);
      }}
      className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${chosen ? 'bg-brand text-brand-ink' : 'border border-line bg-white text-ink'} disabled:opacity-50`}
      aria-pressed={chosen}
    >
      {chosen ? '✓ In my day' : '+ Add to my day'}
    </button>
  );
}

export function DayTray() {
  const day = useDay();
  const ids = Object.keys(day);
  if (!ids.length) return null;
  const href = `/inspections?${new URLSearchParams({ l: ids.join(','), s: Object.values(day).join(',') }).toString()}`;
  return (
    <div className="sticky bottom-4 z-10 mt-4 flex items-center justify-between gap-3 rounded-2xl bg-brand px-4 py-3 text-sm text-brand-ink">
      <span>
        <b>Your inspection day</b> · {ids.length} {ids.length === 1 ? 'home' : 'homes'}
      </span>
      <span className="flex items-center gap-3">
        <button type="button" onClick={() => write({})} className="text-xs underline opacity-80">
          Clear
        </button>
        <Link href={href} className="font-bold underline">
          See my day →
        </Link>
      </span>
    </div>
  );
}
