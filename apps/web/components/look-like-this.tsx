import Link from 'next/link';
import { pausedConsumerSkills } from '@repo/core/consumer-skills/catalog';
import { HideIfSkillOff } from './hide-if-skill-off';

/**
 * Visual Search's door on a listing (ADR 0080, C9 decision 9): "more like this photo" for the listing's own main photo.
 * A link only — /look decides, and says when it is still filling up. Nothing when there is no photo.
 */
export function LookLikeThis({ photoId }: { photoId: string | null }) {
  if (!photoId || pausedConsumerSkills().has('visual_search')) return null;
  return (
    <HideIfSkillOff skill="visual_search">
      <p className="m-0 text-body-sm text-ink-soft">
        <Link href={`/look?photo=${photoId}`} className="text-brand underline underline-offset-2 hover:text-brand-deep">
          Homes that look like this photo
        </Link>{' '}
        · Search by look
      </p>
    </HideIfSkillOff>
  );
}
