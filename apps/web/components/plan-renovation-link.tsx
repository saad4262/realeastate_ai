import Link from 'next/link';
import { pausedConsumerSkills } from '@repo/core/consumer-skills/catalog';
import { Card } from './listing-sections';
import { HideIfSkillOff } from './hide-if-skill-off';

/**
 * "Planning a renovation?" on a listing for sale (ADR 0080, C3 decision 6): a way into the Renovation page with
 * the listing carried over, so the plan gets the state's permit notes and can read the photos. No figure here.
 * Cached page, no session: the buyer's switch is honoured in the browser, the platform pause at render.
 */
export function PlanRenovationLink({ listingId, channel }: { listingId: string; channel: string }) {
  if (channel !== 'sale' || pausedConsumerSkills().has('renovation')) return null;
  return (
    <HideIfSkillOff skill="renovation">
      <Card eyebrow="Renovation AI" title="Planning a renovation?" note="What is involved, what drives the cost, the trades and permits — and your quotes compared. No prices from us.">
        <Link href={`/renovation?listing=${listingId}`} className="inline-block rounded-full border border-line px-4 py-2 text-body-sm font-semibold text-ink hover:border-ink">
          Plan a renovation for this home
        </Link>
      </Card>
    </HideIfSkillOff>
  );
}
