'use client';

import Link from 'next/link';
import { useState } from 'react';

/** Choose 2–4 saved homes still advertised and open them side by side (ADR 0080, C5 decision 4). */
export function CompareChooser({ homes }: { homes: { id: string; title: string }[] }) {
  const [chosen, setChosen] = useState<string[]>(homes.slice(0, 2).map((h) => h.id));
  if (homes.length < 2) return null;
  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length >= 4 ? c : [...c, id]));
  return (
    <section className="mb-4 rounded-2xl border border-line bg-card p-4">
      <p className="text-sm font-semibold text-ink">Compare homes side by side</p>
      <ul className="m-0 mt-2 grid list-none gap-1 p-0 sm:grid-cols-2">
        {homes.map((h) => (
          <li key={h.id}>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={chosen.includes(h.id)} onChange={() => toggle(h.id)} className="size-4 accent-[var(--color-brand)]" />
              {h.title}
            </label>
          </li>
        ))}
      </ul>
      <p className="mt-3">
        {chosen.length >= 2 ? (
          <Link href={`/compare?ids=${chosen.join(',')}`} className="inline-block rounded-full bg-brand px-4 py-2 text-sm font-semibold text-brand-ink">
            Compare {chosen.length} homes
          </Link>
        ) : (
          <span className="text-sm text-ink-soft">Choose two to four.</span>
        )}
      </p>
    </section>
  );
}
