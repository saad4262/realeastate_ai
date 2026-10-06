import { NextResponse, type NextRequest } from 'next/server';
import { browserHost, completeConnect, consoleUrl, returnHop, tokenKeysFromEnv, type Surface } from '@repo/core/integrations';
import { getConsoleDb } from '../../../../../lib/db';
import { loadActor } from '../../../../../lib/load-actor';
import { actionUserId } from '../../../../../lib/auth-account';

/**
 * The one OAuth redirect URI (docs/adr/0020).
 *
 * 1. On the wrong host (dev: Google sends people to localhost, which has no
 *    session), hand over — to the console host the SIGNED state names, from
 *    the environment, never from the URL — and do nothing else.
 * 2. On the right host: who is signed in, is it the person who started this,
 *    exchange, re-check the scopes, store. Back to their Integrations page.
 */
export const dynamic = 'force-dynamic';

function settingsPath(surface: Surface): string {
  return surface === 'agency' ? '/settings/integrations' : '/my-integrations';
}

export async function GET(request: NextRequest) {
  const keys = tokenKeysFromEnv();
  const query = request.nextUrl.searchParams;
  const fallback = request.headers.get('x-console-surface') === 'agency' ? 'agency' : 'agent';
  if (!keys) {
    return NextResponse.redirect(`${consoleUrl(fallback)}${settingsPath(fallback)}?error=${encodeURIComponent('Integrations are not set up on this server (INTEGRATION_TOKEN_KEY).')}`);
  }

  // The browser's host, not request.nextUrl: under next dev that is always localhost.
  const hop = returnHop(browserHost(request.headers), query, keys);
  if (hop) return NextResponse.redirect(hop);

  const userId = await actionUserId();
  const actor = userId ? await loadActor(userId) : null;
  const outcome = await completeConnect(getConsoleDb(), keys, actor, query);
  const surface = outcome.surface ?? fallback;
  const dest = new URL(`${consoleUrl(surface)}${settingsPath(surface)}`);
  if (outcome.ok) {
    dest.searchParams.set('connected', outcome.provider);
    if (outcome.status === 'permission_missing') dest.searchParams.set('missing', outcome.missingScopes.join(' '));
  } else {
    dest.searchParams.set('error', outcome.error);
  }
  return NextResponse.redirect(dest.toString());
}
