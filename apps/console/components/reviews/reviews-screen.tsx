import { agencyReviews } from '@repo/core/reviews';
import { GoogleReviews } from '@repo/ui/google-reviews';
import contactStyles from '@/components/contacts/contacts.module.css';
import { getConsoleDb } from '../../lib/db';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { PlacePicker } from './place-picker';

/**
 * The agency's Google rating and reviews (ADR 0028 step 1). Admins pick the
 * listing here; every member sees the same agency reviews. Fetched from
 * Google for this view and kept nowhere.
 */
export async function ReviewsScreen({ surface }: { surface: 'agency' | 'agent' }) {
  const session = await requireConsoleAccess(surface);
  const r = await agencyReviews(getConsoleDb(), session.actor);
  const picker = r.mayManage && surface === 'agency';
  return (
    <div className={contactStyles.wrap}>
      <div className={contactStyles.headText}>
        <h1 className={contactStyles.title}>{surface === 'agency' ? 'Google reviews' : 'Agency reviews'}</h1>
        <p className={contactStyles.sub}>
          The agency’s public Google rating and the few reviews Google makes public. They show on your live listings’ pages
          on the website. Reviews belong to the agency, never to one agent.
        </p>
      </div>
      <section className={contactStyles.card} style={{ padding: '1rem', display: 'grid', gap: '1rem' }}>
        {r.state === 'not_set' ? (
          picker ? (
            <>
              <p style={{ margin: 0 }}>Show your Google rating — find your agency’s Google listing.</p>
              <PlacePicker linked={false} />
            </>
          ) : (
            <p style={{ margin: 0 }}>Your agency hasn’t connected its Google reviews yet.</p>
          )
        ) : (
          <>
            {r.state === 'ok' ? (
              <GoogleReviews data={{ agencyName: r.agencyName, place: r.place }} />
            ) : r.state === 'not_found' ? (
              <p role="alert" style={{ margin: 0 }}>
                Google no longer has the listing that was picked{picker ? ' — find it again below.' : '. An owner or admin needs to pick it again.'}
              </p>
            ) : (
              <p role="alert" style={{ margin: 0 }}>Google didn’t answer just now, so nothing is shown (public pages hide the section too). Try again in a minute.</p>
            )}
            {picker ? <PlacePicker linked /> : null}
            <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
              Picked on {r.pickedAt.toLocaleDateString('en-AU')}. Linking a review to a contact comes with step 2 (Google Business
              Profile), because Google’s terms don’t allow us to keep these reviews.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
