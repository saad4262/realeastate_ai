import { opportunityQuery, type OpportunityAsk, type Opportunities } from './find';
import { SIGNAL_TEXT, signalLine, signalNote, type SignalKind } from './signals';

/**
 * Opportunity AI in the guide (ADR 0080, C7 decision 9): each home's signals as our own lines, with what a signal can
 * mean and the questions to ask — the same words the page shows. The guide copies them; it never judges a price.
 */
export type OpportunityToolResult = {
  area: string;
  homes: { listingId: string; address: string; price: string; signals: { kind: SignalKind; label: string; facts: string; note: string; meaning: string; askTheAgent: string[] }[]; page: string }[];
  counts: Record<SignalKind, number>;
  notShown: string[];
  page: string;
  rules: string;
};

const RULES =
  "Copy each signal's facts exactly, then its meaning and the questions to ask the agent. These are facts from the portal's records, not a judgement: never call a home a bargain, under-priced, good value or a good deal, never say the seller is motivated or keen, and never guess what it is worth or will sell for.";

/** Pure. */
export function opportunityToolResult(o: Opportunities, ask: OpportunityAsk): OpportunityToolResult {
  return {
    area: o.area,
    homes: o.homes.slice(0, 10).map((h) => ({
      listingId: h.listingId,
      address: h.address,
      price: h.price,
      signals: h.signals.map((s) => ({ kind: s.kind, label: SIGNAL_TEXT[s.kind].label, facts: signalLine(s), note: signalNote(s, o.medianDaysOnMarket), meaning: SIGNAL_TEXT[s.kind].meaning, askTheAgent: [...SIGNAL_TEXT[s.kind].questions] })),
      page: `/listing/${h.listingId}`,
    })),
    counts: o.counts,
    notShown: Object.values(o.emptyWhy),
    page: `/opportunities?${opportunityQuery(ask)}`,
    rules: RULES,
  };
}
