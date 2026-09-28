import { cache } from 'react';
import { ensureAppUser } from '@repo/core/identity';
import { getWebDb } from './db';
import { currentWebUser, type WebUser } from './session';

/**
 * Make sure this signed-in visitor has a row in `public.user`.
 *
 * ## Why this is not done in the auth callback
 *
 * The obvious home for it is `/auth/callback`, right after the code is traded
 * for a session. It cannot go there: the session cookies are set on the
 * *response* that redirect carries, so within that same request there is no
 * session to read the identity from. Doing it there would mean a second
 * `getUser()` against cookies that do not exist yet.
 *
 * So it happens on the first account page instead. `ensureAppUser` is an
 * idempotent upsert with `coalesce(excluded.x, user.x)` — a later sign-in
 * never wipes a profile — and `cache()` collapses it to once per request no
 * matter how many components ask.
 *
 * ## Why a consumer gets no membership
 *
 * Nothing here writes `membership`, and that is the decision in docs/adr/0011,
 * not an omission. A consumer is an actor with a userId and no agency;
 * `can()` denies them every agency action by shape. Giving them a membership
 * row would need a sentinel agency, and `public.user_agency_ids()` would then
 * hand them SELECT on eleven tables of other people's data.
 */
export const ensureConsumerAccount = cache(async (): Promise<WebUser | null> => {
  const user = await currentWebUser();
  if (!user) return null;

  await ensureAppUser(getWebDb(), {
    id: user.id,
    email: user.email ?? '',
    ...(user.label ? { name: user.label } : {}),
  });

  return user;
});
