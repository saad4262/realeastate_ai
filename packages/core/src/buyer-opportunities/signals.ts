import { MEDIAN_MIN_SALES, MEDIAN_WINDOW_MONTHS } from '../research/suburb';

/**
 * Opportunity AI's signals and their words (ADR 0080, C7 decisions 5, 6 and 8; mock docs/mocks/consumer-discovery.html
 * #opportunities). Pure. Every figure arrives from SQL — the difference, the days, the median and its count — and every
 * sentence here is ours: what a signal can and cannot mean, and two questions to ask the agent. No model writes any of
 * it, and none of it is a verdict on a home's value (a test bans the words).
 */

export const SIGNAL_KINDS = ['price_reduced', 'long_campaign', 'below_median'] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

/** A campaign this long or longer is shown (decision 5). Today's median on this site was 42 days when it was set. */
export const LONG_CAMPAIGN_DAYS = 60;
/** The median needs this many sales of the same kind and bedrooms in the suburb in the window — C5's rule. */
export { MEDIAN_MIN_SALES, MEDIAN_WINDOW_MONTHS };
/** Price changes were first recorded when migration 0082 was applied. */
export const PRICE_CHANGES_SINCE = '3 Nov 2026';
export const MAX_OPPORTUNITIES = 30;
export const MAX_SUBURBS = 8;
/** What the database hands over before the page chooses; the counts say when there were more. */
export const OPPORTUNITY_CANDIDATES = 300;

export type Signal =
  | { kind: 'price_reduced'; on: Date; fromText: string; toText: string; lowerBy: number }
  | { kind: 'long_campaign'; days: number; since: Date }
  | { kind: 'below_median'; askingFrom: number; median: number; sales: number; bedrooms: number; propertyType: string; suburb: string };

export const SIGNAL_TEXT: Record<SignalKind, { label: string; filter: string; meaning: string; questions: [string, string] }> = {
  price_reduced: {
    label: 'Price reduced',
    filter: 'Price reduced',
    meaning: "A lower asking price tells you the advertised figure moved. It doesn't tell you why, or what the seller will accept.",
    questions: ['Has there been an offer, and was it declined?', 'Is the seller working to a set date, such as a settlement they need to meet?'],
  },
  long_campaign: {
    label: 'On the market a long time',
    filter: `On the market ${LONG_CAMPAIGN_DAYS}+ days`,
    meaning: "A long campaign can follow a price set above what buyers offered, a quiet season, or something about the home. The records can't tell which.",
    questions: ['What feedback has come from inspections?', 'Have any offers been made, and how close were they to the asking price?'],
  },
  below_median: {
    label: "Asking below this site's median",
    filter: "Asking below this site's median",
    meaning: "A median is the middle of many different homes. Land size, condition and street all differ, so being below it says nothing about this home's value.",
    questions: ['How did the agent arrive at the price guide? Ask for the comparable sales.', 'Is there anything about the home or the land that the price reflects?'],
  },
};

/** Words that pass judgement on a home, its price or its seller. Never in our text or the guide's prompt (decision 6). */
export const BANNED_WORDS = [/\bbargains?\b/i, /\bunder-?valued\b/i, /\bunder-?priced\b/i, /\bsteals?\b/i, /\bmotivated\b/i, /\bdesperate\b/i, /\bgood deal\b/i, /\bgreat deal\b/i, /\bgreat value\b/i, /\bgood value\b/i, /\bsnap (it )?up\b/i, /\bwon'?t last\b/i] as const;

/** The judgement words in a text, if any. Pure; the tests run it over every sentence we wrote. */
export function judgementWords(text: string): string[] {
  return BANNED_WORDS.flatMap((re) => {
    const m = text.match(re);
    return m ? [m[0]] : [];
  });
}

const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
export const DAY = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Sydney' });

const plural = (type: string) => (/(s|sh|ch|x)$/.test(type) ? `${type}es` : `${type}s`);

/** The signal's one line of facts, every figure as SQL returned it. Pure. */
export function signalLine(s: Signal): string {
  switch (s.kind) {
    case 'price_reduced':
      return `On ${DAY.format(s.on)}, from ${s.fromText} to ${s.toText}: ${AUD.format(s.lowerBy)} lower.`;
    case 'long_campaign':
      return `${s.days} days on the market in this campaign, since ${DAY.format(s.since)}.`;
    case 'below_median':
      return `Asking from ${AUD.format(s.askingFrom)}. ${s.bedrooms}-bedroom ${plural(s.propertyType.toLowerCase())} sold on this site in ${s.suburb}, last ${MEDIAN_WINDOW_MONTHS} months: median ${AUD.format(s.median)} (${s.sales} sales).`;
  }
}

/** The small print under a signal's line. Pure. */
export function signalNote(s: Signal, medianDaysOnMarket: number | null): string {
  switch (s.kind) {
    case 'price_reduced':
      return `Price changes recorded on this site since ${PRICE_CHANGES_SINCE}.`;
    case 'long_campaign':
      return medianDaysOnMarket === null ? 'Counted from the day this campaign was published.' : `The median for homes for sale on this site today is ${medianDaysOnMarket} days.`;
    case 'below_median':
      return "Median computed by Postgres from this site's sales only.";
  }
}

/** Why a signal has no homes in the area — said, not left blank (decision 8). Pure. */
export function emptyReason(kind: SignalKind, area: string, mostSalesInAGroup: number): string {
  switch (kind) {
    case 'price_reduced':
      return `Price changes are recorded from ${PRICE_CHANGES_SINCE}. None in ${area} yet.`;
    case 'long_campaign':
      return `No home for sale in ${area} has been on the market ${LONG_CAMPAIGN_DAYS} days or more in its current campaign.`;
    case 'below_median':
      return mostSalesInAGroup >= MEDIAN_MIN_SALES
        ? `No home for sale in ${area} is asking below this site's median for its suburb, kind and bedrooms.`
        : `Needs ${MEDIAN_MIN_SALES} sales of homes of the same kind and bedrooms in one suburb in ${MEDIAN_WINDOW_MONTHS} months. The most on this site in ${area}: ${mostSalesInAGroup}.`;
  }
}
