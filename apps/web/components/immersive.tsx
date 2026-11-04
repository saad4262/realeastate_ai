import Image from 'next/image';
import { PROVIDER_NAME, ROOM_LABEL, type ListingExtras } from '@repo/core/media';
import { pausedConsumerSkills } from '@repo/core/consumer-skills/catalog';
import { Card } from './listing-sections';
import { HideIfSkillOff } from './hide-if-skill-off';
import { ClickToPlay } from './click-to-play';

/**
 * Immersive Property AI on a listing (ADR 0080, C9 decisions 2–3; mock docs/mocks/consumer-media-land.html#immersive):
 * the agent's floorplans, video and 3D tour as they published them, and the floorplan's rooms by name — read by AI,
 * never a size. Nothing renders when the listing has none.
 */
export function Immersive({ extras }: { extras: ListingExtras | null }) {
  if (!extras || pausedConsumerSkills().has('immersive')) return null;
  const { floorplans, videos, tours } = extras;
  if (!floorplans.length && !videos.length && !tours.length) return null;
  const rooms = [...new Set(floorplans.flatMap((f) => f.rooms ?? []))];
  return (
    <HideIfSkillOff skill="immersive">
      <Card id="floorplan" eyebrow="Immersive Property AI" title="Floorplan, video and tour" note="As published by the agent.">
        <div className="grid gap-md sm:grid-cols-2">
          {floorplans.map((f, i) => (
            <a key={f.id} href={f.url} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-lg border border-line-subtle bg-white">
              <span className="relative block aspect-[4/3] w-full">
                <Image src={f.url} alt={`Floorplan ${floorplans.length > 1 ? i + 1 : ''}`.trim()} fill sizes="(min-width: 640px) 50vw, 100vw" className="object-contain" />
              </span>
              <span className="block px-3 py-2 text-label-sm text-ink-soft">Floorplan · open full size</span>
            </a>
          ))}
          {videos.map((v) => (
            <ClickToPlay key={v.mediaId} src={v.embed} title={`Video · ${PROVIDER_NAME[v.provider]}`} label="▶ Play the video" provider={PROVIDER_NAME[v.provider]} />
          ))}
          {tours.map((t) => (
            <ClickToPlay key={t.mediaId} src={t.embed} title={`3D tour · ${PROVIDER_NAME[t.provider]}`} label="⟲ Start the 3D tour" provider={PROVIDER_NAME[t.provider]} />
          ))}
        </div>
        {rooms.length ? (
          <div className="mt-md">
            <h3 className="mb-1 text-label-sm font-bold uppercase tracking-wide text-ink-soft">Rooms on the floorplan</h3>
            <p className="m-0 text-body-md text-ink">{rooms.map((r) => ROOM_LABEL[r]).join(' · ')}</p>
            <p className="mt-1 text-label-sm text-ink-faint">Read from the floorplan by AI, room names only. For sizes, see the floorplan itself — we don&rsquo;t read or estimate dimensions.</p>
          </div>
        ) : null}
      </Card>
    </HideIfSkillOff>
  );
}
