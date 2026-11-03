import Link from 'next/link';
import type { Comparable } from '@repo/core/research';
import { pausedConsumerSkills } from '@repo/core/consumer-skills/catalog';
import { Card } from './listing-sections';
import { HideIfSkillOff } from './hide-if-skill-off';
import { ResearchAi } from './research-ai';

/**
 * Property Analyst on a listing (ADR 0080, C5 decision 5): comparable homes from SQL — same suburb, ±1 bedroom, sold
 * or for sale in the last 12 months — listed and never averaged, and the AI's cited explanation on a button. No value.
 */
export function ExplainHome({ listingId, comparables, suburbHref, suburb }: { listingId: string; comparables: Comparable[] | null; suburbHref: string; suburb: string }) {
  if (pausedConsumerSkills().has('property_analyst')) return null;
  return (
    <HideIfSkillOff skill="property_analyst">
      <Card eyebrow="Property Analyst" title="Explain this home" note="No estimated value: comparable homes are listed for you to weigh, never averaged into a price.">
        <div className="grid gap-md">
          <ResearchAi ask={{ kind: 'explain', listingId }} label="Explain this home with AI" />
          <section>
            <h3 className="mb-sm text-label-sm font-bold uppercase tracking-wide text-ink-soft">Comparable homes · this site, last 12 months</h3>
            {comparables === null ? (
              <p className="text-body-sm text-ink-soft">They could not be loaded just now.</p>
            ) : comparables.length === 0 ? (
              <p className="text-body-sm text-ink-soft">None on this site in {suburb} with a similar number of bedrooms.</p>
            ) : (
              <ul className="m-0 list-none p-0">
                {comparables.map((c) => (
                  <li key={c.listingId} className="flex justify-between gap-3 border-t border-line-subtle py-2 text-body-sm first:border-t-0">
                    <span className="text-ink">
                      {c.standing === 'for_sale' ? <Link href={`/listing/${c.listingId}`} className="hover:underline">{c.address}</Link> : c.address}
                      {c.bedrooms !== null ? ` · ${c.bedrooms} bed` : ''}
                      {c.landAreaSqm !== null ? ` · ${c.landAreaSqm} m²` : ''}
                    </span>
                    <span className="whitespace-nowrap text-ink-soft">{c.price}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-sm text-label-sm text-ink-faint">
              Same suburb, one bedroom either way. <Link href={suburbHref} className="underline">More about {suburb}</Link>
            </p>
          </section>
        </div>
      </Card>
    </HideIfSkillOff>
  );
}
