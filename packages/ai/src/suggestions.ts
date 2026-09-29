import { priceBoundLabel, type PublicSearchQuery } from '@repo/core/listings';
import type { ChatSuggestion, ChatSuggestionKind } from './schemas/chat-events';
import type { SchedulingContext, TurnFacts } from './tools/context';

/**
 * The chips under an answer, decided by the server.
 *
 * ## Why this is not a prompt rule
 *
 * The guide already asks one question after every search — the prompt has
 * said so since v2. What it cannot do is name a suburb it has not searched or
 * quote a price it has not been handed, and "there are cheaper ones in Officer"
 * is exactly the sentence a model will produce from nothing if asked to be
 * helpful. So the offer is built here instead, from what the server actually
 * did this turn, and the model is never told these chips exist.
 *
 * That buys three things a prompt rule does not:
 *
 *   - **No extra model round.** A chip costs nothing to produce. Asking the
 *     guide to go and check the neighbouring suburbs would spend one of the
 *     three tool rounds and one more billed call, on every single search.
 *   - **No cache churn.** v8 is frozen behind two cache breakpoints. Nothing
 *     here touches the prompt, so nothing here invalidates the prefix.
 *   - **Testable.** A pure function of facts, so `pnpm test` can pin the
 *     behaviour rather than hoping a model keeps agreeing to it.
 *
 * ## The one rule everything here obeys
 *
 * Every number in a label was either copied from the query the server just
 * ran, or is a `priceLabel` string Postgres produced. Nothing in this file
 * computes, rounds or estimates a figure (#4). There is deliberately no
 * arithmetic below — not even "budget + 10%", which was the obvious chip and
 * is the exact thing the rule forbids.
 */

/**
 * Three, and the cap is the point.
 *
 * Pressing a chip posts a message, which is a full billed turn. Six plausible
 * chips is a menu that costs money to browse; three is a next step. Order in
 * `buildSuggestions` is therefore priority order, not display order — the tail
 * is dropped, so the most useful offer has to be written first.
 */
export const MAX_SUGGESTIONS = 3;

/**
 * How far to offer to look when a named suburb came back empty.
 *
 * Ten kilometres rather than the 5 km `DEFAULT_RADIUS_KM` gives a locality:
 * the default is what "near Pakenham" means when somebody is browsing, and
 * this is the answer to "Pakenham has nothing", where the suburb itself has
 * already been ruled out. It is a constant, not a calculation.
 */
export const WIDEN_RADIUS_KM = 10;

export type SuggestionInput = {
  /** What the tools established this turn. */
  facts: TurnFacts;
  /** The brief as it stands after this turn — the same slots the client echoes. */
  slots: PublicSearchQuery;
  scheduling: SchedulingContext['state'];
  /** A confirmation card is already on screen. Do not offer a second one. */
  scheduleOffered: boolean;
  /** The turn ended in an error frame. */
  failed: boolean;
};

/**
 * The filter most likely to be the reason nothing matched.
 *
 * Ordered by how often each one silently empties a search in this codebase,
 * worst first. `keywords` reaches a LIKE over four columns and ANDs the result
 * down to nothing; `propertyType` is the documented footgun the v8 prompt
 * spends a whole section on, because an agency that typed "Residential" into
 * that field disappears from a search for "House".
 *
 * One is offered, never a list. A visitor who is told four things might be
 * wrong has learned nothing about which.
 */
function loosenable(
  slots: PublicSearchQuery,
): { label: string; send: string } | null {
  const rental = slots.channel === 'rent';

  if (slots.text) {
    return {
      label: `Drop “${slots.text}”`,
      send: `Search again without the “${slots.text}” keyword.`,
    };
  }
  if (slots.propertyType) {
    return {
      label: 'Any property type',
      send: 'Search again without limiting the property type.',
    };
  }
  if (slots.priceTo !== undefined) {
    return {
      // The figure is the visitor's own ceiling, echoed back — not a new one.
      label: `Above ${priceBoundLabel(slots.priceTo, rental)}`,
      send: 'Search again without my budget limit, so I can see what is there.',
    };
  }
  if (slots.bedrooms !== undefined) {
    return {
      label: 'Any bedrooms',
      send: 'Search again without the bedroom minimum.',
    };
  }
  return null;
}

