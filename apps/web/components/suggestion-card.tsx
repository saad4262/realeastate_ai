import Link from 'next/link';
import type { Suggestion } from '@repo/core/discovery';
import { kmText } from '@repo/core/discovery';
import type { ReactNode } from 'react';

/** One Discovery AI suggestion: what it matches (green), its one difference (amber), and its distance when known. */
export function SuggestionCard({ home, footer }: { home: Suggestion; footer?: ReactNode }) {
  const facts = [home.bedrooms !== null ? `${home.bedrooms} bed` : null, home.bathrooms !== null ? `${home.bathrooms} bath` : null, home.propertyType].filter(Boolean).join(' · ');
  return (
    <article className="flex flex-col gap-1.5 rounded-xl border border-line bg-card p-4">
      <p className="m-0 font-semibold text-ink">{home.price}</p>
      <Link href={`/listing/${home.listingId}`} className="text-body-sm text-ink hover:underline">
        {home.address}
      </Link>
      {facts ? <p className="m-0 text-label-sm text-ink-soft">{facts}</p> : null}
      <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
        {home.matches.map((m) => (
          <li key={m} className="rounded-full bg-success-soft px-2 py-0.5 text-[11.5px] text-success">
            {m}
          </li>
        ))}
        {home.differenceText ? <li className="rounded-full bg-notice-soft px-2 py-0.5 text-[11.5px] text-notice">{home.differenceText}</li> : null}
      </ul>
      <div className="mt-auto flex items-center justify-between gap-2 pt-1 text-label-sm text-ink-soft">
        <span>{home.metres !== null && home.difference?.kind !== 'nearby' && home.metres > 0 ? kmText(home.metres) : ''}</span>
        {footer ?? (
          <Link href={`/listing/${home.listingId}`} className="underline">
            View
          </Link>
        )}
      </div>
    </article>
  );
}
