import { asOfText, zoneLabel, type LandAndZoning } from '@repo/core/development';
import { pausedConsumerSkills } from '@repo/core/consumer-skills/catalog';
import { landLabel } from '@repo/core/listings/format';
import { Card } from './listing-sections';
import { HideIfSkillOff } from './hide-if-skill-off';
import { cachedLandAndZoning } from '../lib/cached';

/**
 * Property Development AI (ADR 0080, C9 decisions 4–7; mock docs/mocks/consumer-media-land.html#development): the
 * zone from the state's own data, the land size from the ad, where the overlays are, and the questions to ask. Facts
 * and questions only — no model writes here, and nothing says what may be built. On the listing and /property pages,
 * which have shown the property is public. Async behind the page's <Suspense>: a slow state service never holds the
 * page (ARCHITECTURE "Stream the second round trip").
 */
export async function LandAndZoningSection({ propertyId, listingId }: { propertyId: string; listingId: string | null }) {
  if (pausedConsumerSkills().has('development')) return null;
  const panel = await cachedLandAndZoning(propertyId, listingId);
  if (!panel) return null;
  return <LandAndZoningCard panel={panel} />;
}

function OfficialLink({ link }: { link: { label: string; url: string } }) {
  return (
    <a href={link.url} target="_blank" rel="noopener noreferrer" className="text-brand underline underline-offset-2 hover:text-brand-deep">
      {link.label}
    </a>
  );
}

export function LandAndZoningCard({ panel }: { panel: LandAndZoning }) {
  const z = panel.zoning;
  const land = landLabel(panel.landAreaSqm);
  const council = z.status === 'found' ? z.zones.find((x) => x.council)?.council : null;
  return (
    <HideIfSkillOff skill="development">
      <Card id="land" eyebrow="Property Development AI" title="Land and zoning" note="From the state's planning data. Facts, not advice.">
        <dl className="m-0 grid gap-x-md gap-y-2 text-body-md sm:grid-cols-[8rem_1fr]">
          <dt className="text-label-sm font-bold uppercase tracking-wide text-ink-soft">Zone</dt>
          <dd className="m-0 text-ink">
            {z.status === 'found' ? (
              z.zones.map((x) => <span key={x.code} className="block">{zoneLabel(x)}</span>)
            ) : z.status === 'not_verified' ? (
              <span>
                <span className="font-bold">Not verified.</span> {z.why}
                {z.map ? (
                  <>
                    {' '}Open <OfficialLink link={z.map} /> for this address.
                  </>
                ) : null}
              </span>
            ) : z.status === 'none_here' ? (
              <span>The state&rsquo;s zone layer shows no zone at this point. Check the official map.</span>
            ) : z.status === 'no_point' ? (
              <span>This address has no map point yet, so no zone is looked up.</span>
            ) : (
              <span>The state&rsquo;s zoning service did not answer just now. Try again later.</span>
            )}
          </dd>
          {z.status === 'found' && z.zones.length > 1 ? (
            <dd className="m-0 text-label-sm text-ink-faint sm:col-start-2">This point is on a boundary between zones. Check the official map for the exact line.</dd>
          ) : null}
          {council ? (
            <>
              <dt className="text-label-sm font-bold uppercase tracking-wide text-ink-soft">Council</dt>
              <dd className="m-0 text-ink">{council}</dd>
            </>
          ) : null}
          <dt className="text-label-sm font-bold uppercase tracking-wide text-ink-soft">Land size</dt>
          <dd className="m-0 text-ink">{land ? `${land} (from the listing)` : 'Not given in the listing'}</dd>
        </dl>

        <p className="mt-md text-label-sm text-ink-faint">
          {z.status === 'found' || z.status === 'none_here' ? (
            <>
              Zone from {z.source.name} ({z.source.licence}), {asOfText(z)}.{' '}
            </>
          ) : null}
          {panel.overlays ? (
            <>
              Overlays may also apply: see <OfficialLink link={panel.overlays} />.
            </>
          ) : null}
        </p>

        <p className="mt-md rounded-lg border-l-4 border-info bg-info-soft px-3 py-2 text-body-sm text-ink">{panel.notAPermission}</p>

        <h3 className="mb-sm mt-md text-label-sm font-bold uppercase tracking-wide text-ink-soft">Questions to ask before you develop</h3>
        <ul className="m-0 grid list-disc gap-1 pl-5 text-body-sm text-ink">
          {panel.questions.map((q) => (
            <li key={q}>{q}</li>
          ))}
        </ul>
      </Card>
    </HideIfSkillOff>
  );
}
