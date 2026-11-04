/**
 * Agent AI's draft rules (ADR 0080, C8 decision 2), checked by code — the model is told them, core enforces them. A
 * draft may use only the buyer's own words from this conversation and the listing's facts. Rejected, for the plain
 * template instead: an offer or a price the buyer will pay; a claim to act for the buyer; a figure (a sum, a number, a
 * time) found in neither source; money matters (finance, a budget, a deposit) the buyer did not raise; contact details
 * (those come from the account, never the model). Pure.
 */

export const MAX_MESSAGE_CHARS = 1500;
export const MIN_MESSAGE_CHARS = 20;

export type DraftSources = { buyerWords: string; listingFacts: readonly string[] };
export type DraftCheck = { ok: true } | { ok: false; reasons: string[] };

const OFFER = /\b(?:(?:we|i)(?:'d|’d| would| will| can| could| are| am)?\s+(?:like to |love to |be (?:happy|willing|prepared) to |happy to |willing to |prepared to )?(?:offer|pay|bid)\b|happy to pay|willing to pay|prepared to pay|our offer|my offer|an offer of|offer of \$)/i;
const ON_BEHALF = /\b(?:on behalf of|my client|our client|as (?:his|her|their|the buyer['’]?s?|[a-z]+['’]s) (?:buyer['’]?s? )?(?:agent|advocate|representative|lawyer|solicitor|conveyancer|broker))\b/i;
const MONEY = /\b(?:pre-?approv\w*|finance|financing|loan|mortgage|budget|deposit|cash buyer|borrow\w*)\b/gi;
const CONTACT = /[\w.+-]+@[\w-]+\.[\w.]+|\b(?:\+?61|0)[2-478](?:[ -]?\d){8}\b/;

/** Digit groups in a text — "$720,000" → "720000", "10:15 am" → "1015". */
function digitTokens(text: string): string[] {
  return [...text.matchAll(/\d[\d,.:]*/g)].map((m) => m[0].replace(/[^\d]/g, '')).filter(Boolean);
}

export function checkAgentDraft(text: string, sources: DraftSources): DraftCheck {
  const reasons: string[] = [];
  const t = text.trim();
  if (t.length < MIN_MESSAGE_CHARS || t.length > MAX_MESSAGE_CHARS) reasons.push('length');
  if (OFFER.test(t)) reasons.push('offer');
  if (ON_BEHALF.test(t)) reasons.push('acts for the buyer');
  if (CONTACT.test(t)) reasons.push('contact details');
  const said = sources.buyerWords.toLowerCase();
  for (const m of t.matchAll(MONEY)) if (!said.includes(m[0].toLowerCase().replace(/s$/, ''))) reasons.push(`money: ${m[0]}`);
  // A numbered list's markers ("1." at a line's start) are layout, not figures.
  const body = t.replace(/^\s*\d{1,2}[.)]\s/gm, '');
  const known = new Set([...digitTokens(sources.buyerWords), ...sources.listingFacts.flatMap(digitTokens)]);
  for (const d of digitTokens(body)) if (!known.has(d)) reasons.push(`figure: ${d}`);
  return reasons.length ? { ok: false, reasons: [...new Set(reasons)] } : { ok: true };
}

/** The plain message used when a draft fails (or there is no model): the buyer's own words, framed. Pure. */
export function templateMessage(address: string, buyerWords: string): string {
  const words = buyerWords.trim().replace(/\s+\n/g, '\n').slice(0, 1000);
  return `Hi,\n\nI'm interested in ${address}.${words ? `\n\n${words}` : ''}\n\nThanks`;
}
