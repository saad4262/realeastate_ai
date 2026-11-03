'use client';

import { useEffect, useState } from 'react';

/**
 * The checklist with ticks (ADR 0080, C2 decision 7): remembered in this browser only, per address. A
 * per-viewer convenience, so browser storage — read and written inside try/catch, because a private window
 * or blocked storage must still render the list, just without memory.
 */
export function ChecklistTicks({ scope, items }: { scope: string; items: readonly { id: string; title: string; detail: string }[] }) {
  const key = `before-you-buy:${scope}`;
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) setTicked(new Set(JSON.parse(raw) as string[]));
    } catch {
      // No storage: the list still works, it just forgets.
    }
  }, [key]);

  function toggle(id: string) {
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        window.localStorage.setItem(key, JSON.stringify([...next]));
      } catch {
        // As above.
      }
      return next;
    });
  }

  return (
    <ul className="m-0 list-none p-0">
      {items.map((item) => (
        <li key={item.id} className="border-t border-line-subtle py-2.5 first:border-t-0 first:pt-0">
          <label className="grid cursor-pointer grid-cols-[1.25rem_1fr] gap-3">
            <input type="checkbox" checked={ticked.has(item.id)} onChange={() => toggle(item.id)} className="mt-1 size-4 accent-[var(--color-brand)]" />
            <span>
              <span className={`block text-body-sm font-semibold ${ticked.has(item.id) ? 'text-ink-soft line-through' : 'text-ink'}`}>{item.title}</span>
              <span className="block text-body-sm text-ink-soft">{item.detail}</span>
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}
