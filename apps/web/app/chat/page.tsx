import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { toClientSlots } from '@repo/ai/chat-request';
import type { ResultsEvent } from '@repo/ai/chat-events';
import { priceLabel } from '@repo/core/listings/format';
import type { PublicListingSummary } from '@repo/core/listings';
import { describeSavedQuery, savedQueryToPath, savedSearchQuerySchema } from '@repo/core/listings/url';
import { getThread, listThreads, type StoredTurn } from '@repo/core/chat';
import { listRunsForUser } from '@repo/core/schedules';
import { WebShell } from '../../components/web-shell';
import { ChatView, type DeliveredRunSeed } from './chat-view';
import { cachedFilterOptions } from '../../lib/cached';
import { getWebDb } from '../../lib/db';
import { currentWebUser } from '../../lib/session';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Ask the guide — Property Platform',
  description:
    'Tell the AI property guide what you need — suburb, budget, or where to look — and search live listings in conversation.',
};

/**
 * The conversational way into the same search.
 *
 * The cached read is shared with the home and search pages, so it is one call
 * and almost always warm. Only the first suburb crosses to the client, though:
 * all it does is write a placeholder a visitor can copy, and shipping every
 * live suburb to pick one of them put the whole list in this page's payload.
 */
export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ alert?: string; thread?: string; history?: string }>;
}) {
  const [{ suburbs }, params] = await Promise.all([cachedFilterOptions(), searchParams]);
  const showHistory = params.history === '1';

  const [delivered, user] = await Promise.all([
    params.alert && !showHistory ? loadDeliveredRun(params.alert) : Promise.resolve(null),
    currentWebUser(),
  ]);

  /**
   * The thread list and the reopened thread, started together (§ 5).
   *
   * Both are skipped entirely for an anonymous visitor: `/chat` is public,
   * and a conversation is only ever stored when there is somebody to store
   * it for. History does not need the open thread — it is a list.
   */
  const db = getWebDb();
  const actor = user ? { userId: user.id } : null;

  const [threads, opened] = actor
    ? await Promise.all([
        listThreads(db, actor),
        !showHistory && params.thread ? getThread(db, actor, params.thread) : Promise.resolve(null),
      ])
    : [[], null];

  // A thread id that is not this person's reads as missing, not as refused.
  if (!showHistory && params.thread && !opened) notFound();

  const restored = opened ? reopenFrom(opened.turns) : { results: null, slots: null };

  return (
    // `/chat` is inside the middleware matcher, so this is the verified
    // session rather than a cookie sniff.
    <WebShell wide account={{ signedIn: Boolean(user) }}>
      {/*
        Remount when the open conversation changes.

        ChatView keeps its transcript in useState. A client navigation from
        /chat to /chat?thread=… delivers new props to the same instance, and
        useState ignores them — so a past chat changed the URL and left the
        hero on screen. The key is what makes opening one actually open it.
      */}
      <ChatView
        key={showHistory ? 'history' : (opened?.thread.id ?? 'new')}
        exampleSuburb={suburbs[0] ?? null}
        delivered={delivered}
        signedIn={Boolean(user)}
        historyOpen={showHistory}
        activeTitle={opened?.thread.title ?? null}
        initialThreadId={opened?.thread.id ?? null}
        initialSlots={restored.slots}
        initialResults={restored.results}
        initialTurns={
          opened?.turns.map((turn) => ({
            role: turn.role,
            text: turn.text,
            ...(turn.searches ? { searches: turn.searches as never } : {}),
            ...(turn.resultsFrame ? { results: turn.resultsFrame as never } : {}),
            ...(turn.deepLink ? { stateLink: turn.deepLink } : {}),
          })) ?? []
        }
        threads={threads.map((thread) => ({
          id: thread.id,
          title: thread.title,
          lastMessageAt: thread.lastMessageAt.toISOString(),
        }))}
      />
    </WebShell>
  );
}

/**
 * The last search a reopened thread ran, for the sidebar and the next turn.
 *
 * `resultsFrame` is display data the live stream already sent to the browser.
 * Slots are the client-safe brief only — `toClientSlots` drops the radius
 * centre, which must not be echoed back on the next message.
 */
function reopenFrom(turns: StoredTurn[]): {
  results: ResultsEvent | null;
  slots: ReturnType<typeof toClientSlots> | null;
} {
  for (let i = turns.length - 1; i >= 0; i--) {
    const frame = turns[i]?.resultsFrame;
    if (!frame || typeof frame !== 'object') continue;
    const event = frame as ResultsEvent;
    if (event.type !== 'results' || !event.query || !Array.isArray(event.listings)) continue;
    const slots = toClientSlots(event.query);
    return { results: event, slots: Object.keys(slots).length > 0 ? slots : null };
  }
  return { results: null, slots: null };
}

/**
 * A scheduled run, if this visitor owns it.
 *
 * `/chat` is inside the middleware matcher, so there is a verified session
 * here — unlike `/search`. Ownership is decided by `can()` inside
 * `listRunsForUser`, and an id belonging to somebody else simply is not in
 * the list, so it 404s rather than rendering an empty card. A card that says
 * "nothing here" for another person's run still confirms the run exists.
 */
async function loadDeliveredRun(runId: string): Promise<DeliveredRunSeed | null> {
  const user = await currentWebUser();
  if (!user) return null;

  const runs = await listRunsForUser(getWebDb(), { userId: user.id }, { limit: 50 });
  const run = runs.find((r) => r.id === runId);
  if (!run) notFound();

  const query = savedSearchQuerySchema.safeParse(run.query);
  if (!query.success) notFound();

  const listings = (run.listings ?? []) as unknown as PublicListingSummary[];

  return {
    ranAtIso: new Date(run.createdAt).toISOString(),
    scheduleName: describeSavedQuery(query.data),
    description: describeSavedQuery(query.data),
    matched: run.matched ?? 0,
    newCount: run.newCount ?? 0,
    summary: run.summary,
    summarySource: run.summarySource,
    searchPath: savedQueryToPath(query.data),
    // Formatted on the server: priceLabel lives beside the database types and
    // the client may not import the listings barrel (it pulls postgres.js).
    listings: listings.slice(0, 4).map((listing) => ({
      id: listing.id,
      price: priceLabel(listing),
      address: `${listing.address}, ${listing.suburb}`,
    })),
    prompt: describeSavedQuery(query.data),
  };
}