/** "for sale" / "for rent", or nothing when the channel is still unknown. */
function channelPhrase(slots: PublicSearchQuery): string {
  if (slots.channel === 'sale') return ' for sale';
  if (slots.channel === 'rent') return ' for rent';
  return '';
}

export function buildSuggestions(input: SuggestionInput): ChatSuggestion[] {
  const out: ChatSuggestion[] = [];

  /**
   * A failed turn gets none.
   *
   * Chips under "the connection dropped" read as a menu of things that might
   * work, and none of them would: the same request is about to fail again.
   */
  if (input.failed) return out;

  const seen = new Set<ChatSuggestionKind>();
  const push = (s: ChatSuggestion) => {
    if (out.length >= MAX_SUGGESTIONS || seen.has(s.kind)) return;
    seen.add(s.kind);
    out.push(s);
  };

  const { facts, slots } = input;
  const search = facts.search;
  const matched = search?.matched ?? null;

  /**
   * 1. A cheaper suburb next door, named and priced by Postgres.
   *
   * The whole reason this file exists. `facts.nearby` arrives cheapest-first
   * from `order by min(price) asc`, so the first row that is not the suburb
   * they are already looking at is the cheaper alternative — found, not
   * chosen here.
   */
  const centre = facts.nearbyCentre?.trim().toLowerCase();
  const cheaper = (facts.nearby ?? []).find(
    (s) => s.suburb.trim().toLowerCase() !== centre,
  );
  if (cheaper) {
    push({
      kind: 'nearby_cheaper',
      label: `${cheaper.suburb} — from ${cheaper.cheapest}`,
      send: `Show me what is${channelPhrase(slots)} in ${cheaper.suburb}.`,
    });
  }

  /**
   * 2. The suburb was empty and nobody has looked around it yet.
   *
   * Only when no radius was applied. Offering to widen a search that already
   * had one would re-run the same empty query with the same answer.
   */
  if (matched === 0 && search?.suburb && search.radiusKm === undefined) {
    push({
      kind: 'widen_radius',
      label: `Within ${WIDEN_RADIUS_KM} km`,
      send: `Search within ${WIDEN_RADIUS_KM} km of ${search.suburb}.`,
    });
  }

  /** 3. Nothing matched, and one filter they gave is the likely reason. */
  if (matched === 0) {
    const drop = loosenable(slots);
    if (drop) push({ kind: 'drop_filter', ...drop });
  }

  /**
   * 4. Listings that carry no price and so were ranked nowhere.
   *
   * Worth a chip precisely because they are invisible in a cheapest-first
   * answer: without this the market looks smaller than it is.
   */
  if (facts.unpriced && facts.unpriced > 0) {
    push({
      kind: 'unpriced',
      label: `${facts.unpriced} without a price`,
      send: 'Tell me about the nearby ones that do not list a price.',
    });
  }

  /**
   * 5. More than one match and nobody has asked which is cheapest.
   *
   * Suppressed once the brief is already sorted that way — the answer above
   * the chip has just led with it.
   */
  if (matched !== null && matched > 1 && slots.sort !== 'price_asc') {
    push({
      kind: 'cheapest_first',
      label: 'Cheapest first',
      send: 'Which of these is the cheapest?',
    });
  }

  /**
   * 6. Keep it running.
   *
   * `unconfigured` is excluded and `signed_out` is NOT: a signed-out visitor
   * who presses this is told to sign in, which is a ten-second fix they can
   * act on — the distinction `SchedulingContext` was split apart to preserve.
   * Offering it to somebody the server cannot serve at all is the one case
   * that reads as a broken product.
   *
   * Last, so it never displaces an offer about the listings on screen.
   */
  const searchable = Boolean(slots.channel && slots.suburb);
  if (searchable && !input.scheduleOffered && input.scheduling !== 'unconfigured') {
    push({
      kind: 'schedule',
      label: 'Email me new ones',
      send: 'Email me new listings for this search every day.',
    });
  }

  return out;
}
