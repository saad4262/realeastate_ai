import Link from 'next/link';
import type { Suggestion } from '@repo/core/discovery';
import { pausedConsumerSkills } from '@repo/core/consumer-skills/catalog';
import { Card } from './listing-sections';
import { HideIfSkillOff } from './hide-if-skill-off';
import { SuggestionCard } from './suggestion-card';

/**
 * Discovery AI on a listing (ADR 0080, C7 decisions 1–2; mock docs/mocks/consumer-discovery.html#similar): homes for
 * sale like this one by its suburb, kind, bedrooms and price, each saying what it matches and its one difference. The
 * same list for every visitor — nothing about them is used.
 */
export function SimilarHomes({ homes }: { homes: Suggestion[] | null }) {
  if (pausedConsumerSkills().has('discovery') || !homes?.length) return null;
  return (
    <HideIfSkillOff skill="discovery">
      <div id="similar">
        <Card eyebrow="Discovery AI" title="Similar homes" note="Chosen by suburb, kind, bedrooms and price, from this home's own details. Distances are straight lines.">
          <div className="grid gap-md sm:grid-cols-2 xl:grid-cols-3">
            {homes.map((h) => (
              <SuggestionCard key={h.listingId} home={h} />
            ))}
          </div>
          <p className="mt-sm text-label-sm text-ink-faint">
            On this site now. A home under offer, a draft or a home not for sale is never shown here. <Link href="/account/for-you" className="underline">Suggestions from your profile</Link>
          </p>
        </Card>
      </div>
    </HideIfSkillOff>
  );
}
