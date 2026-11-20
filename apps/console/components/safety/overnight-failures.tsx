import Link from 'next/link';
import type { Actor } from '@repo/core/permissions';
import { overnightFailures } from '@repo/core/safety/overnight';
import { getConsoleDb } from '../../lib/db';

/**
 * PLATFORM-PLAN 3.7: last night's failures, on the agency's Overview. Owners and admins (core decides); nothing
 * drawn when nothing failed. Every number is a count from SQL, each with the page to look at it on.
 */
export async function OvernightFailures({ actor }: { actor: Actor }) {
  const night = await overnightFailures(getConsoleDb(), actor);
  if (!night?.lines.length) return null;
  const since = new Intl.DateTimeFormat('en-AU', { weekday: 'long', hour: 'numeric', minute: '2-digit', timeZone: night.timeZone }).format(night.since);
  return (
    <section
      aria-labelledby="overnight-heading"
      style={{ border: '1px solid var(--rose, #be123c)', borderRadius: '0.75rem', padding: '1rem', margin: '0 0 1rem', background: 'var(--surface-card)' }}
    >
      <h2 id="overnight-heading" style={{ margin: '0 0 0.25rem', fontSize: '1rem' }}>
        Since {since}: what did not go through
      </h2>
      <p style={{ margin: '0 0 0.75rem', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
        Nothing is sent again on its own. Open each one to see why and decide.
      </p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.375rem' }}>
        {night.lines.map((l) => (
          <li key={l.kind}>
            <Link href={l.href}>{l.words}</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
