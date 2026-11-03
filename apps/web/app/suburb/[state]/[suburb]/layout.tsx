import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { cachedSuburbProfile } from '../../../../lib/cached';

const STATES = new Set(['nsw', 'vic', 'qld', 'wa', 'sa', 'tas', 'act', 'nt']);

/**
 * The suburb page's gate (ADR 0080, C5). A layout, not the page: it sits outside this segment's loading boundary,
 * so a 404 is decided before anything streams — the page's own `notFound()` would arrive after a 200 had been sent.
 * A name we know nothing about (no census row, nothing listed or sold here) is a 404, so the site does not publish
 * an empty page for every string a crawler tries. The read is the page's own, cached, so it is not repeated.
 */
export default async function SuburbLayout({ children, params }: { children: ReactNode; params: Promise<{ state: string; suburb: string }> }) {
  const { state, suburb } = await params;
  if (!STATES.has(state.toLowerCase())) notFound();
  const p = await cachedSuburbProfile(state, decodeURIComponent(suburb).replace(/-/g, ' ').trim());
  if (p === null || (p !== 'down' && !p.census && p.forSale === 0 && p.forRent === 0 && p.salesInWindow === 0)) notFound();
  return children;
}
